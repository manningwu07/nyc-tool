import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, evaluatePlan, nextDeparture, optionsFrom } from './engine';
import { bandOf, serviceDayAt, fmtDur } from './time';
import type { Network, Plan, ServiceBand } from './types';

const FULL: ServiceBand[] = Array.from({ length: 5 }, () => ({
  runs: true, headwaySec: 600, trips: 10,
}));
const DAYTIME_ONLY: ServiceBand[] = FULL.map((b, i) =>
  i === 0 ? { runs: false, headwaySec: null, trips: 0 } : b);

// Tiny 5-station fixture: A--B--C--D--E on the "L" local,
// plus an "X" express A--C--E (skips B, D), daytime only.
const fixture: Network = {
  generatedAt: '', bands: [], serviceDays: ['Weekday', 'Saturday', 'Sunday'],
  stations: ['A', 'B', 'C', 'D', 'E'].map((id, i) => ({
    id, name: `Sta ${id}`, borough: 'M', complexId: id,
    lat: 40.7 + i * 0.01, lon: -74, gtfsStopIds: [id], routes: ['L'],
    countsTowardRecord: id !== 'E', // E is our "SIR" stand-in
  })),
  patterns: [
    {
      id: 'L-S-000', routeId: 'L', direction: 'S', label: 'L local',
      stations: ['A', 'B', 'C', 'D', 'E'],
      hops: [
        { Weekday: [100, 100, 100, 100, 100] },
        { Weekday: [120, 120, 120, 120, 120] },
        { Weekday: [80, 80, 80, 80, 80] },
        { Weekday: [90, 90, 90, 90, 90] },
      ],
      service: { Weekday: FULL }, tripCount: 100, shapeId: null,
    },
    {
      id: 'X-S-000', routeId: 'X', direction: 'S', label: 'X express',
      stations: ['A', 'C', 'E'],
      hops: [{ Weekday: [150, 150, 150, 150, 150] }, { Weekday: [110, 110, 110, 110, 110] }],
      service: { Weekday: DAYTIME_ONLY }, tripCount: 50, shapeId: null,
    },
    {
      // sparse branch line with real timetable data for schedule mode:
      // hourly-ish departures at A, last one 23:30 (plus a 25:10 overnight
      // trip that GTFS files under the same service day)
      id: 'R-S-000', routeId: 'R', direction: 'S', label: 'R sparse',
      stations: ['A', 'B'],
      hops: [{ Weekday: [200, 200, 200, 200, 200] }],
      service: {
        Weekday: Array.from({ length: 5 }, () => ({
          runs: true, headwaySec: 3600, trips: 2,
        })),
      },
      departures: {
        Weekday: [
          [12 * 60, 13 * 60 + 15, 14 * 60 + 40, 23 * 60 + 30, 25 * 60 + 10],
          [12 * 60 + 4, 13 * 60 + 19, 14 * 60 + 44, 23 * 60 + 34, 25 * 60 + 14],
        ],
      },
      tripCount: 5, shapeId: null,
    },
  ],
  transfers: [
    { from: 'A', to: 'A', kind: 'in_system', sec: 180, notes: '' },
    { from: 'C', to: 'C', kind: 'in_system', sec: 120, notes: '' },
    { from: 'B', to: 'D', kind: 'walk', sec: 300, notes: 'street walk' },
  ],
  routes: [], shapes: {},
};

const idx = buildIndex(fixture);

function plan(partial: Partial<Plan>): Plan {
  return {
    id: 'p', name: 'test', startStationId: 'A', startClockSec: 12 * 3600,
    serviceDay: 'Weekday', legs: [], contingencies: {},
    config: { passThroughCounts: false, walkPaceMultiplier: 0.8 },
    ...partial,
  };
}

describe('time helpers', () => {
  it('bands', () => {
    expect(bandOf(3 * 3600)).toBe(0);
    expect(bandOf(7 * 3600)).toBe(1);
    expect(bandOf(25 * 3600)).toBe(0); // GTFS 25:00 = 1am overnight
    expect(bandOf(23 * 3600)).toBe(4);
  });
  it('service day rollover at 6am', () => {
    expect(serviceDayAt('Saturday', 23 * 3600)).toBe('Saturday');
    expect(serviceDayAt('Saturday', 28 * 3600)).toBe('Saturday'); // 4am still Sat service
    expect(serviceDayAt('Saturday', 31 * 3600)).toBe('Sunday'); // 7am next day
  });
  it('formats durations', () => {
    expect(fmtDur(3661)).toBe('1:01:01');
    expect(fmtDur(95)).toBe('1:35');
  });
});

