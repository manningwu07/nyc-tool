/**
 * Greedy route constructor for the subway speedrun.
 *
 * Builds a time-dependent ride/walk graph from network.json, then repeatedly
 * Dijkstras from the current position and extends the route toward whichever
 * uncovered station gives the best (time cost / new stations covered) ratio.
 * The finished route is re-scored with the real timing engine (evaluatePlan)
 * so the number reported is exactly what the app will show.
 *
 * Usage: npx tsx scripts/solver.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, evaluatePlan, transferBetween, walkEstimateSec, type NetworkIndex } from '../src/engine/engine';
import { bandOf, serviceDayAt, fmtClock, fmtDur } from '../src/engine/time';
import type { Leg, Network, Pattern, Plan, ServiceDay } from '../src/engine/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const net: Network = JSON.parse(readFileSync(join(HERE, '../public/network.json'), 'utf8'));
const idx = buildIndex(net);

const PACE = 0.8;
const ALIGHT_SEC = 15;
const SELF_TRANSFER_SEC = 120; // platform change inside one station, sprinting
const MAX_WALK_SEC = 900; // ignore longer street walks in the graph

// ---- graph ------------------------------------------------------------------

// node ids: `S:${stationId}` (off-train) and `R:${patternId}:${stopIndex}` (riding)
interface Edge { to: string; kind: 'board' | 'ride' | 'alight' | 'walk'; pattern?: Pattern; index?: number }

const adj = new Map<string, Edge[]>();
function pushEdge(from: string, e: Edge) {
  let a = adj.get(from);
  if (!a) adj.set(from, (a = []));
  a.push(e);
}

for (const p of net.patterns) {
  if (p.tripCount < 5) continue; // ignore one-off trips
  for (let i = 0; i < p.stations.length; i++) {
    const sid = p.stations[i];
    if (i < p.stations.length - 1) {
      pushEdge(`S:${sid}`, { to: `R:${p.id}:${i}`, kind: 'board', pattern: p, index: i });
      pushEdge(`R:${p.id}:${i}`, { to: `R:${p.id}:${i + 1}`, kind: 'ride', pattern: p, index: i });
    }
    pushEdge(`R:${p.id}:${i}`, { to: `S:${sid}`, kind: 'alight' });
  }
}
// walk/transfer edges between distinct stations
const walkPairs = new Map<string, number>();
for (const t of net.transfers) {
  if (t.from === t.to) continue;
  const sec = Math.round(t.sec * PACE);
  const k1 = `${t.from}|${t.to}`;
  if (!walkPairs.has(k1) || walkPairs.get(k1)! > sec) walkPairs.set(k1, sec);
  const k2 = `${t.to}|${t.from}`;
  if (!walkPairs.has(k2) || walkPairs.get(k2)! > sec) walkPairs.set(k2, sec);
}
// strategic short street walks between any station pair within ~700m
const stations = net.stations;
for (let i = 0; i < stations.length; i++) {
  for (let j = i + 1; j < stations.length; j++) {
    const a = stations[i], b = stations[j];
    const dLat = Math.abs(a.lat - b.lat), dLon = Math.abs(a.lon - b.lon);
    if (dLat > 0.008 || dLon > 0.01) continue;
    const sec = Math.round(walkEstimateSec(idx, a.id, b.id) * PACE);
    if (sec > MAX_WALK_SEC) continue;
    const k1 = `${a.id}|${b.id}`, k2 = `${b.id}|${a.id}`;
    if (!walkPairs.has(k1) || walkPairs.get(k1)! > sec) walkPairs.set(k1, sec);
    if (!walkPairs.has(k2) || walkPairs.get(k2)! > sec) walkPairs.set(k2, sec);
  }
}
for (const [k, sec] of walkPairs) {
  const [from, to] = k.split('|');
  pushEdge(`S:${from}`, { to: `S:${to}`, kind: 'walk', index: sec });
}

function headwayAt(p: Pattern, day: ServiceDay, band: number): { runs: boolean; h: number } {
  const bands = p.service[day];
  if (!bands) return { runs: false, h: Infinity };
  const b = bands[band];
  return { runs: b.runs, h: b.headwaySec ?? 1800 };
}
function hopSec(p: Pattern, i: number, day: ServiceDay, band: number): number | null {
  const order: ServiceDay[] = day === 'Weekday' ? ['Weekday', 'Saturday', 'Sunday']
    : day === 'Saturday' ? ['Saturday', 'Sunday', 'Weekday'] : ['Sunday', 'Saturday', 'Weekday'];
  for (const d of order) {
    const vals = p.hops[i]?.[d];
    if (!vals) continue;
    if (vals[band] != null) return vals[band]!;
    for (let off = 1; off < 5; off++) {
      for (const bb of [band + off, band - off]) {
        if (bb >= 0 && bb < 5 && vals[bb] != null) return vals[bb]!;
      }
    }
  }
  return null;
}

/** when true, boarding costs a flat penalty instead of headway/2 — used for
 *  the TSP matrix so the optimizer chases ride time, not boarding luck */
