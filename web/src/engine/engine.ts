import type {
  BandIndex, LegResult, Network, Pattern, Plan, PlanResult, ServiceDay,
  Station, TransferEdge, WaitPolicy,
} from './types';
import { BAND_NAMES } from './types';
import { bandOf, haversineMeters, serviceDayAt, fmtClock, DAY } from './time';

const WALK_SPEED_MPS = 1.4; // city walking pace; pace multiplier scales this
const WALK_PATH_FACTOR = 1.3; // streets are not straight lines

/** schedule mode: headway above which the wait snaps to real departures */
export const DEFAULT_SCHEDULE_CUTOFF_SEC = 720;

export interface NetworkIndex {
  net: Network;
  stationById: Map<string, Station>;
  patternById: Map<string, Pattern>;
  /** "from|to" -> best transfer edge (walk / in_system only) */
  transferByPair: Map<string, TransferEdge>;
  /** "from|to" -> bus edge (directed as ingested; look up both ways) */
  busByPair: Map<string, TransferEdge>;
  /** stationId -> patterns serving it (with stop index) */
  patternsByStation: Map<string, { pattern: Pattern; index: number }[]>;
  /** the Guinness 472 (non-SIR) */
  recordStationIds: Set<string>;
  /** all stations incl. Staten Island Railway (493) */
  allStationIds: Set<string>;
}

export function buildIndex(net: Network): NetworkIndex {
  const stationById = new Map(net.stations.map((s) => [s.id, s]));
  const patternById = new Map(net.patterns.map((p) => [p.id, p]));
  const transferByPair = new Map<string, TransferEdge>();
  const busByPair = new Map<string, TransferEdge>();
  for (const t of net.transfers) {
    const k = `${t.from}|${t.to}`;
    if (t.kind === 'bus') {
      busByPair.set(k, t);
      continue; // a bus is never an implicit transfer between rides
    }
    const prev = transferByPair.get(k);
    if (!prev || t.sec < prev.sec) transferByPair.set(k, t);
  }
  const patternsByStation = new Map<string, { pattern: Pattern; index: number }[]>();
  for (const p of net.patterns) {
    p.stations.forEach((sid, index) => {
      let arr = patternsByStation.get(sid);
      if (!arr) patternsByStation.set(sid, (arr = []));
      arr.push({ pattern: p, index });
    });
  }
  const recordStationIds = new Set(
    net.stations.filter((s) => s.countsTowardRecord).map((s) => s.id),
  );
  const allStationIds = new Set(net.stations.map((s) => s.id));
  return { net, stationById, patternById, transferByPair, busByPair, patternsByStation, recordStationIds, allStationIds };
}

export function transferBetween(idx: NetworkIndex, a: string, b: string): TransferEdge | null {
  return idx.transferByPair.get(`${a}|${b}`) ?? idx.transferByPair.get(`${b}|${a}`) ?? null;
}

export function busBetween(idx: NetworkIndex, a: string, b: string): TransferEdge | null {
  return idx.busByPair.get(`${a}|${b}`) ?? idx.busByPair.get(`${b}|${a}`) ?? null;
}

/** bus ride/headway at (day, band) with the same nearest-band / nearest-day
 *  fallback rides get; null where the route never runs */
export function busTimingAt(edge: TransferEdge, day: ServiceDay, band: BandIndex):
  { rideSec: number; headwaySec: number | null } | null {
  const pick = (vals: (number | null)[] | undefined): number | null => {
    if (!vals) return null;
    if (vals[band] != null) return vals[band];
    for (let off = 1; off < 5; off++) {
      for (const b of [band + off, band - off]) {
        if (b >= 0 && b < 5 && vals[b] != null) return vals[b];
      }
    }
    return null;
  };
  const order: ServiceDay[] = day === 'Weekday'
    ? ['Weekday', 'Saturday', 'Sunday']
    : day === 'Saturday' ? ['Saturday', 'Sunday', 'Weekday'] : ['Sunday', 'Saturday', 'Weekday'];
  for (const d of order) {
    const bands = edge.busService?.[d];
    const ride = pick(bands?.rideSec);
    if (ride != null) return { rideSec: ride, headwaySec: pick(bands?.headwaySec) };
  }
  // hand-drafted edge with no GTFS bands: use flat sec, pessimistic headway
  return edge.sec > 0 ? { rideSec: edge.sec, headwaySec: null } : null;
}

