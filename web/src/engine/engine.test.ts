import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, evaluatePlan, optionsFrom } from './engine';
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
      legs: [{ id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'D' }],
    }));
    const leg = res.legs[0];
    expect(leg.errors).toEqual([]);
    expect(leg.waitSec).toBe(300); // 600/2
    expect(leg.moveSec).toBe(300); // 100+120+80
    expect(res.coveredCount).toBe(4); // A,B,C,D
    expect(res.elapsedSec).toBe(600);
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
  it('uses walk edge time scaled by pace multiplier', () => {
    const res = evaluatePlan(idx, plan({
      legs: [
        { id: '1', type: 'ride', patternId: 'L-S-000', boardStationId: 'A', alightStationId: 'B' },
        { id: '2', type: 'walk', fromStationId: 'B', toStationId: 'D' },
      ],
    }));
    expect(res.legs[1].moveSec).toBe(240); // 300 * 0.8
    expect(res.covered).toContain('D');
  });
});

describe('smart options', () => {
  it('hides patterns not running at the current time', () => {
    const noon = optionsFrom(idx, 'A', 'Weekday', 12 * 3600);
    expect(noon.rides.map((r) => r.pattern.id).sort()).toEqual(['L-S-000', 'X-S-000']);
    const night = optionsFrom(idx, 'A', 'Weekday', 3 * 3600);
    expect(night.rides.map((r) => r.pattern.id)).toEqual(['L-S-000']);
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
