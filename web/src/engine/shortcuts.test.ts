import { describe, it, expect } from 'vitest';
import { buildIndex, evaluatePlan } from './engine';
import {
  branchTipStations, buildTravelGraph, estWalkSec, findShortcuts, networkTimesFrom,
} from './shortcuts';
import type { Network, Plan, ServiceBand } from './types';

const FULL: ServiceBand[] = Array.from({ length: 5 }, () => ({
  runs: true, headwaySec: 600, trips: 10,
}));

// Two parallel north-south lines ~250m apart, connected in-system only at
// their south ends (A<->D). The north tips C and F are the classic shortcut:
// a 4-minute street walk vs ~32 minutes riding back around.
//
//   C (L1 north tip)  ~250m  F (L2 north tip)
//   B                        E
//   A  <-- walk 120s -->     D
const mkPattern = (id: string, stations: string[]) => ({
  id, routeId: id.slice(0, 2), direction: id.endsWith('N') ? 'N' as const : 'S' as const,
  label: id, stations,
  hops: stations.slice(1).map(() => ({ Weekday: [300, 300, 300, 300, 300] })),
  service: { Weekday: FULL }, tripCount: 50, shapeId: null,
});

const fixture: Network = {
  generatedAt: '', bands: [], serviceDays: ['Weekday', 'Saturday', 'Sunday'],
  stations: [
    ['A', 40.700, -74.000], ['B', 40.710, -74.000], ['C', 40.720, -74.000],
    ['D', 40.700, -73.997], ['E', 40.710, -73.997], ['F', 40.720, -73.997],
  ].map(([id, lat, lon]) => ({
    id: id as string, name: `Sta ${id}`, borough: 'M', complexId: id as string,
    lat: lat as number, lon: lon as number, gtfsStopIds: [id as string],
    routes: [], countsTowardRecord: true,
  })),
  patterns: [
    mkPattern('L1-N', ['A', 'B', 'C']), mkPattern('L1-S', ['C', 'B', 'A']),
    mkPattern('L2-N', ['D', 'E', 'F']), mkPattern('L2-S', ['F', 'E', 'D']),
  ],
  transfers: [
    { from: 'A', to: 'D', kind: 'walk', sec: 120, notes: '' },
    { from: 'B', to: 'E', kind: 'walk', sec: 200, notes: '', confirmed: false },
    {
      from: 'C', to: 'F', kind: 'bus', sec: 300, notes: '', confirmed: false,
      routeLabel: 'Bx1', accessSec: 60,
      busService: {
        Weekday: {
          rideSec: [300, 300, 300, 300, 300],
          headwaySec: [900, 900, 900, 900, 900],
        },
      },
    },
  ],
  routes: [], shapes: {},
};

const idx = buildIndex(fixture);

function plan(partial: Partial<Plan>): Plan {
  return {
    id: 'p', name: 'test', startStationId: 'C', startClockSec: 12 * 3600,
    serviceDay: 'Monday', legs: [], contingencies: {},
    config: { passThroughCounts: false, walkPaceMultiplier: 1 },
    ...partial,
  };
}

describe('travel graph', () => {
  it('Dijkstra includes half-headway boarding waits', () => {
    const g = buildTravelGraph(idx, 'Weekday', 2);
    const d = networkTimesFrom(g, 'A');
    expect(d.get('C')).toBe(300 + 600); // wait 600/2 + two 300s hops
    expect(d.get('D')).toBe(120); // direct walk edge
    expect(d.get('F')).toBe(120 + 300 + 600); // walk + board L2 + ride
  });

  it('bus edges are not in-system connections', () => {
    const g = buildTravelGraph(idx, 'Weekday', 2);
    const d = networkTimesFrom(g, 'C');
    // C -> F rides to B, walks the B-E edge, rides to F — not via the Bx1
    expect(d.get('F')).toBe(300 + 300 + 200 + 300 + 300);
  });
});