describe('ride legs', () => {
  it('times a simple local ride with half-headway wait', () => {
    const res = evaluatePlan(idx, plan({
      legs: [{ id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'D', wait: 'half' }],
    }));
    const leg = res.legs[0];
    expect(leg.errors).toEqual([]);
    expect(leg.waitSec).toBe(300); // 600/2
    expect(leg.moveSec).toBe(300); // 100+120+80
    expect(res.coveredCount).toBe(4); // A,B,C,D
    expect(res.elapsedSec).toBe(600);
  });

  it('defaults to a timed (zero) boarding wait', () => {
    const res = evaluatePlan(idx, plan({
      legs: [{ id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'D' }],
    }));
    const leg = res.legs[0];
    expect(leg.waitSec).toBe(0);
    expect(leg.riskSec).toBe(600); // full headway still surfaced as the miss cost
    expect(res.elapsedSec).toBe(300); // ride only, no wait
  });

  it('honors wait overrides', () => {
    const res = evaluatePlan(idx, plan({
      legs: [{ id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'B', wait: 'zero' }],
    }));
    expect(res.legs[0].waitSec).toBe(0);
  });

  it('flags a pattern that does not run overnight', () => {
    const res = evaluatePlan(idx, plan({
      startClockSec: 2 * 3600,
      legs: [{ id: '1', type: 'ride', patternId: 'X-S-000', boardStationId: 'A', alightStationId: 'E' }],
    }));
    expect(res.legs[0].errors[0]).toMatch(/does not run in the overnight band/);
  });

  it('express does not cover skipped stations unless passThroughCounts', () => {
    const base = plan({
      legs: [{ id: '1', type: 'ride', patternId: 'X-S-000', boardStationId: 'A', alightStationId: 'E' }],
    });
    const strict = evaluatePlan(idx, base);
    expect(strict.covered.sort()).toEqual(['A', 'C']); // E doesn't count toward record
    const loose = evaluatePlan(idx, {
      ...base, config: { ...base.config, passThroughCounts: true },
    });
    expect(loose.covered.sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('applies same-station transfer time between consecutive rides', () => {
    const res = evaluatePlan(idx, plan({
      legs: [
        { id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'C' },
        { id: '2', type: 'ride', patternId: 'X-S-000', boardStationId: 'C', alightStationId: 'E' },
      ],
    }));
    expect(res.legs[1].transferSec).toBe(120);
  });

  it('errors but keeps timing when no transfer edge exists', () => {
    const res = evaluatePlan(idx, plan({
      legs: [
        { id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'C' },
        { id: '2', type: 'ride', patternId: 'L-S-000', boardStationId: 'D', alightStationId: 'E' },
      ],
    }));
    expect(res.legs[1].errors[0]).toMatch(/no transfer edge/);
    expect(res.legs[1].transferSec).toBeGreaterThan(0);
  });
});

describe('walk legs', () => {
  it('times walks at the default 10 min/mi pace', () => {
    const res = evaluatePlan(idx, plan({
      legs: [
        { id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'B' },
        { id: '2', type: 'walk', fromStationId: 'B', toStationId: 'D' },
      ],
    }));
    // edge 300s at the 1.4 m/s base = 420 street meters; at 10 min/mi:
    // 420 / 1609.34 * 600 ≈ 157s
    expect(res.legs[1].moveSec).toBe(157);
    expect(res.covered).toContain('D');
  });

  it('per-leg pace override re-times the walk from its street distance', () => {
    const res = evaluatePlan(idx, plan({
      legs: [
        { id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'B' },
        { id: '2', type: 'walk', fromStationId: 'B', toStationId: 'D', paceMinPerMi: 20 },
      ],
    }));
    expect(res.legs[1].moveSec).toBe(313); // 420m at 20 min/mi
  });

  it('user-entered walk time is used verbatim and beats everything', () => {
    const res = evaluatePlan(idx, plan({
      legs: [
        { id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'B' },
        { id: '2', type: 'walk', fromStationId: 'B', toStationId: 'D', sec: 100, paceMinPerMi: 20 },
      ],
    }));
    expect(res.legs[1].moveSec).toBe(100); // no multiplier, no pace scaling
  });
});

describe('smart options', () => {
  it('hides patterns not running at the current time', () => {
    const noon = optionsFrom(idx, 'A', 'Weekday', 12 * 3600);
    expect(noon.rides.map((r) => r.pattern.id).sort()).toEqual(['L-S-000', 'R-S-000', 'X-S-000']);
    const night = optionsFrom(idx, 'A', 'Weekday', 3 * 3600);
    expect(night.rides.map((r) => r.pattern.id)).toEqual(['L-S-000', 'R-S-000']);
  });
});

describe('schedule mode (hybrid)', () => {
  const sched = (partial: Partial<Plan>) => plan({
    ...partial,
    config: { passThroughCounts: false, walkPaceMultiplier: 0.8, scheduleMode: true },
  });

  it('keeps ½-headway waits for dense service', () => {
    const res = evaluatePlan(idx, sched({
      legs: [{ id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'B' }],
    }));
    expect(res.legs[0].waitSec).toBe(300); // L headway 600 ≤ 720 cutoff
    expect(res.legs[0].scheduledDepSec).toBeUndefined();
  });

  it('snaps sparse service to the next real departure', () => {
    // arrive 12:30; next R departure at A is 13:15
    const res = evaluatePlan(idx, sched({
      startClockSec: 12.5 * 3600,
      legs: [{ id: '1', type: 'ride', patternId: 'R-S-000', boardStationId: 'A', alightStationId: 'B' }],
    }));
    expect(res.legs[0].waitSec).toBe(45 * 60);
    expect(res.legs[0].scheduledDepSec).toBe(13 * 3600 + 15 * 60);
    expect(res.legs[0].riskSec).toBe(3600); // headway risk survives schedule mode
    expect(res.legs[0].errors).toEqual([]);
  });

  it('finds the 24:xx+ overnight trip of the same service day', () => {
    // arrive 24:30 (past midnight): the 25:10 trip is still this service day
    const res = evaluatePlan(idx, sched({
      startClockSec: 24.5 * 3600,
      legs: [{ id: '1', type: 'ride', patternId: 'R-S-000', boardStationId: 'A', alightStationId: 'B' }],
    }));
    expect(res.legs[0].scheduledDepSec).toBe(25 * 3600 + 10 * 60);
    expect(res.legs[0].waitSec).toBe(40 * 60);
  });

  it('hard-errors when the last train is missed', () => {
    // arrive 25:30, after the final 25:10 departure; next service day's noon
    // train is past the 6am boundary, so the runner is stranded
    const res = evaluatePlan(idx, sched({
      startClockSec: 25.5 * 3600,
      legs: [{ id: '1', type: 'ride', patternId: 'R-S-000', boardStationId: 'A', alightStationId: 'B' }],
    }));
    expect(res.legs[0].errors[0]).toMatch(/stranded — last train missed/);
    expect(res.errorCount).toBeGreaterThan(0);
  });

  it('respects a configurable cutoff', () => {
    // raising the cutoff to 2h makes the hourly R count as "dense", so it
    // stays statistical instead of snapping to the timetable
    const res = evaluatePlan(idx, plan({
      config: {
        passThroughCounts: false, walkPaceMultiplier: 0.8,
        scheduleMode: true, scheduleHeadwayCutoffSec: 7200,
      },
      startClockSec: 12.5 * 3600,
      legs: [{ id: '1', type: 'ride', patternId: 'R-S-000', boardStationId: 'A', alightStationId: 'B' }],
    }));
    expect(res.legs[0].scheduledDepSec).toBeUndefined(); // 3600 ≤ 7200 → statistical
    expect(res.legs[0].waitSec).toBe(1800);
  });

  it('explicit numeric leg wait beats the schedule', () => {
    const res = evaluatePlan(idx, sched({
      startClockSec: 12.5 * 3600,
      legs: [{ id: '1', type: 'ride', patternId: 'R-S-000', boardStationId: 'A', alightStationId: 'B', wait: 60 }],
    }));
    expect(res.legs[0].waitSec).toBe(60);
    expect(res.legs[0].scheduledDepSec).toBeUndefined();
  });

  it('falls back to ½ headway when the network has no departure data', () => {
    const res = evaluatePlan(idx, sched({
      startClockSec: 2 * 3600,
      legs: [{ id: '1', type: 'ride', patternId: 'X-S-000', boardStationId: 'A', alightStationId: 'E' }],
    }));
    // X has no departures array: keeps the does-not-run error, ½ of the
    // 1800 fallback headway
    expect(res.legs[0].errors[0]).toMatch(/does not run/);
    expect(res.legs[0].waitSec).toBe(900);
  });

  it('nextDeparture checks the previous service day before 6am', () => {
    // 1am Sunday: Saturday's 25:10 trip (= 1:10am Sun) should be found
    const p = idx.patternById.get('R-S-000')!;
    const sat = { ...p, departures: { Saturday: p.departures!.Weekday } };
    expect(nextDeparture(sat, 0, 'Sunday', 1 * 3600)).toBe((25 * 60 + 10) * 60 - 86400);
  });
});

// ---- real network spot checks ------------------------------------------------

const netPath = join(dirname(fileURLToPath(import.meta.url)), '../../public/network.json');
const real: Network = JSON.parse(readFileSync(netPath, 'utf8'));
const ridx = buildIndex(real);

describe('real network', () => {
  it('has exactly 472 record stations (493 with SIR)', () => {
    expect(ridx.recordStationIds.size).toBe(472);
    expect(ridx.allStationIds.size).toBe(493);
  });

  it('includeSIR raises the target to 493 and counts SIR rides', () => {
    const sir = real.patterns.find((p) => p.routeId === 'SI' && p.stations.length === 21)!;
    const base: Plan = {
      id: 'p', name: '', startStationId: sir.stations[0], startClockSec: 12 * 3600,
      serviceDay: 'Weekday', contingencies: {},
      config: { passThroughCounts: false, walkPaceMultiplier: 0.8 },
      legs: [{ id: '1', type: 'ride', patternId: sir.id, boardStationId: sir.stations[0], alightStationId: sir.stations[20] }],
    };
    const without = evaluatePlan(ridx, base);
    expect(without.totalToCover).toBe(472);
    expect(without.coveredCount).toBe(0); // SIR stations don't count
    const withSIR = evaluatePlan(ridx, { ...base, config: { ...base.config, includeSIR: true } });
    expect(withSIR.totalToCover).toBe(493);
    expect(withSIR.coveredCount).toBe(21);
  });

  it('42 St shuttle Times Sq -> Grand Central ≈ 90s', () => {
    const p = real.patterns.find(
      (q) => q.routeId === 'GS' && q.stations.length === 2 && q.direction === 'S');
    expect(p).toBeDefined();
    const res = evaluatePlan(ridx, {
      id: 'p', name: '', startStationId: p!.stations[0], startClockSec: 12 * 3600,
      serviceDay: 'Weekday', contingencies: {},
      config: { passThroughCounts: false, walkPaceMultiplier: 0.8 },
      legs: [{ id: '1', type: 'ride', patternId: p!.id, boardStationId: p!.stations[0], alightStationId: p!.stations[1], wait: 'zero' }],
    });
    expect(res.legs[0].errors).toEqual([]);
    expect(res.legs[0].moveSec).toBeGreaterThanOrEqual(60);
    expect(res.legs[0].moveSec).toBeLessThanOrEqual(150);
  });

  it('A express 125 St -> 59 St-Columbus Circle ≈ 8-10 min midday', () => {
    const byName = new Map(real.stations.map((s) => [s.name + '|' + s.id, s]));
    const s125 = real.stations.find((s) => s.name === '125 St' && s.routes.includes('A'))!;
    const s59 = real.stations.find((s) => s.name === '59 St-Columbus Circle')!;
    expect(byName.size).toBeGreaterThan(0);
    const p = real.patterns.find((q) =>
      q.routeId === 'A' && q.stations.indexOf(s125.id) >= 0 &&
      q.stations.indexOf(s59.id) > q.stations.indexOf(s125.id));
    expect(p).toBeDefined();
    const res = evaluatePlan(ridx, {
      id: 'p', name: '', startStationId: s125.id, startClockSec: 13 * 3600,
      serviceDay: 'Weekday', contingencies: {},
      config: { passThroughCounts: false, walkPaceMultiplier: 0.8 },
      legs: [{ id: '1', type: 'ride', patternId: p!.id, boardStationId: s125.id, alightStationId: s59.id, wait: 'zero' }],
    });
    expect(res.legs[0].moveSec).toBeGreaterThanOrEqual(7 * 60);
    expect(res.legs[0].moveSec).toBeLessThanOrEqual(11 * 60);
  });

  it('ships sorted departure arrays aligned with pattern stops', () => {
    const withDeps = real.patterns.filter((p) => p.departures);
    expect(withDeps.length).toBe(real.patterns.length);
    const p = withDeps.find((q) => q.departures!.Weekday)!;
    const deps = p.departures!.Weekday!;
    expect(deps.length).toBe(p.stations.length);
    for (const arr of deps) {
      for (let i = 1; i < arr.length; i++) expect(arr[i]).toBeGreaterThan(arr[i - 1]);
    }
  });

  it('schedule mode snaps an overnight ride to a real departure', () => {
    // 2:30am on the A: overnight headways are ~20 min, well above the
    // cutoff. The overnight A runs local, a distinct stop-list pattern, so
    // pick the candidate with the soonest real departure at 125 St.
    const s125 = real.stations.find((s) => s.name === '125 St' && s.routes.includes('A'))!;
    const s59 = real.stations.find((s) => s.name === '59 St-Columbus Circle')!;
    const candidates = real.patterns.filter((q) =>
      q.routeId === 'A' && q.service.Weekday?.[0].runs &&
      q.stations.indexOf(s125.id) >= 0 &&
      q.stations.indexOf(s59.id) > q.stations.indexOf(s125.id));
    expect(candidates.length).toBeGreaterThan(0);
    const p = candidates.reduce((a, b) => {
      const da = nextDeparture(a, a.stations.indexOf(s125.id), 'Weekday', 2.5 * 3600);
      const db = nextDeparture(b, b.stations.indexOf(s125.id), 'Weekday', 2.5 * 3600);
      return typeof db === 'number' && (typeof da !== 'number' || db < da) ? b : a;
    });
    const res = evaluatePlan(ridx, {
      id: 'p', name: '', startStationId: s125.id, startClockSec: 2.5 * 3600,
      serviceDay: 'Weekday', contingencies: {},
      config: { passThroughCounts: false, walkPaceMultiplier: 0.8, scheduleMode: true },
      legs: [{ id: '1', type: 'ride', patternId: p.id, boardStationId: s125.id, alightStationId: s59.id }],
    });
    const leg = res.legs[0];
    expect(leg.errors).toEqual([]);
    expect(leg.scheduledDepSec).not.toBeUndefined();
    expect(leg.scheduledDepSec!).toBeGreaterThanOrEqual(2.5 * 3600);
    expect(leg.waitSec).toBe(leg.scheduledDepSec! - 2.5 * 3600);
    expect(leg.waitSec).toBeLessThanOrEqual(40 * 60); // a train does come
  });

  it('evaluates a 60-leg plan in under 10ms', () => {
    const p = real.patterns[0];
    const legs = Array.from({ length: 60 }, (_, i) => ({
      id: String(i), type: 'ride' as const, patternId: p.id,
      boardStationId: p.stations[0],
      alightStationId: p.stations[p.stations.length - 1],
    }));
    const plan0: Plan = {
      id: 'perf', name: '', startStationId: p.stations[0], startClockSec: 12 * 3600,
      serviceDay: 'Weekday', legs, contingencies: {},
      config: { passThroughCounts: false, walkPaceMultiplier: 0.8 },
    };
    evaluatePlan(ridx, plan0); // warm
    const t0 = performance.now();
    evaluatePlan(ridx, plan0);
    expect(performance.now() - t0).toBeLessThan(10);
  });
});