let FLAT_BOARD = false;

// time-dependent edge cost, given current clock t and whether we just alighted
function edgeCost(e: Edge, t: number, startDay: ServiceDay, cameOffTrain: boolean): number | null {
  const day = serviceDayAt(startDay, t);
  const band = bandOf(t);
  if (e.kind === 'board') {
    const { runs, h } = headwayAt(e.pattern!, day, band);
    if (!runs) return null;
    if (FLAT_BOARD) return 240;
    return (cameOffTrain ? SELF_TRANSFER_SEC : 0) + Math.round(h / 2);
  }
  if (e.kind === 'ride') {
    const s = hopSec(e.pattern!, e.index!, day, band);
    return s ?? null;
  }
  if (e.kind === 'alight') return ALIGHT_SEC;
  return e.index!; // walk sec precomputed
}

// ---- dijkstra ---------------------------------------------------------------

interface Label { t: number; prev: string | null; prevEdge: Edge | null; boarded?: boolean }

function dijkstra(startStation: string, t0: number, startDay: ServiceDay): Map<string, Label> {
  const labels = new Map<string, Label>();
  const start = `S:${startStation}`;
  labels.set(start, { t: t0, prev: null, prevEdge: null });
  // simple binary heap
  const heap: [number, string][] = [[t0, start]];
  const pop = (): [number, string] | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
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
  const push = (v: [number, string]) => {
    heap.push(v);
    let i = heap.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (heap[par][0] <= heap[i][0]) break;
      [heap[par], heap[i]] = [heap[i], heap[par]];
      i = par;
    }
  };
  const done = new Set<string>();
  for (;;) {
    const top = pop();
    if (!top) break;
    const [t, node] = top;
    if (done.has(node)) continue;
    done.add(node);
    const cameOffTrain = node.startsWith('S:') && labels.get(node)!.prevEdge?.kind === 'alight';
    for (const e of adj.get(node) ?? []) {
      const c = edgeCost(e, t, startDay, cameOffTrain || (node.startsWith('S:') && labels.get(node)!.prev !== null && labels.get(node)!.prevEdge?.kind !== 'walk'));
      if (c === null) continue;
      const nt = t + c;
      const cur = labels.get(e.to);
      if (!cur || nt < cur.t) {
        labels.set(e.to, {
          t: nt, prev: node, prevEdge: e,
          boarded: labels.get(node)!.boarded || e.kind === 'board',
        });
        push([nt, e.to]);
      }
    }
  }
  return labels;
}

// reconstruct node path from labels
function pathTo(labels: Map<string, Label>, target: string): { node: string; edge: Edge | null }[] | null {
  if (!labels.has(target)) return null;
  const out: { node: string; edge: Edge | null }[] = [];
  let cur: string | null = target;
  while (cur) {
    const l: Label = labels.get(cur)!;
    out.push({ node: cur, edge: l.prevEdge });
    cur = l.prev;
  }
  return out.reverse();
}