export function walkEstimateSec(idx: NetworkIndex, a: string, b: string): number {
  const sa = idx.stationById.get(a);
  const sb = idx.stationById.get(b);
  if (!sa || !sb) return 600;
  const m = haversineMeters(sa.lat, sa.lon, sb.lat, sb.lon) * WALK_PATH_FACTOR;
  return Math.round(m / WALK_SPEED_MPS);
}

/** travel seconds for hop i of pattern, with graceful fallback across bands
 *  and days when the exact (day, band) cell has no scheduled data */
export function hopTravel(p: Pattern, i: number, day: ServiceDay, band: BandIndex):
  { sec: number; exact: boolean } | null {
  const tryDay = (d: ServiceDay): { sec: number; exact: boolean } | null => {
    const vals = p.hops[i]?.[d];
    if (!vals) return null;
    if (vals[band] != null) return { sec: vals[band]!, exact: d === day };
    // nearest band with data
    for (let off = 1; off < 5; off++) {
      for (const b of [band + off, band - off]) {
        if (b >= 0 && b < 5 && vals[b] != null) return { sec: vals[b]!, exact: false };
      }
    }
    return null;
  };
  const order: ServiceDay[] = day === 'Weekday'
    ? ['Weekday', 'Saturday', 'Sunday']
    : day === 'Saturday' ? ['Saturday', 'Sunday', 'Weekday'] : ['Sunday', 'Saturday', 'Weekday'];
  for (const d of order) {
    const r = tryDay(d);
    if (r) return r;
  }
  return null;
}

export function headwayAt(p: Pattern, day: ServiceDay, band: BandIndex):
  { runs: boolean; headwaySec: number | null } {
  const bands = p.service[day];
  if (!bands) return { runs: false, headwaySec: null };
  const b = bands[band];
  return { runs: b.runs, headwaySec: b.headwaySec };
}

/** first departure >= target in a sorted minutes array, as seconds; null if
 *  the array is exhausted */
function searchDeps(deps: number[], targetSec: number): number | null {
  let lo = 0;
  let hi = deps.length;
  const targetMin = targetSec / 60;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (deps[mid] < targetMin) lo = mid + 1;
    else hi = mid;
  }
  return lo < deps.length ? deps[lo] * 60 : null;
}

/**
 * Next scheduled departure of pattern `p` at stop `stopIndex`, at or after
 * clock `t` (seconds past midnight of the start service day, may exceed
 * 86400). Returns the departure in the same clock frame, 'stranded' when the
 * pattern has departure data but none remains in the service day, or null
 * when the network has no departure data for this pattern (old network.json).
 */
export function nextDeparture(
  p: Pattern, stopIndex: number, startDay: ServiceDay, t: number,
): number | 'stranded' | null {
  if (!p.departures) return null;
  // express t in the GTFS frame of the service day in effect (6am boundary,
  // mirroring serviceDayAt): localT may run past 86400 for 24:xx+ trips
  const offset = Math.max(0, Math.floor((t - 6 * 3600) / DAY));
  const day = serviceDayAt(startDay, t);
  const localT = t - offset * DAY;
  let sawData = false;
  let best: number | null = null;
  const deps = p.departures[day]?.[stopIndex];
  if (deps?.length) {
    sawData = true;
    const d = searchDeps(deps, localT);
    if (d != null) best = d + offset * DAY;
  }
  // before 6am the previous service day's 24:xx+ trips are still running;
  // Sun->Sat is exact, the Weekday cases approximate (same limitation as
  // serviceDayAt — the planner picks the start day to match the date)
  if (localT < 6 * 3600 && offset === 0) {
    const prev: Record<ServiceDay, ServiceDay> =
      { Weekday: 'Weekday', Saturday: 'Weekday', Sunday: 'Saturday' };
    const pdeps = p.departures[prev[startDay]]?.[stopIndex];
    if (pdeps?.length) {
      sawData = true;
      const d = searchDeps(pdeps, localT + DAY);
      if (d != null && (best === null || d - DAY < best)) best = d - DAY;
    }
  }
  if (best != null) return best;
  return sawData ? 'stranded' : null;
}

