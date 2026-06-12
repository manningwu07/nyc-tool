import { useState } from 'react';
import type { NetworkIndex } from '../engine/engine';
import { busBetween, optionsFrom, transferBetween, walkEstimateSec } from '../engine/engine';
import type { Pattern, Plan, PlanResult } from '../engine/types';
import { fmtClock, fmtDur } from '../engine/time';
import { addLeg, addCustomTransfer, setState, uid, updateActivePlan, useAppState } from '../store';
import { RouteBadge, stationName } from './LegRow';

interface Props {
  idx: NetworkIndex;
  plan: Plan;
  result: PlanResult | null;
}

export default function LegEntry({ idx, plan, result }: Props) {
  const s = useAppState();
  const selected = s.selectedStationId;

  const lastLeg = result?.legs[result.legs.length - 1];
  const here = lastLeg?.endStationId ?? plan.startStationId ?? null;
  const t = result?.endSec ?? plan.startClockSec;

  if (!plan.startStationId) {
    return (
      <div className="section">
        <h3>Pick a start station</h3>
        <div className="muted">Click a station on the map, then set it as the start.</div>
        {selected && (
          <button
            className="primary"
            style={{ marginTop: 8 }}
            onClick={() => updateActivePlan((p) => ({ ...p, startStationId: selected }))}
          >
            Start at {stationName(idx, selected)}
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="section">
        <h3>Current position</h3>
        <div>
          <b>{stationName(idx, here)}</b> at <b>{fmtClock(t)}</b>
          {' '}<span className="muted">({plan.serviceDay})</span>
        </div>
      </div>

      {selected && selected !== here && here && (
        <SelectedStation idx={idx} here={here} selected={selected} />
      )}

      {here && <RideOptions key={`${here}-${t}`} idx={idx} plan={plan} here={here} t={t} />}

      <div className="section">
        <h3>Other</h3>
        <button onClick={() => {
          const min = prompt('Buffer minutes:', '3');
          if (min != null) addLeg({ id: uid(), type: 'wait', sec: Math.round(Number(min) * 60) });
        }}>
          + buffer time
        </button>
      </div>
    </div>
  );
}

function SelectedStation({ idx, here, selected }: { idx: NetworkIndex; here: string; selected: string }) {
  const edge = transferBetween(idx, here, selected);
  const bus = busBetween(idx, here, selected);
  const est = edge ? edge.sec : walkEstimateSec(idx, here, selected);
  return (
    <div className="section">
      <h3>Selected: {stationName(idx, selected)}</h3>
      <div className="rowflex">
        <button onClick={() => {
          addLeg({ id: uid(), type: 'walk', fromStationId: here, toStationId: selected });
          setState({ selectedStationId: null });
        }}>
          🚶 walk there (~{fmtDur(est)}{edge ? '' : ' est.'})
        </button>
        {bus && (
          <button onClick={() => {
            addLeg({ id: uid(), type: 'bus', fromStationId: here, toStationId: selected });
            setState({ selectedStationId: null });
          }}>
            🚌 {bus.routeLabel ?? 'bus'} there{bus.confirmed ? '' : ' ⚠'}
          </button>
        )}
        {!edge && (
          <button onClick={() => {
            addCustomTransfer({
              from: here, to: selected, kind: 'walk', sec: est,
              notes: 'user-added walk edge', confirmed: false,
            });
          }}>
            + save as walk edge
          </button>
        )}
      </div>
    </div>
  );
}

function RideOptions({ idx, plan, here, t }: { idx: NetworkIndex; plan: Plan; here: string; t: number }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { rides } = optionsFrom(idx, here, plan.serviceDay, t);
  // collapse near-duplicate options: keep the most frequent pattern per (route, direction, next stop)
  const seen = new Set<string>();
  const deduped = rides.filter(({ pattern, index }) => {
    const k = `${pattern.routeId}|${pattern.direction}|${pattern.stations[index + 1]}|${pattern.stations[pattern.stations.length - 1]}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return (
    <div className="section options">
      <h3>Trains from here ({fmtClock(t)})</h3>
      {deduped.length === 0 && <div className="muted">Nothing runs from here at this time.</div>}
      {deduped.map(({ pattern, index, headwaySec }) => (
        <div key={pattern.id}>
          <div className="opt" onClick={() => setExpanded(expanded === pattern.id ? null : pattern.id)}>
            <RouteBadge idx={idx} routeId={pattern.routeId} />
            <span style={{ flex: 1 }}>
              {pattern.direction === 'N' ? '↑' : '↓'} to {stationName(idx, pattern.stations[pattern.stations.length - 1])}
              <span className="muted"> · {pattern.stations.length - 1 - index} stops left</span>
            </span>
            <span className="muted" style={{ textAlign: 'right', lineHeight: 1.25 }} title={theoreticalDepartures(t, headwaySec)}>
              {headwaySec != null
                ? <><b style={{ color: 'var(--fg, #cdd6f4)' }}>next ~{fmtClock(t + Math.round(headwaySec / 2))}</b><br /></>
                : null}
              every ~{headwaySec ? fmtDur(headwaySec) : '?'}
            </span>
          </div>
          {expanded === pattern.id && (
            <AlightPicker idx={idx} pattern={pattern} boardIndex={index} onPick={(alight) => {
              addLeg({
                id: uid(), type: 'ride', patternId: pattern.id,
                boardStationId: here, alightStationId: alight,
              });
              setExpanded(null);
            }} />
          )}
        </div>
      ))}
    </div>
  );
}

/** Tooltip text: with only headways (no scheduled phase) the honest estimate
 *  for someone arriving now is the next train at ~½ headway, then every headway
 *  after. Lists the next few so you can eyeball the theoretical timetable. */
function theoreticalDepartures(now: number, headwaySec: number | null): string {
  if (headwaySec == null) return 'no headway data — assume long, unpredictable wait';
  const first = now + Math.round(headwaySec / 2);
  const times = [0, 1, 2, 3].map((k) => fmtClock(first + k * headwaySec));
  return `theoretical departures (headway-based, no live schedule):\n~${times.join(', ~')}`;
}

function AlightPicker({ idx, pattern, boardIndex, onPick }: {
  idx: NetworkIndex; pattern: Pattern; boardIndex: number; onPick: (stationId: string) => void;
}) {
  return (
    <div style={{ margin: '4px 0 8px 30px', maxHeight: 220, overflowY: 'auto' }}>
      {pattern.stations.slice(boardIndex + 1).map((sid) => (
        <div
          key={sid}
          style={{ padding: '3px 6px', cursor: 'pointer' }}
          onClick={() => onPick(sid)}
        >
          → {stationName(idx, sid)}
        </div>
      ))}
    </div>
  );
}