// stations covered along a node path (stops where the train stops, incl. pass-through ride nodes)
function pathStations(path: { node: string; edge: Edge | null }[]): string[] {
  const out: string[] = [];
  for (const { node } of path) {
    if (node.startsWith('R:')) {
      const [, pid, iStr] = node.split(':');
      const p = idx.patternById.get(pid)!;
      out.push(p.stations[Number(iStr)]);
    } else {
      out.push(node.slice(2));
    }
  }
  return out;
}

// convert node path → plan legs
function pathToLegs(path: { node: string; edge: Edge | null }[]): Leg[] {
  const legs: Leg[] = [];
  let ridePattern: Pattern | null = null;
  let boardStation: string | null = null;
  let lastRideStation: string | null = null;
  const flushRide = () => {
    if (ridePattern && boardStation && lastRideStation && boardStation !== lastRideStation) {
      legs.push({
        id: `g${legs.length}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'ride', patternId: ridePattern.id,
        boardStationId: boardStation, alightStationId: lastRideStation,
      });
    }
    ridePattern = null; boardStation = null; lastRideStation = null;
  };
  for (const { node, edge } of path) {
    if (!edge) continue;
    if (edge.kind === 'board') {
      const p = edge.pattern!;
      ridePattern = p;
      boardStation = p.stations[edge.index!];
      lastRideStation = boardStation;
    } else if (edge.kind === 'ride') {
      const [, pid, iStr] = node.split(':');
      lastRideStation = idx.patternById.get(pid)!.stations[Number(iStr)];
    } else if (edge.kind === 'alight') {
      flushRide();
    } else if (edge.kind === 'walk') {
      const from = path[path.indexOf({ node, edge })]; void from;
      // walk edge: node is destination S:x, prev is S:y
      const toSid = node.slice(2);
      // find source from the previous element
      const i = path.findIndex((q) => q.node === node && q.edge === edge);
      const fromSid = path[i - 1].node.slice(2);
      legs.push({
        id: `g${legs.length}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'walk', fromStationId: fromSid, toStationId: toSid,
        sec: Math.round((walkPairs.get(`${fromSid}|${toSid}`) ?? walkEstimateSec(idx, fromSid, toSid)) / PACE),
      });
    }
  }
  flushRide();
  return legs;
}

// ---- greedy construction ------------------------------------------------------

/** best single ride from `loc` at time `t`: pick (pattern, alight) maximizing
 *  new-station coverage per second; alight at the LAST new station (no point
 *  riding further). Returns null if nothing new is reachable directly. */
function bestSweep(loc: string, t: number, day: ServiceDay, covered: Set<string>, target: Set<string>, alpha: number):
  { pattern: Pattern; boardIdx: number; alightIdx: number; gain: number; sec: number; score: number } | null {
  const d = serviceDayAt(day, t);
  const band = bandOf(t);
  let best: ReturnType<typeof bestSweep> = null;
  for (const { pattern: p, index } of idx.patternsByStation.get(loc) ?? []) {
    if (p.tripCount < 5 || index >= p.stations.length - 1) continue;
    const { runs, h } = headwayAt(p, d, band);
    if (!runs) continue;
    let sec = SELF_TRANSFER_SEC + Math.round(h / 2);
    let tt = t + sec;
    let gain = 0;
    for (let j = index; j < p.stations.length - 1; j++) {
      const hop = hopSec(p, j, serviceDayAt(day, tt), bandOf(tt));
      if (hop === null) break;
      sec += hop;
      tt += hop;
      const sid = p.stations[j + 1];
      if (target.has(sid) && !covered.has(sid)) {
        gain++;
        const score = sec / Math.pow(gain, alpha);
        if (gain >= 1 && (!best || score < best.score)) {
          best = { pattern: p, boardIdx: index, alightIdx: j + 1, gain, sec, score };
        }
      }
    }
  }
  return best;
}

