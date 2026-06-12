import type { BandIndex, ServiceDay } from './types';
import { SERVICE_DAYS } from './types';

export const DAY = 86400;

/** time band of a clock value (seconds, may exceed 86400 for past-midnight) */
export function bandOf(sec: number): BandIndex {
  const h = Math.floor((((sec % DAY) + DAY) % DAY) / 3600);
  if (h < 6) return 0; // overnight
  if (h < 10) return 1; // am_rush
  if (h < 16) return 2; // midday
  if (h < 20) return 3; // pm_rush
  return 4; // evening
}

/**
 * Service day in effect at clock `t` for a plan that started on `startDay`.
 * GTFS overnight service (24:xx) belongs to the previous service day, so the
 * boundary is 6am: a Saturday run that drifts past 6am Sunday is on Sunday
 * service.
 */
export function serviceDayAt(startDay: ServiceDay, t: number): ServiceDay {
  const offset = Math.max(0, Math.floor((t - 6 * 3600) / DAY));
  if (offset === 0) return startDay;
  // Weekday->Weekday is the common case (Mon-Thu nights); Fri->Sat and
  // Sun->Mon are not representable without a concrete weekday — planner
  // picks the start day to match the attempt date.
  const order: Record<ServiceDay, ServiceDay> = {
    Weekday: 'Weekday',
    Saturday: 'Sunday',
    Sunday: 'Weekday',
  };
  let d = startDay;
  for (let i = 0; i < offset; i++) d = order[d];
  return d;
}

export function fmtClock(sec: number): string {
  const s = ((sec % DAY) + DAY) % DAY;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function fmtDur(sec: number): string {
  const s = Math.round(Math.abs(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const sign = sec < 0 ? '-' : '';
  if (h > 0) return `${sign}${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${sign}${m}:${String(ss).padStart(2, '0')}`;
}

export function parseClock(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export { SERVICE_DAYS };
