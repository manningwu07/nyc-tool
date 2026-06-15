import { useState } from 'react';
import type { NetworkIndex } from '../engine/engine';
import type { Leg, LegResult, Plan } from '../engine/types';
import { fmtClock, fmtDur } from '../engine/time';

export function RouteBadge({ idx, routeId }: { idx: NetworkIndex; routeId: string }) {
  const color = idx.net.routes.find((r) => r.id === routeId)?.color ?? '#555';
  return <span className="badge" style={{ background: color }}>{routeId}</span>;
}

export function stationName(idx: NetworkIndex, sid: string | null | undefined): string {
  if (!sid) return '?';
  return idx.stationById.get(sid)?.name ?? sid;
}

export function legSummary(idx: NetworkIndex, leg: Leg): { badge: string | null; text: string } {
  if (leg.type === 'ride') {
    const p = idx.patternById.get(leg.patternId);
    return {
      badge: p?.routeId ?? '?',
      text: `${stationName(idx, leg.boardStationId)} → ${stationName(idx, leg.alightStationId)}`,
    };
  }
  if (leg.type === 'wait') return { badge: null, text: `buffer ${fmtDur(leg.sec)}` };
  return {
    badge: null,
    text: `${leg.type} ${stationName(idx, leg.fromStationId)} → ${stationName(idx, leg.toStationId)}`,
  };
}

interface LegRowProps {
  idx: NetworkIndex;
  plan: Plan;
  leg: Leg;
  n: number;
  result?: LegResult;
  selected?: boolean;
  /** modifier-click (shift/cmd/ctrl) on the row — drives multiselect */
  onSelectClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode; // action buttons etc.
}

export function LegRow({ idx, leg, n, result, selected, onSelectClick, children }: LegRowProps) {
  const [open, setOpen] = useState(false);
  const { badge, text } = legSummary(idx, leg);
  const hasError = (result?.errors.length ?? 0) > 0;
  const highRisk = result?.riskSec != null && result.riskSec > 600;

  return (
    <div className={`leg${hasError ? ' error' : ''}${selected ? ' selected' : ''}`}>
      <div
        className="row1"
        onClick={(e) => {
          // shift/cmd/ctrl click selects the row instead of expanding it
          if (onSelectClick && (e.shiftKey || e.metaKey || e.ctrlKey)) {
            onSelectClick(e);
            return;
          }
          setOpen(!open);
        }}
        style={{ cursor: 'pointer' }}
      >
        <span className="muted" style={{ width: 18, textAlign: 'right' }}>{n}</span>
        {badge ? <RouteBadge idx={idx} routeId={badge} /> : <span className="badge" style={{ background: '#374151' }}>{leg.type === 'wait' ? '⏸' : '🚶'}</span>}
        <span style={{ flex: 1, minWidth: 0 }}>
          {text}
          {highRisk && <span className="risk" title="cost of missing one train"> ⚠ {fmtDur(result!.riskSec!)}</span>}
        </span>
        {result && (
          <span className="times">
            {result.scheduledDepSec != null && (
              <span title={`snapped to the scheduled ${fmtClock(result.scheduledDepSec)} departure`}>🕐 </span>
            )}
            {result.waitSec > 0 && <span>wait {fmtDur(result.waitSec)} · </span>}
            <span>{fmtDur(result.moveSec)}</span>
            <br />
            <b>{fmtClock(result.departSec)} → {fmtClock(result.arriveSec)}</b>
          </span>
        )}
      </div>
      {result?.errors.map((e, i) => <div key={i} className="err">⛔ {e}</div>)}
      {result?.warnings.map((w, i) => <div key={i} className="warn">⚠ {w}</div>)}
      {open && result && leg.type === 'ride' && (
        <div className="detail">
          {result.perStop.map((ps) => (
            <div key={ps.stationId}>
              {fmtClock(ps.arriveSec)} — {stationName(idx, ps.stationId)}
              {result.newlyCovered.includes(ps.stationId) && <span style={{ color: 'var(--green)' }}> ●new</span>}
            </div>
          ))}
        </div>
      )}
      {open && result && leg.type !== 'ride' && result.newlyCovered.length > 0 && (
        <div className="detail">covers: {result.newlyCovered.map((c) => stationName(idx, c)).join(', ')}</div>
      )}
      {open && children}
    </div>
  );
}