function applySweep(sweep: NonNullable<ReturnType<typeof bestSweep>>, covered: Set<string>, target: Set<string>, legs: Leg[]) {
  const p = sweep.pattern;
  for (let j = sweep.boardIdx; j <= sweep.alightIdx; j++) {
    const sid = p.stations[j];
    if (target.has(sid)) covered.add(sid);
  }
  legs.push({
    id: `g${legs.length}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'ride', patternId: p.id,
    boardStationId: p.stations[sweep.boardIdx], alightStationId: p.stations[sweep.alightIdx],
  });
}

function buildRoute(startStation: string, startClock: number, day: ServiceDay, alpha: number, target: Set<string>) {
  const covered = new Set<string>([startStation].filter((s) => target.has(s)));
  let loc = startStation;
  let t = startClock;
  const legs: Leg[] = [];

  while (covered.size < target.size) {
    // option A: sweep directly from here
    const direct = bestSweep(loc, t, day, covered, target, alpha);

    // option B: reposition (Dijkstra) to a frontier station, then sweep there
    const labels = dijkstra(loc, t, day);
    const cands: { sid: string; t: number }[] = [];
    for (const sid of target) {
      if (covered.has(sid)) continue;
      const l = labels.get(`S:${sid}`);
      if (l) cands.push({ sid, t: l.t });
    }
    if (!cands.length && !direct) break;
    cands.sort((a, b) => a.t - b.t);

    let bestRepo: {
      score: number; path: { node: string; edge: Edge | null }[];
      sweep: ReturnType<typeof bestSweep>; sid: string; arr: number; pathGain: number;
    } | null = null;
    for (const c of cands.slice(0, 30)) {
      const path = pathTo(labels, `S:${c.sid}`)!;
      const pathGain = new Set(pathStations(path).filter((s) => target.has(s) && !covered.has(s))).size;
      // simulate coverage of the path for the lookahead sweep
      const simCovered = new Set(covered);
      for (const s of pathStations(path)) if (target.has(s)) simCovered.add(s);
      const sw = bestSweep(c.sid, c.t, day, simCovered, target, alpha);
      const cost = (c.t - t) + (sw ? sw.sec : 0);
      const gain = pathGain + (sw ? sw.gain : 0);
      if (gain === 0) continue;
      const score = cost / Math.pow(gain, alpha);
      if (!bestRepo || score < bestRepo.score) bestRepo = { score, path, sweep: sw, sid: c.sid, arr: c.t, pathGain };
    }

    if (direct && (!bestRepo || direct.score <= bestRepo.score)) {
      const tt = t + direct.sec;
      applySweep(direct, covered, target, legs);
      t = tt;
      loc = direct.pattern.stations[direct.alightIdx];
    } else if (bestRepo) {
      for (const s of pathStations(bestRepo.path)) if (target.has(s)) covered.add(s);
      legs.push(...pathToLegs(bestRepo.path));
      t = bestRepo.arr;
      loc = bestRepo.sid;
      if (bestRepo.sweep) {
        const tt = t + bestRepo.sweep.sec;
        applySweep(bestRepo.sweep, covered, target, legs);
        t = tt;
        loc = bestRepo.sweep.pattern.stations[bestRepo.sweep.alightIdx];
      }
    } else {
      break;
    }
    if (legs.length > 1200) break; // safety
  }
  return legs;
}

// merge consecutive ride legs on the same pattern (board where we alighted)
function mergeLegs(legs: Leg[]): Leg[] {
  const out: Leg[] = [];
  for (const leg of legs) {
    const prev = out[out.length - 1];
    if (prev && prev.type === 'ride' && leg.type === 'ride' &&
        prev.patternId === leg.patternId && prev.alightStationId === leg.boardStationId) {
      prev.alightStationId = leg.alightStationId;
    } else {
      out.push({ ...leg });
    }
  }
  return out;
}

// ---- TSP-path mode -------------------------------------------------------------

/** all-pairs travel time between target stations (Dijkstra from each),
 *  evaluated at a fixed daytime clock for a stable optimization metric */
function buildMatrix(ids: string[], t0: number, day: ServiceDay): Int32Array {
  const n = ids.length;
  const pos = new Map(ids.map((id, i) => [id, i]));
  const m = new Int32Array(n * n).fill(1 << 28);
  FLAT_BOARD = true;
  for (let i = 0; i < n; i++) {
    const labels = dijkstra(ids[i], t0, day);
    for (const [node, l] of labels) {
      if (!node.startsWith('S:')) continue;
      const j = pos.get(node.slice(2));
      if (j === undefined) continue;
      // first boarding is free: standing at i you board once no matter what,
      // so the marginal cost of "i then j" on the same line is pure ride time
      // while a line change keeps one 240s penalty. Walk-only paths keep
      // their full cost (no boarding to discount).
      m[i * n + j] = l.boarded ? Math.max(30, l.t - t0 - 240) : l.t - t0;
    }
    m[i * n + i] = 0;
  }
  FLAT_BOARD = false;
  return m;
}

function tourCost(tour: number[], m: Int32Array, n: number): number {
  let c = 0;
  for (let i = 0; i < tour.length - 1; i++) c += m[tour[i] * n + tour[i + 1]];
  return c;
}

function nnTour(start: number, m: Int32Array, n: number): number[] {
  const used = new Uint8Array(n);
  const tour = [start];
  used[start] = 1;
  for (let k = 1; k < n; k++) {
    const cur = tour[tour.length - 1];
    let best = -1, bd = Infinity;
    for (let j = 0; j < n; j++) {
      if (!used[j] && m[cur * n + j] < bd) { bd = m[cur * n + j]; best = j; }
    }
    tour.push(best);
    used[best] = 1;
  }
  return tour;
}

/** Or-opt: relocate segments of length 1..3 anywhere (no reversal — costs are
 *  directed); repeat until no improving move */
function orOpt(tour: number[], m: Int32Array, n: number): number[] {
  const t = tour.slice();
  const d = (a: number, b: number) => m[a * n + b];
  let improved = true;
  while (improved) {
    improved = false;
    for (let len = 1; len <= 6; len++) {
      for (let i = 0; i + len <= t.length; i++) {
        // removing t[i..i+len-1]
        const a = i > 0 ? t[i - 1] : -1;
        const b = i + len < t.length ? t[i + len] : -1;
        const segStart = t[i], segEnd = t[i + len - 1];
        const removeGain =
          (a >= 0 ? d(a, segStart) : 0) + (b >= 0 ? d(segEnd, b) : 0) - (a >= 0 && b >= 0 ? d(a, b) : 0);
        if (removeGain <= 0) continue;
        // try inserting between every adjacent pair (and at ends)
        let bestDelta = -1e-9, bestPos = -1;
        for (let j = 0; j + 1 < t.length; j++) {
          if (j >= i - 1 && j <= i + len) continue; // overlapping
          const u = t[j], v = t[j + 1];
          if (u === undefined || v === undefined) continue;
          const insCost = d(u, segStart) + d(segEnd, v) - d(u, v);
          const delta = removeGain - insCost;
          if (delta > bestDelta) { bestDelta = delta; bestPos = j; }
        }
        if (bestPos >= 0 && bestDelta > 0) {
          const seg = t.splice(i, len);
          const at = bestPos < i ? bestPos + 1 : bestPos + 1 - len;
          t.splice(at, 0, ...seg);
          improved = true;
        }
      }
    }
  }
  return t;
}

/** turn a station visit order into actual legs.
 *  Sweep extraction: from the current station, board the pattern that covers
 *  the most of the next WINDOW uncovered tour stations and ride to the
 *  farthest of them — one boarding amortized over a long run. When no direct
 *  pattern helps, Dijkstra-connect to the next uncovered tour station. */
function constructFromTour(tourIds: string[], startClock: number, day: ServiceDay, target: Set<string>): Leg[] {
  const WINDOW = 14;
  const covered = new Set<string>([tourIds[0]]);
  let loc = tourIds[0];
  let t = startClock;
  const legs: Leg[] = [];
  let guard = 0;

  const pending = () => tourIds.filter((s) => !covered.has(s));

  while (covered.size < target.size && guard++ < 3000) {
    const up = pending().slice(0, WINDOW);
    if (!up.length) break;
    const upSet = new Set(up);

    // best direct sweep from loc over the window
    let best: { p: Pattern; bi: number; ai: number; hits: number; sec: number } | null = null;
    const d0 = serviceDayAt(day, t);
    const b0 = bandOf(t);
    for (const { pattern: p, index } of idx.patternsByStation.get(loc) ?? []) {
      if (p.tripCount < 5 || index >= p.stations.length - 1) continue;
      const { runs, h } = headwayAt(p, d0, b0);
      if (!runs) continue;
      let sec = SELF_TRANSFER_SEC + Math.round(h / 2);
      let tt = t + sec;
      let hits = 0, lastHit = -1, lastSec = 0;
      for (let j = index; j < p.stations.length - 1; j++) {
        const hop = hopSec(p, j, serviceDayAt(day, tt), bandOf(tt));
        if (hop === null) break;
        sec += hop; tt += hop;
        const sid = p.stations[j + 1];
        if (upSet.has(sid) && !covered.has(sid)) { hits++; lastHit = j + 1; lastSec = sec; }
      }
      if (lastHit < 0) continue;
      // prefer more window hits; tiebreak on time per hit
      if (!best || hits > best.hits || (hits === best.hits && lastSec < best.sec)) {
        best = { p, bi: index, ai: lastHit, hits, sec: lastSec };
      }
    }

    if (best && best.hits >= 2) {
      for (let j = best.bi; j <= best.ai; j++) {
        const sid = best.p.stations[j];
        if (target.has(sid)) covered.add(sid);
      }
      legs.push({
        id: `g${legs.length}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'ride', patternId: best.p.id,
        boardStationId: best.p.stations[best.bi], alightStationId: best.p.stations[best.ai],
      });
      t += best.sec;
      loc = best.p.stations[best.ai];
      continue;
    }

    // connector to the next uncovered tour station
    const nxt = up[0];
    const labels = dijkstra(loc, t, day);
    const l = labels.get(`S:${nxt}`);
    if (!l) { covered.add(nxt); continue; } // unreachable safeguard
    const path = pathTo(labels, `S:${nxt}`)!;
    for (const s of pathStations(path)) if (target.has(s)) covered.add(s);
    legs.push(...pathToLegs(path));
    t = l.t;
    loc = nxt;
  }
  return legs;
}

