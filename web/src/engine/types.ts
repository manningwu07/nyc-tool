// Network data (produced by ingest/ingest.py) -----------------------------

export type ServiceDay = 'Weekday' | 'Saturday' | 'Sunday';
export const SERVICE_DAYS: ServiceDay[] = ['Weekday', 'Saturday', 'Sunday'];

export const BAND_NAMES = ['overnight', 'am_rush', 'midday', 'pm_rush', 'evening'] as const;
export type BandIndex = 0 | 1 | 2 | 3 | 4;

export interface Station {
  id: string;
  name: string;
  borough: string;
  complexId: string;
  lat: number;
  lon: number;
  gtfsStopIds: string[];
  routes: string[];
  countsTowardRecord: boolean;
}

export interface ServiceBand {
  runs: boolean;
  headwaySec: number | null;
  trips: number;
}

export interface Pattern {
  id: string;
  routeId: string;
  direction: 'N' | 'S' | '?';
  label: string;
  stations: string[]; // ordered station ids
  /** hops[i] = travel time from stations[i] to stations[i+1]; per service day,
   *  5 entries (one per band), null where no data */
  hops: Partial<Record<ServiceDay, (number | null)[]>>[];
  service: Partial<Record<ServiceDay, ServiceBand[]>>;
  /** schedule mode: departures[day][stopIndex] = sorted departure times in
   *  minutes past midnight of the service day (>1440 for GTFS 24:xx+
   *  overnight trips); absent for hand-built fixtures / old network.json */
  departures?: Partial<Record<ServiceDay, number[][]>>;
  tripCount: number;
  shapeId: string | null;
}

/** per-band (5 entries, aligned with BAND_NAMES) bus timing for one service
 *  day; null where the bus has no scheduled service in that band */
export interface BusBands {
  rideSec: (number | null)[];
  headwaySec: (number | null)[];
}

export interface TransferEdge {
  from: string;
  to: string;
  kind: 'in_system' | 'walk' | 'bus';
  sec: number;
  notes: string;
  /** walk/bus shortcut edges start as unscouted drafts; ⚠ until confirmed
   *  by street view / physical scouting (exit choice matters — see notes) */
  confirmed?: boolean;
  /** bus only: e.g. "Q52-SBS" */
  routeLabel?: string;
  /** bus only: manual walk-to-stop buffer in seconds */
  accessSec?: number;
  /** bus only: per-day, per-band ride/headway medians from add_bus_edge.py */
  busService?: Partial<Record<ServiceDay, BusBands>>;
}

export interface RouteInfo {
  id: string;
  name: string;
  color: string;
}

export interface Network {
  generatedAt: string;
  bands: string[];
  serviceDays: ServiceDay[];
  stations: Station[];
  patterns: Pattern[];
  transfers: TransferEdge[];
  routes: RouteInfo[];
  shapes: Record<string, [number, number][]>; // [lat, lon]
}

// Plans --------------------------------------------------------------------

/** wait policy for a ride leg: zero (timed connection — the default; board on
 * arrival, no platform wait), half headway, full headway (pessimistic), or
 * explicit seconds */
export type WaitPolicy = 'half' | 'full' | 'zero' | number;

export interface RideLeg {
  id: string;
  type: 'ride';
  patternId: string;
  boardStationId: string;
  alightStationId: string;
  wait?: WaitPolicy;
}

export interface MoveLeg {
  id: string;
  type: 'walk' | 'bus';
  fromStationId: string;
  toStationId: string;
  /** manual override; otherwise transfer edge / haversine estimate */
  sec?: number;
  /** walk only: pace for THIS leg in min/mile (plug in real-world numbers —
   *  traffic lights, stairs, cardio). Beats the plan-wide pace multiplier;
   *  an explicit `sec` still beats both. */
  paceMinPerMi?: number;
  /** bus only: wait policy at the stop; defaults to 'full' (pessimistic —
   *  buses bunch and sit in traffic) */
  wait?: WaitPolicy;
}

export interface BufferLeg {
  id: string;
  type: 'wait';
  sec: number;
}

export type Leg = RideLeg | MoveLeg | BufferLeg;

export interface ContingencyBranch {
  id: string;
  name: string;
  /** surfaced in live mode when drift at this leg exceeds the threshold */
  driftThresholdSec: number;
  legs: Leg[];
}

export interface PlanConfig {
  passThroughCounts: boolean; // default false
  walkPaceMultiplier: number; // default 0.8 (we'll be sprinting)
  /** count Staten Island Railway stations toward coverage (target 493
   *  instead of the Guinness-official 472); default false */
  includeSIR?: boolean;
  /** hybrid schedule mode: dense service (headway ≤ cutoff) keeps the
   *  statistical ½-headway wait; sparse service snaps to the next actual
   *  stop_times departure, and a missed last train is a hard error */
  scheduleMode?: boolean;
  /** headway above which schedule mode uses real departures; default 720 */
  scheduleHeadwayCutoffSec?: number;
}

export interface Plan {
  id: string;
  name: string;
  startStationId: string;
  /** seconds after midnight of the service day (may exceed 86400) */
  startClockSec: number;
  serviceDay: ServiceDay;
  legs: Leg[];
  contingencies: Record<string, ContingencyBranch[]>; // legId -> branches
  config: PlanConfig;
}

// Evaluation results ---------------------------------------------------------

export interface StopTime {
  stationId: string;
  arriveSec: number;
}

export interface LegResult {
  legId: string;
  /** clock when we start handling this leg (= previous arrive) */
  startSec: number;
  transferSec: number;
  waitSec: number;
  moveSec: number; // ride or walk/bus duration
  departSec: number; // board / start walking
  arriveSec: number;
  newlyCovered: string[];
  /** cost of missing one train here (headway at boarding) */
  riskSec: number | null;
  /** schedule mode: clock sec of the actual departure this leg snapped to;
   *  unset when the wait came from headway statistics */
  scheduledDepSec?: number;
  perStop: StopTime[];
  errors: string[];
  warnings: string[];
  endStationId: string | null;
}

export interface PlanResult {
  legs: LegResult[];
  coveredCount: number;
  totalToCover: number;
  covered: string[];
  uncovered: string[];
  startSec: number;
  endSec: number;
  elapsedSec: number;
  errorCount: number;
}