function waitSeconds(policy: WaitPolicy | undefined, headway: number | null): number {
  const h = headway ?? 1800;
  // default is 'zero' (timed): assume the connection is timed and you board on
  // arrival. The boarding wait is purely this term — per-station ride time comes
  // from the GTFS hop data, which already includes dwell. riskSec still carries
  // the full headway so the cost of missing a timed connection stays visible.
  if (policy === undefined || policy === 'zero') return 0;
  if (policy === 'half') return Math.round(h / 2);
  if (policy === 'full') return h;
  return policy;
}

/** stations an express leg passes without stopping — estimated as the stops
 *  of the densest local pattern (any route, same direction) between each pair
 *  of consecutive express stops; express routes are often separate GTFS
 *  route_ids (6 vs 6X), so we cannot restrict to the same route */
function passThroughStations(idx: NetworkIndex, p: Pattern, fromI: number, toI: number): string[] {
  const out: string[] = [];
  for (let i = fromI; i < toI; i++) {
    const from = p.stations[i];
    const to = p.stations[i + 1];
    let best: string[] = [];
    for (const { pattern: q, index: a } of idx.patternsByStation.get(from) ?? []) {
      if (q.id === p.id || q.direction !== p.direction) continue;
      const b = q.stations.indexOf(to);
      if (b > a + 1 && b - a - 1 > best.length) best = q.stations.slice(a + 1, b);
    }
    out.push(...best);
  }
  return out;
}