// ---- search over starts --------------------------------------------------------

void buildRoute; // greedy mode kept for reference

const target = idx.recordStationIds;
const ids = [...target];
const n = ids.length;
console.log('building all-pairs matrix...');
const m = buildMatrix(ids, 13 * 3600, 'Weekday');

// NN from every branch terminal + a few random starts, Or-opt the best few
const terminalIdx: number[] = [];
for (const p of net.patterns) {
  if (p.tripCount < 40) continue;
  for (const sid of [p.stations[0], p.stations[p.stations.length - 1]]) {
    const i = ids.indexOf(sid);
    if (i >= 0 && !terminalIdx.includes(i)) terminalIdx.push(i);
  }
}
console.log(`NN tours from ${terminalIdx.length} terminals...`);
const nnTours = terminalIdx.map((s) => nnTour(s, m, n))
  .sort((a, b) => tourCost(a, m, n) - tourCost(b, m, n));

let bestTour: number[] | null = null;
let bestTourCost = Infinity;
for (const cand of nnTours.slice(0, 8)) {
  const opt = orOpt(cand, m, n);
  const c = tourCost(opt, m, n);
  if (c < bestTourCost) { bestTourCost = c; bestTour = opt; }
}
// perturb-and-reoptimize restarts (double-bridge style segment shuffles)
for (let r = 0; r < 12; r++) {
  const t = bestTour!.slice();
  for (let k = 0; k < 3; k++) {
    const len = 5 + Math.floor(Math.random() * 20);
    const i = 1 + Math.floor(Math.random() * (t.length - len - 2));
    const seg = t.splice(i, len);
    const j = 1 + Math.floor(Math.random() * (t.length - 2));
    t.splice(j, 0, ...seg);
  }
  const opt = orOpt(t, m, n);
  const c = tourCost(opt, m, n);
  if (c < bestTourCost) { bestTourCost = c; bestTour = opt; }
}
console.log(`best tour (matrix estimate): ${fmtDur(bestTourCost)}, start ${idx.stationById.get(ids[bestTour![0]])?.name}`);

