import type { BandIndex, CalendarDay, ServiceDay, StartDay } from './types';
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
 * Calendar day in effect at clock `t` for a plan that started on `startDay`.
 * `t` is an unbounded clock, so each midnight advances to the next real day.
 */
export function calendarDayAt(startDay: StartDay, t: number): CalendarDay {
  const days: CalendarDay[] = [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  ];
  const normalized = startDay === 'Weekday' ? 'Monday' : startDay;
  const offset = Math.floor(t / DAY);
  return days[(days.indexOf(normalized) + offset % 7 + 7) % 7];
}

/** GTFS schedule bucket for the calendar day in effect at `t`. */
export function serviceDayAt(startDay: StartDay, t: number): ServiceDay {
  const day = calendarDayAt(startDay, t);
  return day === 'Saturday' || day === 'Sunday' ? day : 'Weekday';
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