describe('shortcut finder', () => {
  it('surfaces close-but-far pairs ranked by walk saving', () => {
    const found = findShortcuts(idx, {
      day: 'Weekday', band: 2, maxMeters: 2000, minNetworkSec: 600,
      branchTipsOnly: false, paceSecPerKm: 540,
    });
    expect(found.length).toBeGreaterThan(0);
    const top = found[0];
    expect([top.a, top.b].sort()).toEqual(['C', 'F']);
    expect(top.networkSec).toBe(1400); // via the B-E walk edge
    expect(top.estWalkSec).toBe(estWalkSec(top.meters, 540));
    expect(top.savingSec).toBe(top.networkSec - top.estWalkSec);
  });

  it('skips pairs that already have a transfer edge', () => {
    const found = findShortcuts(idx, {
      day: 'Weekday', band: 2, maxMeters: 2000, minNetworkSec: 0,
      branchTipsOnly: false, paceSecPerKm: 540,
    });
    expect(found.some((c) => [c.a, c.b].sort().join() === 'A,D')).toBe(false);
  });

  it('branch tips cover line ends', () => {
    const tips = branchTipStations(idx);
    // 3-station lines: everything is within 3 of an end
    expect(tips.size).toBe(6);
  });
});

describe('bus legs', () => {
  it('times access + full headway + ride, flags high risk', () => {
    const res = evaluatePlan(idx, plan({
      legs: [{ id: '1', type: 'bus', fromStationId: 'C', toStationId: 'F' }],
    }));
    const leg = res.legs[0];
    expect(leg.errors).toEqual([]);
    expect(leg.transferSec).toBe(60); // walk-to-stop buffer
    expect(leg.waitSec).toBe(900); // full headway, pessimistic default
    expect(leg.moveSec).toBe(300);
    expect(leg.riskSec).toBe(900);
    expect(leg.warnings.join(' ')).toMatch(/HIGH RISK bus leg \(Bx1\)/);
    expect(leg.warnings.join(' ')).toMatch(/unconfirmed bus edge/);
    expect(res.covered).toContain('F');
  });

  it('honors a half-headway override', () => {
    const res = evaluatePlan(idx, plan({
      legs: [{ id: '1', type: 'bus', fromStationId: 'C', toStationId: 'F', wait: 'half' }],
    }));
    expect(res.legs[0].waitSec).toBe(450);
  });

  it('errors when no bus edge exists', () => {
    const res = evaluatePlan(idx, plan({
      startStationId: 'A',
      legs: [{ id: '1', type: 'bus', fromStationId: 'A', toStationId: 'E' }],
    }));
    expect(res.legs[0].errors[0]).toMatch(/no bus edge/);
  });
});

// ---- real network spot check ----------------------------------------------

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('real network shortcuts', () => {
  const netPath = join(dirname(fileURLToPath(import.meta.url)), '../../public/network.json');
  const ridx = buildIndex(JSON.parse(readFileSync(netPath, 'utf8')) as Network);

  it('surfaces known candidates fast, ranked by saving', () => {
    const t0 = performance.now();
    const found = findShortcuts(ridx, {
      day: 'Weekday', band: 2, maxMeters: 2000, minNetworkSec: 10 * 60,
      branchTipsOnly: true, paceSecPerKm: 540,
    });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(found.length).toBeGreaterThan(20);
    for (let i = 1; i < found.length; i++) {
      expect(found[i].savingSec).toBeLessThanOrEqual(found[i - 1].savingSec);
    }
    // the spec's example strategic walk (Lefferts Blvd -> Rockaway Blvd,
    // 1.6km, ~12 min in-system) appears once the threshold admits it
    const names = (c: { a: string; b: string }) =>
      [c.a, c.b].map((id) => ridx.stationById.get(id)!.name).sort().join(' / ');
    expect(found.map(names)).toContain('Ozone Park-Lefferts Blvd / Rockaway Blvd');
    // every winner at the top must actually beat the rails by a lot
    expect(found[0].savingSec).toBeGreaterThan(15 * 60);
  });
});

describe('unconfirmed walk edges', () => {
  it('warn until scouted', () => {
    const res = evaluatePlan(idx, plan({
      startStationId: 'B',
      legs: [{ id: '1', type: 'walk', fromStationId: 'B', toStationId: 'E' }],
    }));
    expect(res.legs[0].warnings.join(' ')).toMatch(/unconfirmed walk edge/);
    expect(res.legs[0].moveSec).toBe(104); // 200s base = 280m, at 10 min/mi
  });
});