export function evaluatePlan(
  idx: NetworkIndex, plan: Plan, alreadyCovered?: Iterable<string>,
): PlanResult {
  const covered = new Set<string>(alreadyCovered ?? []);
  const targetIds = plan.config.includeSIR ? idx.allStationIds : idx.recordStationIds;
  const cover = (sid: string, newly: string[]) => {
    if (targetIds.has(sid) && !covered.has(sid)) {
      covered.add(sid);
      newly.push(sid);
    }
  };

  let t = plan.startClockSec;
  let loc: string | null = plan.startStationId;
  const startNewly: string[] = [];
  if (loc) cover(loc, startNewly);

  const results: LegResult[] = [];
  let errorCount = 0;

  for (const leg of plan.legs) {
    const r: LegResult = {
      legId: leg.id, startSec: t, transferSec: 0, waitSec: 0, moveSec: 0,
      departSec: t, arriveSec: t, newlyCovered: [], riskSec: null,
      perStop: [], errors: [], warnings: [], endStationId: loc,
    };

    if (leg.type === 'wait') {
      r.moveSec = leg.sec;
      r.arriveSec = t + leg.sec;
      t = r.arriveSec;
      r.departSec = r.startSec;
    } else if (leg.type === 'bus') {
      if (loc !== null && loc !== leg.fromStationId) {
        r.warnings.push(`leg starts at ${name(idx, leg.fromStationId)} but you are at ${name(idx, loc)}`);
      }
      const edge = busBetween(idx, leg.fromStationId, leg.toStationId);
      const timing = edge ? busTimingAt(edge, serviceDayAt(plan.serviceDay, t), bandOf(t)) : null;
      if (!edge || !timing) {
        r.errors.push(`no bus edge ${name(idx, leg.fromStationId)} → ${name(idx, leg.toStationId)} (define one in Shortcuts)`);
      }
      r.transferSec = edge?.accessSec ?? 120; // walk to the stop
      t += r.transferSec;
      const headway = timing?.headwaySec ?? 1800;
      r.riskSec = headway;
      // pessimistic by default: buses bunch and don't show up
      r.waitSec = waitSeconds(leg.wait ?? 'full', headway);
      t += r.waitSec;
      r.departSec = t;
      r.moveSec = leg.sec ?? timing?.rideSec
        ?? Math.round(walkEstimateSec(idx, leg.fromStationId, leg.toStationId) / 3);
      r.arriveSec = t + r.moveSec;
      t = r.arriveSec;
      loc = leg.toStationId;
      r.endStationId = loc;
      cover(loc, r.newlyCovered);
      r.warnings.push(`HIGH RISK bus leg${edge?.routeLabel ? ` (${edge.routeLabel})` : ''} — attach a rail fallback contingency`);
      if (edge && !edge.confirmed) r.warnings.push('unconfirmed bus edge — scout stop locations before relying on it');
    } else if (leg.type !== 'ride') {
      if (loc !== null && loc !== leg.fromStationId) {
        r.warnings.push(`leg starts at ${name(idx, leg.fromStationId)} but you are at ${name(idx, loc)}`);
      }
      let sec = leg.sec;
      const edge = transferBetween(idx, leg.fromStationId, leg.toStationId);
      if (sec == null) {
        sec = edge && edge.kind !== 'in_system'
          ? edge.sec
          : walkEstimateSec(idx, leg.fromStationId, leg.toStationId);
      }
      if (edge && edge.kind === 'walk' && edge.confirmed === false) {
        r.warnings.push('unconfirmed walk edge — scout the street route before relying on it');
      }
      r.moveSec = Math.round(sec * plan.config.walkPaceMultiplier);
      r.departSec = t;
      r.arriveSec = t + r.moveSec;
      t = r.arriveSec;
      loc = leg.toStationId;
      r.endStationId = loc;
      cover(loc, r.newlyCovered);
    } else {
      // ride
      const p = idx.patternById.get(leg.patternId);
      if (!p) {
        r.errors.push(`unknown pattern ${leg.patternId}`);
        results.push(r);
        errorCount++;
        continue;
      }
      const bi = p.stations.indexOf(leg.boardStationId);
      const ai = p.stations.indexOf(leg.alightStationId);
      if (bi < 0 || ai < 0 || ai <= bi) {
        r.errors.push(`${p.label}: invalid board/alight (${name(idx, leg.boardStationId)} → ${name(idx, leg.alightStationId)})`);
        results.push(r);
        errorCount++;
        continue;
      }

      // transfer walk to the boarding station
      if (loc !== null && loc !== leg.boardStationId) {
        const edge = transferBetween(idx, loc, leg.boardStationId);
        if (edge) {
          r.transferSec = edge.kind === 'in_system'
            ? edge.sec
            : Math.round(edge.sec * plan.config.walkPaceMultiplier);
        } else {
          r.transferSec = Math.round(
            walkEstimateSec(idx, loc, leg.boardStationId) * plan.config.walkPaceMultiplier);
          r.errors.push(`no transfer edge ${name(idx, loc)} → ${name(idx, leg.boardStationId)} (using ${Math.round(r.transferSec / 60)} min walk estimate)`);
        }
      } else if (loc !== null && results.length > 0) {
        // same-station transfer between trains still takes time
        const self = transferBetween(idx, loc, loc);
        if (self) r.transferSec = self.sec;
      }
      t += r.transferSec;

      // wait for the train
      const day = serviceDayAt(plan.serviceDay, t);
      const band = bandOf(t);
      const svc = headwayAt(p, day, band);
      // riskSec always carries the headway: even when schedule mode pins the
      // exact departure, missing it costs a headway (overnight legs keep
      // their risk flag regardless of mode)
      r.riskSec = svc.headwaySec;
      const cutoff = plan.config.scheduleHeadwayCutoffSec ?? DEFAULT_SCHEDULE_CUTOFF_SEC;
      // hybrid schedule mode: dense service stays statistical (½ headway);
      // sparse or not-running snaps to the next real stop_times departure.
      // An explicit per-leg numeric wait still wins — it's a deliberate note.
      const useSchedule = plan.config.scheduleMode && typeof leg.wait !== 'number'
        && (!svc.runs || svc.headwaySec == null || svc.headwaySec > cutoff);
      let resolved = false;
      if (useSchedule) {
        const dep = nextDeparture(p, bi, plan.serviceDay, t);
        if (dep === 'stranded') {
          r.errors.push(`stranded — last train missed: no ${p.routeId} departure left at ${name(idx, leg.boardStationId)} after ${fmtClock(t)} (${day})`);
          r.waitSec = svc.headwaySec ?? 1800; // keep the clock moving
          resolved = true;
        } else if (dep !== null) {
          r.waitSec = dep - t;
          r.scheduledDepSec = dep;
          if (!svc.runs) {
            r.warnings.push(`${p.label}: no ${BAND_NAMES[band]} service on ${day} — holding for the ${fmtClock(dep)} departure`);
          }
          resolved = true;
        }
        // dep === null: no departure data in the network; fall through
      }
      if (!resolved) {
        if (!svc.runs) {
          r.errors.push(`${p.label} does not run in the ${BAND_NAMES[band]} band on ${day} (at ${fmtClock(t)})`);
        }
        r.waitSec = plan.config.scheduleMode && typeof leg.wait !== 'number'
          ? Math.round((svc.headwaySec ?? 1800) / 2)
          : waitSeconds(leg.wait, svc.headwaySec);
      }
      t += r.waitSec;
      r.departSec = t;

      // ride hop by hop, band advancing with the clock
      cover(p.stations[bi], r.newlyCovered);
      r.perStop.push({ stationId: p.stations[bi], arriveSec: t });
      for (let i = bi; i < ai; i++) {
        const d = serviceDayAt(plan.serviceDay, t);
        const tr = hopTravel(p, i, d, bandOf(t));
        if (tr === null) {
          r.errors.push(`no travel-time data ${name(idx, p.stations[i])} → ${name(idx, p.stations[i + 1])}`);
          t += 120; // keep the clock moving
        } else {
          t += tr.sec;
        }
        const sid = p.stations[i + 1];
        r.perStop.push({ stationId: sid, arriveSec: t });
        cover(sid, r.newlyCovered);
      }
      if (plan.config.passThroughCounts) {
        for (const sid of passThroughStations(idx, p, bi, ai)) cover(sid, r.newlyCovered);
      }
      r.moveSec = t - r.departSec;
      r.arriveSec = t;
      loc = leg.alightStationId;
      r.endStationId = loc;
    }

    if (r.errors.length) errorCount += r.errors.length;
    results.push(r);
  }

  const uncovered = [...targetIds].filter((s) => !covered.has(s));
  return {
    legs: results,
    coveredCount: covered.size,
    totalToCover: targetIds.size,
    covered: [...covered],
    uncovered,
    startSec: plan.startClockSec,
    endSec: t,
    elapsedSec: t - plan.startClockSec,
    errorCount,
  };
}

function name(idx: NetworkIndex, sid: string): string {
  return idx.stationById.get(sid)?.name ?? sid;
}

/** valid next options from a station at clock t — drives "smart leg entry" */
export function optionsFrom(
  idx: NetworkIndex, stationId: string, startDay: ServiceDay, t: number,
): { rides: { pattern: Pattern; index: number; headwaySec: number | null }[]; walks: TransferEdge[] } {
  const day = serviceDayAt(startDay, t);
  const band = bandOf(t);
  const rides = (idx.patternsByStation.get(stationId) ?? [])
    .filter(({ pattern, index }) => index < pattern.stations.length - 1)
    .map(({ pattern, index }) => ({ pattern, index, headwaySec: headwayAt(pattern, day, band).headwaySec }))
    .filter(({ pattern }) => headwayAt(pattern, day, band).runs)
    .sort((a, b) => (a.headwaySec ?? 1e9) - (b.headwaySec ?? 1e9));
  const walks = idx.net.transfers.filter(
    (tr) => (tr.from === stationId || tr.to === stationId) && tr.from !== tr.to,
  );
  return { rides, walks };
}
