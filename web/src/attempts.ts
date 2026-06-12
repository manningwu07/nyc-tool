// Route attempts: snapshots of a plan + its evaluation, kept as
// top 3 best + 2 most recent, and CSV export (Google Sheets imports CSV
// directly via File > Import or drag-and-drop).
import type { Leg, Plan, PlanResult } from './engine/types';
import { fmtClock, fmtDur } from './engine/time';

export interface Attempt {
  id: string;
  /** content signature — re-saving an identical route updates in place */
  signature: string;
  savedAtMs: number;
  plan: Plan;
  coveredCount: number;
  totalToCover: number;
  elapsedSec: number;
  endSec: number;
  errorCount: number;
}

/** route content signature for autosave dedupe; leg ids are excluded because
 *  segment splicing and restores regenerate them without changing the route */
export function planSignature(plan: Plan): string {
  return JSON.stringify([
    plan.startStationId, plan.startClockSec, plan.serviceDay, plan.config,
    plan.legs.map(({ id: _id, ...rest }) => rest),
  ]);
}

/** best = most coverage, then fewest errors, then fastest */
export function rankAttempts(attempts: Attempt[]): Attempt[] {
  return [...attempts].sort((a, b) =>
    b.coveredCount - a.coveredCount
    || a.errorCount - b.errorCount
    || a.elapsedSec - b.elapsedSec);
}

export const KEEP_BEST = 3;
export const KEEP_LATEST = 2;

/** keep the union of the top 3 best and the 2 most recently saved */
export function pruneAttempts(attempts: Attempt[]): Attempt[] {
  const keep = new Set<string>();
  for (const a of rankAttempts(attempts).slice(0, KEEP_BEST)) keep.add(a.id);
  for (const a of [...attempts].sort((x, y) => y.savedAtMs - x.savedAtMs).slice(0, KEEP_LATEST)) {
    keep.add(a.id);
  }
  return attempts.filter((a) => keep.has(a.id));
}

export function attemptTags(attempts: Attempt[], id: string): string[] {
  const tags: string[] = [];
  const bestIdx = rankAttempts(attempts).findIndex((a) => a.id === id);
  if (bestIdx >= 0 && bestIdx < KEEP_BEST) tags.push(`best #${bestIdx + 1}`);
  const latIdx = [...attempts].sort((x, y) => y.savedAtMs - x.savedAtMs).findIndex((a) => a.id === id);
  if (latIdx >= 0 && latIdx < KEEP_LATEST) tags.push('latest');
  return tags;
}

// --- CSV ---------------------------------------------------------------------

function esc(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

export interface CsvLookup {
  stationName: (sid: string | null | undefined) => string;
  routeOfPattern: (patternId: string) => string;
}

/** leg-by-leg schedule of one evaluated plan, ready for Google Sheets */
export function planResultCsv(plan: Plan, result: PlanResult, lk: CsvLookup): string {
  const rows: (string | number)[][] = [
    ['plan', plan.name],
    ['service day', plan.serviceDay],
    ['start', fmtClock(result.startSec)],
    ['finish', fmtClock(result.endSec)],
    ['elapsed', fmtDur(result.elapsedSec)],
    ['elapsed_sec', result.elapsedSec],
    ['covered', `${result.coveredCount}/${result.totalToCover}`],
    ['errors', result.errorCount],
    [],
    ['leg', 'type', 'route', 'from', 'to', 'depart', 'arrive',
      'wait_sec', 'move_sec', 'new_stations', 'cumulative_covered', 'notes'],
  ];
  let cum = 0;
  result.legs.forEach((lr, i) => {
    const leg = plan.legs.find((l) => l.id === lr.legId);
    cum += lr.newlyCovered.length;
    rows.push([
      i + 1,
      leg?.type ?? '?',
      leg?.type === 'ride' ? lk.routeOfPattern(leg.patternId) : '',
      lk.stationName(legFrom(leg)),
      lk.stationName(lr.endStationId),
      fmtClock(lr.departSec),
      fmtClock(lr.arriveSec),
      lr.waitSec,
      lr.moveSec,
      lr.newlyCovered.length,
      cum,
      [...lr.errors, ...lr.warnings].join('; '),
    ]);
  });
  return toCsv(rows);
}

function legFrom(leg: Leg | undefined): string | null {
  if (!leg) return null;
  if (leg.type === 'ride') return leg.boardStationId;
  if (leg.type === 'wait') return null;
  return leg.fromStationId;
}

/** one row per saved attempt — paste into Sheets to compare routes tried */
export function attemptsCsv(attempts: Attempt[]): string {
  const rows: (string | number)[][] = [
    ['saved_at', 'plan', 'covered', 'total', 'elapsed', 'elapsed_sec',
      'finish', 'legs', 'errors', 'tags'],
  ];
  for (const a of rankAttempts(attempts)) {
    rows.push([
      new Date(a.savedAtMs).toISOString(),
      a.plan.name,
      a.coveredCount,
      a.totalToCover,
      fmtDur(a.elapsedSec),
      a.elapsedSec,
      fmtClock(a.endSec),
      a.plan.legs.length,
      a.errorCount,
      attemptTags(attempts, a.id).join(' / '),
    ]);
  }
  return toCsv(rows);
}

export function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
