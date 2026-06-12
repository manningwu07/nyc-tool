// Shortcut Finder: surfaces station pairs that are geographically close but
// far apart in-system — where walk/bus shortcut edges win back minutes.
import type { BandIndex, ServiceDay } from './types';
import type { NetworkIndex } from './engine';
import { headwayAt, hopTravel } from './engine';
import { haversineMeters } from './time';

export const WALK_STREET_FACTOR = 1.35;
export const MI_PER_KM = 1 / 1.60934;
export const DEFAULT_PACE_MIN_PER_MI = 10; // brisk walk/jog between stations
export const DEFAULT_PACE_SEC_PER_KM = Math.round(DEFAULT_PACE_MIN_PER_MI * 60 * MI_PER_KM); // ≈373

export interface ShortcutOptions {
  day: ServiceDay;
  band: BandIndex;
  /** candidate cutoff: 2000m for walks, ~5000m for buses */
  maxMeters: number;
  /** only pairs slower than this in-system are interesting (default 15 min) */
  minNetworkSec: number;
  /** restrict to branch tips (terminals + last-3 stations of each branch) */
  branchTipsOnly: boolean;
  paceSecPerKm: number;
}

export interface ShortcutCandidate {
  a: string;
  b: string;
  meters: number;
  /** best in-system time between the pair (min of both directions) */
  networkSec: number;
  estWalkSec: number;
  savingSec: number;
}

export function estWalkSec(meters: number, paceSecPerKm: number): number {
  return Math.round((meters * WALK_STREET_FACTOR / 1000) * paceSecPerKm);
}

// --- travel graph -----------------------------------------------------------
// Nodes: station ids, plus "patternId@i" riding nodes. Boarding costs
// headway/2; hops cost the band's median travel time; alighting is free;
// transfer/walk edges connect stations both ways.

export interface TravelGraph {
  adj: Map<string, [string, number][]>;
}

export function buildTravelGraph(idx: NetworkIndex, day: ServiceDay, band: BandIndex): TravelGraph {
  const adj = new Map<string, [string, number][]>();
  const add = (a: string, b: string, w: number) => {
    let arr = adj.get(a);
    if (!arr) adj.set(a, (arr = []));
    arr.push([b, w]);
  };
  for (const p of idx.net.patterns) {
    const svc = headwayAt(p, day, band);
    if (!svc.runs) continue;
    const boardCost = Math.round((svc.headwaySec ?? 1800) / 2);
    for (let i = 0; i < p.stations.length; i++) {
      const node = `${p.id}@${i}`;
      if (i < p.stations.length - 1) {
        add(p.stations[i], node, boardCost);
        const hop = hopTravel(p, i, day, band);
        if (hop) add(node, `${p.id}@${i + 1}`, hop.sec);
      }
      if (i > 0) add(node, p.stations[i], 0);
    }
  }
  for (const t of idx.net.transfers) {
    if (t.kind === 'bus' || t.from === t.to) continue;
    add(t.from, t.to, t.sec);
    add(t.to, t.from, t.sec);
  }
  return { adj };
}

/** single-source Dijkstra; returns station-level distances in seconds */
export function networkTimesFrom(graph: TravelGraph, source: string): Map<string, number> {
  const dist = new Map<string, number>();
  // binary min-heap of [dist, node]
  const heap: [number, string][] = [[0, source]];
  const pop = (): [number, string] | undefined => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  const push = (d: number, n: string) => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (heap[par][0] <= heap[i][0]) break;
      [heap[i], heap[par]] = [heap[par], heap[i]];
      i = par;
    }
  };
  dist.set(source, 0);
  while (heap.length > 0) {
    const [d, n] = pop()!;
    if (d > (dist.get(n) ?? Infinity)) continue;
    for (const [m, w] of graph.adj.get(n) ?? []) {
      const nd = d + w;
      if (nd < (dist.get(m) ?? Infinity)) {
        dist.set(m, nd);
        push(nd, m);
      }
    }
  }
  return dist;
}

/** terminals + first/last-3 stations of each branch (patterns with at least
 *  ¼ of their route+direction's max trip count, to skip odd short-turns) */
export function branchTipStations(idx: NetworkIndex): Set<string> {
  const maxTrips = new Map<string, number>();
  for (const p of idx.net.patterns) {
    const k = `${p.routeId}|${p.direction}`;
    maxTrips.set(k, Math.max(maxTrips.get(k) ?? 0, p.tripCount));
  }
  const tips = new Set<string>();
  for (const p of idx.net.patterns) {
    if (p.stations.length < 2) continue;
    if (p.tripCount < (maxTrips.get(`${p.routeId}|${p.direction}`) ?? 0) / 4) continue;
    const n = p.stations.length;
    for (const s of p.stations.slice(0, Math.min(3, n))) tips.add(s);
    for (const s of p.stations.slice(Math.max(0, n - 3))) tips.add(s);
  }
  return tips;
}

export function findShortcuts(idx: NetworkIndex, opts: ShortcutOptions): ShortcutCandidate[] {
  const stations = idx.net.stations;
  const tips = opts.branchTipsOnly ? branchTipStations(idx) : null;

  // 1. geographically close pairs not already connected
  const pairs: { a: string; b: string; meters: number }[] = [];
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const sa = stations[i], sb = stations[j];
      if (sa.complexId === sb.complexId) continue;
      if (tips && !tips.has(sa.id) && !tips.has(sb.id)) continue;
      const m = haversineMeters(sa.lat, sa.lon, sb.lat, sb.lon);
      if (m > opts.maxMeters) continue;
      if (idx.transferByPair.has(`${sa.id}|${sb.id}`) || idx.transferByPair.has(`${sb.id}|${sa.id}`)) continue;
      pairs.push({ a: sa.id, b: sb.id, meters: m });
    }
  }

  // 2. in-system times via Dijkstra from every station that appears in a pair
  const graph = buildTravelGraph(idx, opts.day, opts.band);
  const sources = new Set<string>();
  for (const p of pairs) {
    sources.add(p.a);
    sources.add(p.b);
  }
  const distFrom = new Map<string, Map<string, number>>();
  for (const s of sources) distFrom.set(s, networkTimesFrom(graph, s));

  // 3. rank by what a straight-line walk would save
  const out: ShortcutCandidate[] = [];
  for (const { a, b, meters } of pairs) {
    const ab = distFrom.get(a)?.get(b) ?? Infinity;
    const ba = distFrom.get(b)?.get(a) ?? Infinity;
    const networkSec = Math.min(ab, ba);
    if (networkSec < opts.minNetworkSec) continue;
    const walk = estWalkSec(meters, opts.paceSecPerKm);
    out.push({
      a, b, meters,
      networkSec: Number.isFinite(networkSec) ? Math.round(networkSec) : 86400,
      estWalkSec: walk,
      savingSec: (Number.isFinite(networkSec) ? Math.round(networkSec) : 86400) - walk,
    });
  }
  out.sort((x, y) => y.savingSec - x.savingSec);
  return out;
}
