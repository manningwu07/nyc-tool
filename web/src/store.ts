// App state: plans, segments, custom walk edges, live-run state.
// Persisted to localStorage on every change (also our offline store).
import { useSyncExternalStore } from 'react';
import type { ContingencyBranch, Leg, Plan, PlanResult, ServiceDay, TransferEdge } from './engine/types';
import type { Attempt } from './attempts';
import { planSignature, pruneAttempts } from './attempts';

export interface Segment {
  id: string;
  name: string;
  legs: Leg[];
}

export type RunEvent =
  | { kind: 'start'; atMs: number }
  | { kind: 'arrived'; atMs: number; legId: string; stationId: string | null }
  | { kind: 'boarded'; atMs: number; legId: string }
  | { kind: 'missed'; atMs: number; legId: string; headwaySec: number }
  | { kind: 'contingency'; atMs: number; legId: string; branchName: string }
  | { kind: 'edit'; atMs: number; note: string };

export interface RunState {
  planId: string;
  /** ms epoch of midnight of the service day the run started on */
  dayStartMs: number;
  startedAtMs: number;
  /** index into plan.legs of the leg currently being executed */
  currentLegIndex: number;
  /** extra wait (sec) added to specific legs by "missed train" taps */
  extraWaitSec: Record<string, number>;
  /** actual clock sec when the current leg was reached (drives retiming) */
  lastEventClockSec: number;
  log: RunEvent[];
  finished: boolean;
}

export interface AppState {
  plans: Plan[];
  activePlanId: string | null;
  comparePlanId: string | null;
  segments: Segment[];
  /** route attempts, auto-pruned to top 3 best + 2 latest */
  attempts: Attempt[];
  customTransfers: TransferEdge[];
  mode: 'plan' | 'run';
  run: RunState | null;
  selectedStationId: string | null;
}

const STORAGE_KEY = 'subway-speedrun-v1';

function freshPlan(name = 'Plan 1'): Plan {
  return {
    id: uid(),
    name,
    startStationId: '',
    startClockSec: 6 * 3600,
    serviceDay: 'Weekday',
    legs: [],
    contingencies: {},
    config: { passThroughCounts: false, walkPaceMultiplier: 0.8 },
  };
}

function load(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as AppState;
      s.selectedStationId = null;
      s.attempts ??= [];
      s.attempts.forEach((a) => { a.signature ??= planSignature(a.plan); });
      return s;
    }
  } catch { /* fall through to fresh state */ }
  const p = freshPlan();
  return {
    plans: [p], activePlanId: p.id, comparePlanId: null, segments: [],
    attempts: [], customTransfers: [], mode: 'plan', run: null, selectedStationId: null,
  };
}

let state: AppState = load();
const listeners = new Set<() => void>();

function emit() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, selectedStationId: null }));
  } catch { /* storage full/unavailable: state stays in memory */ }
  listeners.forEach((l) => l());
}

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  emit();
}

export function useAppState(): AppState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// --- plan operations -------------------------------------------------------

export function activePlan(s: AppState = state): Plan | null {
  return s.plans.find((p) => p.id === s.activePlanId) ?? null;
}

export function updatePlan(planId: string, fn: (p: Plan) => Plan) {
  setState((s) => ({ plans: s.plans.map((p) => (p.id === planId ? fn(p) : p)) }));
}

export function updateActivePlan(fn: (p: Plan) => Plan) {
  const p = activePlan();
  if (p) updatePlan(p.id, fn);
}

export function addLeg(leg: Leg, atIndex?: number) {
  updateActivePlan((p) => {
    const legs = [...p.legs];
    legs.splice(atIndex ?? legs.length, 0, leg);
    return { ...p, legs };
  });
}

export function removeLeg(legId: string) {
  removeLegs([legId]);
}

/** delete several legs at once (multiselect), dropping their contingencies too */
export function removeLegs(legIds: string[]) {
  const drop = new Set(legIds);
  if (drop.size === 0) return;
  updateActivePlan((p) => {
    const cont = { ...p.contingencies };
    for (const id of drop) delete cont[id];
    return { ...p, legs: p.legs.filter((l) => !drop.has(l.id)), contingencies: cont };
  });
}

export function moveLeg(legId: string, toIndex: number) {
  updateActivePlan((p) => {
    const legs = [...p.legs];
    const from = legs.findIndex((l) => l.id === legId);
    if (from < 0) return p;
    const [leg] = legs.splice(from, 1);
    legs.splice(toIndex > from ? toIndex - 1 : toIndex, 0, leg);
    return { ...p, legs };
  });
}

export function updateLeg(legId: string, patch: Partial<Leg>) {
  updateActivePlan((p) => ({
    ...p,
    legs: p.legs.map((l) => (l.id === legId ? ({ ...l, ...patch } as Leg) : l)),
  }));
}

export function newPlan(name: string) {
  const p = freshPlan(name);
  setState((s) => ({ plans: [...s.plans, p], activePlanId: p.id }));
  return p;
}