let bestPlan: Plan | null = null;
let bestElapsed = Infinity;
const results: string[] = [];
const tourIds = bestTour!.map((i) => ids[i]);

for (const t0 of [4.5 * 3600, 5.5 * 3600, 6.5 * 3600, 8 * 3600]) {
  const legs = mergeLegs(constructFromTour(tourIds, t0, 'Weekday', target));
  const plan: Plan = {
    id: 'tsp', name: `tsp ${idx.stationById.get(tourIds[0])?.name} ${fmtClock(t0)}`,
    startStationId: tourIds[0], startClockSec: t0, serviceDay: 'Weekday',
    legs, contingencies: {},
    config: { passThroughCounts: false, walkPaceMultiplier: PACE },
  };
  const res = evaluatePlan(idx, plan);
  results.push(`start ${fmtClock(t0)}  ${res.coveredCount}/${target.size}  ${fmtDur(res.elapsedSec)}  legs=${legs.length} err=${res.errorCount}`);
  if (res.coveredCount === target.size && res.elapsedSec < bestElapsed) {
    bestElapsed = res.elapsedSec;
    bestPlan = plan;
  }
}

// also score the best-known greedy configs and keep the overall winner
for (const [name, t0, alpha] of [['Flushing-Main St', 5.5 * 3600, 0.8], ['Flushing-Main St', 4.5 * 3600, 0.8], ['New Lots Av', 5.5 * 3600, 0.8]] as const) {
  const st = net.stations.find((s) => s.name === name && s.countsTowardRecord)!;
  const legs = mergeLegs(buildRoute(st.id, t0, 'Weekday', alpha, target));
  const plan: Plan = {
    id: 'greedy', name: `greedy ${name} ${fmtClock(t0)}`,
    startStationId: st.id, startClockSec: t0, serviceDay: 'Weekday',
    legs, contingencies: {},
    config: { passThroughCounts: false, walkPaceMultiplier: PACE },
  };
  const res = evaluatePlan(idx, plan);
  results.push(`greedy ${name} ${fmtClock(t0)}  ${res.coveredCount}/${target.size}  ${fmtDur(res.elapsedSec)}  legs=${legs.length} err=${res.errorCount}`);
  if (res.coveredCount === target.size && res.elapsedSec < bestElapsed) {
    bestElapsed = res.elapsedSec;
    bestPlan = plan;
  }
}

console.log(results.join('\n'));
if (bestPlan) {
  const res = evaluatePlan(idx, bestPlan);
  console.log('\nBEST:', bestPlan.name);
  console.log(`coverage ${res.coveredCount}/${res.totalToCover}, elapsed ${fmtDur(res.elapsedSec)}, finish ${fmtClock(res.endSec)}, errors ${res.errorCount}`);
  mkdirSync(join(HERE, '../../plans'), { recursive: true });
  const out = join(HERE, '../../plans/greedy-best.plan.json');
  writeFileSync(out, JSON.stringify(bestPlan, null, 2));
  console.log('wrote', out);
}
