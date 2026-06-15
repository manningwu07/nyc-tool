import { useState } from 'react';
import type { NetworkIndex } from '../engine/engine';
import { busBetween, headwayAt, nextDeparture, SAME_STATION_TRANSFER_SEC, transferBetween, walkEstimateSec, walkSecAtPace } from '../engine/engine';
import type { Pattern, Plan, PlanResult, ServiceDay } from '../engine/types';
import { bandOf, fmtClock, fmtDur, serviceDayAt } from '../engine/time';
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
  // boarding a train here means a same-station platform change — unless the
  // last leg was a walk (which already put you on the platform) or this is the
  // start. Mirror the engine so the picker's departures match the plan.
  const lastLegType = plan.legs[plan.legs.length - 1]?.type;
  const transferSec = here && lastLegType && lastLegType !== 'walk' && transferBetween(idx, here, here)
    ? SAME_STATION_TRANSFER_SEC : 0;

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

      {here && <RideOptions key={`${here}-${t}`} idx={idx} plan={plan} here={here} t={t} transferSec={transferSec} />}

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
  // edge times stay normalized to the 1.4 m/s base (that's what gets saved);
  // the preview shows the 10 min/mi timing the engine will actually use
  const baseSec = edge ? edge.sec : walkEstimateSec(idx, here, selected);
  const est = walkSecAtPace(baseSec);
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
              from: here, to: selected, kind: 'walk', sec: baseSec,
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

/** trains departing more than this far out are bucketed as "not running now"
 *  rather than mixed in with the ones you can actually catch */
const RIDE_SOON_HORIZON_SEC = 60 * 60;

function RideOptions({ idx, plan, here, t, transferSec }:
  { idx: NetworkIndex; plan: Plan; here: string; t: number; transferSec: number }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showLater, setShowLater] = useState(false);
  // you can't board until you've walked to the platform — search departures
  // from the post-transfer clock so these times match the committed plan
  const boardT = t + transferSec;
  const day = serviceDayAt(plan.serviceDay, boardT);
  const band = bandOf(boardT);

  // every pattern that stops here and continues onward — rank by the REAL next
  // departure, not the coarse band "runs" flag. A line that only serves this
  // stop later in the day (e.g. the 4 runs local through the Lexington locals
  // ONLY overnight; midday it's express and skips them) still gets listed
  // instead of silently vanishing.
  const ranked = (idx.patternsByStation.get(here) ?? [])
    .filter(({ pattern, index }) => index < pattern.stations.length - 1)
    .map(({ pattern, index }) => {
      const { runs, headwaySec } = headwayAt(pattern, day, band);
      const dep = nextDeparture(pattern, index, plan.serviceDay, boardT, true);
      const sortKey = typeof dep === 'number'
        ? dep
        : dep === 'stranded' ? Infinity
          : runs ? boardT + (headwaySec ?? 1800) / 2 : Infinity;
      return { pattern, index, headwaySec, sortKey };
    })
    .sort((a, b) => a.sortKey - b.sortKey);

  // collapse near-duplicate options, keeping the soonest pattern per
  // (route, direction, next stop, terminal)
  const seen = new Set<string>();
  const deduped = ranked.filter(({ pattern, index }) => {
    const k = `${pattern.routeId}|${pattern.direction}|${pattern.stations[index + 1]}|${pattern.stations[pattern.stations.length - 1]}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const soon = deduped.filter((r) => r.sortKey - boardT <= RIDE_SOON_HORIZON_SEC);
  const later = deduped.filter((r) => r.sortKey - boardT > RIDE_SOON_HORIZON_SEC);

  const rideRow = ({ pattern, index, headwaySec }: typeof deduped[number]) => (
    <div key={pattern.id}>
      <div className="opt" onClick={() => setExpanded(expanded === pattern.id ? null : pattern.id)}>
        <RouteBadge idx={idx} routeId={pattern.routeId} />
        <span style={{ flex: 1 }}>
          {pattern.direction === 'N' ? '↑' : '↓'} to {stationName(idx, pattern.stations[pattern.stations.length - 1])}
          <span className="muted"> · {pattern.stations.length - 1 - index} stops left</span>
        </span>
        <Departures pattern={pattern} index={index} day={plan.serviceDay} t={boardT} headwaySec={headwaySec} />
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
  );

  return (
    <div className="section options">
      <h3>
        Trains from here ({fmtClock(t)})
        {transferSec > 0 && (
          <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
            {' '}· +{fmtDur(transferSec)} platform transfer → board from {fmtClock(boardT)}
          </span>
        )}
      </h3>
      {deduped.length === 0 && <div className="muted">No line serves this station.</div>}
      {soon.length === 0 && deduped.length > 0 && (
        <div className="muted">Nothing leaves within the hour — see other lines below.</div>
      )}
      {soon.map(rideRow)}
      {later.length > 0 && (
        <>
          <button
            className="muted"
            style={{ marginTop: 6, background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', textAlign: 'left' }}
            onClick={() => setShowLater((v) => !v)}
          >
            {showLater ? '▾' : '▸'} {later.length} more line{later.length === 1 ? '' : 's'} not running now
          </button>
          {(showLater || soon.length === 0) && later.map(rideRow)}
        </>
      )}
    </div>
  );
}

/** the next n scheduled departures of a pattern at a stop (clock sec) */
function upcomingDepartures(p: Pattern, index: number, day: ServiceDay, t: number, n: number): number[] {
  const out: number[] = [];
  let cur = t;
  for (let k = 0; k < n; k++) {
    const d = nextDeparture(p, index, day, cur, true);
    if (typeof d !== 'number') break;
    out.push(d);
    cur = d + 60; // departures are floored to the minute
  }
  return out;
}

/** real-timetable departures column; ½-headway estimate only when the
 *  network has no stop_times data for this pattern */
function Departures({ pattern, index, day, t, headwaySec }: {
  pattern: Pattern; index: number; day: ServiceDay; t: number; headwaySec: number | null;
}) {
  const deps = upcomingDepartures(pattern, index, day, t, 8);
  const style = { textAlign: 'right' as const, lineHeight: 1.25 };
  if (deps.length > 0) {
    const waitMin = Math.max(0, Math.round((deps[0] - t) / 60));
    return (
      <span className="muted" style={style} title={`scheduled departures:\n${deps.map(fmtClock).join(', ')}`}>
        <b style={{ color: 'var(--fg, #cdd6f4)' }}>next in {waitMin} min ({fmtClock(deps[0])})</b><br />
        {deps.length > 1
          ? <>then {deps.slice(1, 4).map(fmtClock).join(', ')}</>
          : <span style={{ color: 'var(--red, #f87171)' }}>last train of the day</span>}
      </span>
    );
  }
  if (nextDeparture(pattern, index, day, t, true) === 'stranded') {
    return (
      <span className="muted" style={style}>
        <b style={{ color: 'var(--red, #f87171)' }}>no more trains today</b><br />
        last one is gone
      </span>
    );
  }
  // no schedule data shipped for this pattern: honest headway guess
  return (
    <span className="muted" style={style} title="no stop_times data — estimate is ½ headway">
      {headwaySec != null
        ? <><b style={{ color: 'var(--fg, #cdd6f4)' }}>next in ~{Math.max(1, Math.round(headwaySec / 2 / 60))} min ({fmtClock(t + Math.round(headwaySec / 2))})</b><br /></>
        : null}
      every ~{headwaySec ? fmtDur(headwaySec) : '?'}
    </span>
  );
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