export function duplicateActivePlan() {
  const p = activePlan();
  if (!p) return;
  const copy: Plan = JSON.parse(JSON.stringify(p));
  copy.id = uid();
  copy.name = `${p.name} (copy)`;
  setState((s) => ({ plans: [...s.plans, copy], activePlanId: copy.id }));
}

export function deletePlan(planId: string) {
  setState((s) => {
    const plans = s.plans.filter((p) => p.id !== planId);
    const fallback = plans[0] ?? freshPlan();
    if (plans.length === 0) plans.push(fallback);
    return {
      plans,
      activePlanId: s.activePlanId === planId ? fallback.id : s.activePlanId,
      comparePlanId: s.comparePlanId === planId ? null : s.comparePlanId,
    };
  });
}

export function importPlan(json: string) {
  const p = JSON.parse(json) as Plan;
  p.id = uid();
  p.contingencies ??= {};
  setState((s) => ({ plans: [...s.plans, p], activePlanId: p.id }));
}

// --- segments ---------------------------------------------------------------

export function saveSegment(name: string, legs: Leg[]) {
  const seg: Segment = { id: uid(), name, legs: JSON.parse(JSON.stringify(legs)) };
  setState((s) => ({ segments: [...s.segments, seg] }));
}

export function spliceSegment(segId: string, atIndex?: number) {
  const seg = state.segments.find((g) => g.id === segId);
  if (!seg) return;
  updateActivePlan((p) => {
    const legs = [...p.legs];
    const fresh = seg.legs.map((l) => ({ ...l, id: uid() } as Leg));
    legs.splice(atIndex ?? legs.length, 0, ...fresh);
    return { ...p, legs };
  });
}

export function deleteSegment(segId: string) {
  setState((s) => ({ segments: s.segments.filter((g) => g.id !== segId) }));
}

export function attachContingency(legId: string, branch: ContingencyBranch) {
  updateActivePlan((p) => ({
    ...p,
    contingencies: {
      ...p.contingencies,
      [legId]: [...(p.contingencies[legId] ?? []), branch],
    },
  }));
}

export function removeContingency(legId: string, branchId: string) {
  updateActivePlan((p) => ({
    ...p,
    contingencies: {
      ...p.contingencies,
      [legId]: (p.contingencies[legId] ?? []).filter((b) => b.id !== branchId),
    },
  }));
}

// --- attempts ----------------------------------------------------------------

export function recordAttempt(plan: Plan, result: PlanResult) {
  const signature = planSignature(plan);
  setState((s) => {
    const existing = s.attempts.find((x) => x.signature === signature);
    const a: Attempt = {
      id: existing?.id ?? uid(),
      signature,
      savedAtMs: Date.now(),
      plan: JSON.parse(JSON.stringify(plan)),
      coveredCount: result.coveredCount,
      totalToCover: result.totalToCover,
      elapsedSec: result.elapsedSec,
      endSec: result.endSec,
      errorCount: result.errorCount,
    };
    return { attempts: pruneAttempts([...s.attempts.filter((x) => x.id !== a.id), a]) };
  });
}

export function deleteAttempt(id: string) {
  setState((s) => ({ attempts: s.attempts.filter((a) => a.id !== id) }));
}

/** copy an attempt's plan snapshot back into the plan list and open it */
export function restoreAttempt(id: string) {
  const a = state.attempts.find((x) => x.id === id);
  if (!a) return;
  const copy: Plan = JSON.parse(JSON.stringify(a.plan));
  copy.id = uid();
  copy.name = `${a.plan.name} (restored)`;
  setState((s) => ({ plans: [...s.plans, copy], activePlanId: copy.id }));
}

// --- custom walk edges -------------------------------------------------------

export function addCustomTransfer(edge: TransferEdge) {
  setState((s) => ({ customTransfers: [...s.customTransfers, edge] }));
}

export function removeCustomTransfer(i: number) {
  setState((s) => ({ customTransfers: s.customTransfers.filter((_, j) => j !== i) }));
}

export function updateCustomTransfer(i: number, patch: Partial<TransferEdge>) {
  setState((s) => ({
    customTransfers: s.customTransfers.map((e, j) => (j === i ? { ...e, ...patch } : e)),
  }));
}

// --- run mode ----------------------------------------------------------------

export function clockSecNow(run: RunState): number {
  return Math.round((Date.now() - run.dayStartMs) / 1000);
}

export function startRun(planId: string, serviceDay: ServiceDay) {
  void serviceDay;
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const run: RunState = {
    planId,
    dayStartMs: dayStart,
    startedAtMs: Date.now(),
    currentLegIndex: 0,
    extraWaitSec: {},
    lastEventClockSec: Math.round((Date.now() - dayStart) / 1000),
    log: [{ kind: 'start', atMs: Date.now() }],
    finished: false,
  };
  setState({ run, mode: 'run', activePlanId: planId });
}

export function logRunEvent(ev: RunEvent, patch?: Partial<RunState>) {
  setState((s) => {
    if (!s.run) return {};
    return {
      run: {
        ...s.run,
        ...patch,
        lastEventClockSec: Math.round((ev.atMs - s.run.dayStartMs) / 1000),
        log: [...s.run.log, ev],
      },
    };
  });
}

export function exitRun() {
  setState({ mode: 'plan' });
}
