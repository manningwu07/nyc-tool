import { useState } from 'react';
import type { NetworkIndex } from '../engine/engine';
import type { Leg, Pattern, Plan, PlanResult, WaitPolicy } from '../engine/types';
import { fmtDur } from '../engine/time';
import { moveLeg, removeLeg, updateLeg, updateActivePlan, useAppState, attachContingency, removeContingency, uid } from '../store';
import { LegRow, RouteBadge, stationName } from './LegRow';
import StationPicker from './StationPicker';

interface Props {
  idx: NetworkIndex;
  plan: Plan;
  result: PlanResult | null;
}

export default function PlanEditor({ idx, plan, result }: Props) {
  const s = useAppState();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  return (
    <div>
      <div className="section">
        <h3>Start</h3>
        <div className="rowflex">
          <StationPicker
            idx={idx}
            value={plan.startStationId}
            onChange={(sid) => updateActivePlan((p) => ({ ...p, startStationId: sid }))}
            placeholder="start station…"
          />
          <label className="muted">
            pace×{' '}
            <input
              style={{ width: 50 }}
              type="number" step="0.1" min="0.4" max="1.5"
              value={plan.config.walkPaceMultiplier}
              onChange={(e) => updateActivePlan((p) => ({
                ...p, config: { ...p.config, walkPaceMultiplier: Number(e.target.value) || 0.8 },
              }))}
            />
          </label>
          <label className="muted" title="count express pass-throughs as visited (pending Guinness clarification)">
            <input
              type="checkbox"
              checked={plan.config.passThroughCounts}
              onChange={(e) => updateActivePlan((p) => ({
                ...p, config: { ...p.config, passThroughCounts: e.target.checked },
              }))}
            /> pass-through counts
          </label>
          <label className="muted" title="count Staten Island Railway toward coverage (493 total). Guinness's official record is subway-only: 472.">
            <input
              type="checkbox"
              checked={plan.config.includeSIR ?? false}
              onChange={(e) => updateActivePlan((p) => ({
                ...p, config: { ...p.config, includeSIR: e.target.checked },
              }))}
            /> include SIR (493)
          </label>
          <label className="muted" title="hybrid schedule mode: frequent service keeps ½-headway waits; sparse service snaps to actual GTFS departures, and missing the last train is a hard error">
            <input
              type="checkbox"
              checked={plan.config.scheduleMode ?? false}
              onChange={(e) => updateActivePlan((p) => ({
                ...p, config: { ...p.config, scheduleMode: e.target.checked },
              }))}
            /> schedule mode
          </label>
          {plan.config.scheduleMode && (
            <label className="muted" title="headways at or under this stay statistical (½ headway); above it the wait uses the real timetable">
              cutoff (min){' '}
              <input
                style={{ width: 50 }}
                type="number" step="1" min="0" max="60"
                value={Math.round((plan.config.scheduleHeadwayCutoffSec ?? 720) / 60)}
                onChange={(e) => updateActivePlan((p) => ({
                  ...p,
                  config: {
                    ...p.config,
                    scheduleHeadwayCutoffSec: Math.max(0, Number(e.target.value) || 12) * 60,
                  },
                }))}
              />
            </label>
          )}
        </div>
      </div>

      <div className="section">
        <h3>Legs ({plan.legs.length})</h3>
        {plan.legs.length === 0 && (
          <div className="muted">No legs yet. Click a station on the map or use the “Add leg” tab.</div>
        )}
        {plan.legs.map((leg, i) => (
          <div
            key={leg.id}
            draggable
            onDragStart={() => setDragId(leg.id)}
            onDragOver={(e) => { e.preventDefault(); setOverIndex(i); }}
            onDrop={() => {
              if (dragId && dragId !== leg.id) moveLeg(dragId, i);
              setDragId(null); setOverIndex(null);
            }}
            onDragEnd={() => { setDragId(null); setOverIndex(null); }}
            className={overIndex === i && dragId ? 'dragover' : ''}
          >
            <LegRow idx={idx} plan={plan} leg={leg} n={i + 1} result={result?.legs[i]}>
              <div className="actions">
                <button
                  className={editId === leg.id ? 'primary' : ''}
                  onClick={() => setEditId(editId === leg.id ? null : leg.id)}
                  title="change this leg's train, stops, or destination in place"
                >
                  {editId === leg.id ? 'done' : 'edit'}
                </button>
                {leg.type === 'ride' && (
                  <label className="muted">
                    wait{' '}
                    <select
                      value={typeof leg.wait === 'number' ? 'manual' : (leg.wait ?? 'zero')}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === 'manual') {
                          const min = prompt('wait minutes:', '5');
                          if (min != null) updateLeg(leg.id, { wait: Math.round(Number(min) * 60) as WaitPolicy });
                        } else {
                          updateLeg(leg.id, { wait: v as WaitPolicy });
                        }
                      }}
                    >
                      <option value="zero">timed (0) — default</option>
                      <option value="half">½ headway</option>
                      <option value="full">full headway</option>
                      <option value="manual">manual…</option>
                    </select>
                    {typeof leg.wait === 'number' && <span> ({fmtDur(leg.wait)})</span>}
                  </label>
                )}
                {leg.type === 'walk' && (
                  <label className="muted" title="how long this A→B actually takes (plug in your real number) — empty estimates from distance at 10 min/mi">
                    time{' '}
                    <input
                      style={{ width: 50 }}
                      type="number" step="0.5" min="0" max="120"
                      placeholder="auto"
                      value={leg.sec != null ? Math.round(leg.sec / 6) / 10 : ''}
                      onChange={(e) => updateLeg(leg.id, {
                        sec: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 60),
                      })}
                    /> min
                  </label>
                )}
                <span className="spacer" style={{ flex: 1 }} />
                <ContingencyControls idx={idx} plan={plan} legId={leg.id} segments={s.segments} />
                <button className="danger" onClick={() => removeLeg(leg.id)}>delete</button>
              </div>
              {editId === leg.id && <EditLegPanel idx={idx} leg={leg} />}
            </LegRow>
          </div>
        ))}
      </div>
    </div>
  );
}

/** distinct patterns that stop at `boardStationId` with at least one stop
 *  onward, deduped by route + direction + terminal (same collapsing the
 *  Add-leg list uses) so the train dropdown isn't 200 near-identical rows */
function ridePatternsAt(idx: NetworkIndex, boardStationId: string): Pattern[] {
  const seen = new Set<string>();
  const out: Pattern[] = [];
  for (const p of idx.net.patterns) {
    const bi = p.stations.indexOf(boardStationId);
    if (bi < 0 || bi >= p.stations.length - 1) continue;
    const key = `${p.routeId}|${p.direction}|${p.stations[p.stations.length - 1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.sort((a, b) => a.routeId.localeCompare(b.routeId));
}

/** Inline editor: change a leg's content in place (train, board/alight stops,
 *  or walk/bus endpoints) instead of deleting and rebuilding everything after
 *  it. The engine re-chains legs on every change — if a board no longer lines
 *  up with the previous leg's end it auto-inserts a transfer and flags it,
 *  so edits are non-destructive and self-correcting. */
function EditLegPanel({ idx, leg }: { idx: NetworkIndex; leg: Leg }) {
  if (leg.type === 'ride') {
    const pattern = idx.patternById.get(leg.patternId);
    if (!pattern) return <div className="muted detail">unknown pattern — delete and re-add this leg</div>;
    const patterns = ridePatternsAt(idx, leg.boardStationId);
    const boardIdx = pattern.stations.indexOf(leg.boardStationId);

    return (
      <div className="detail rowflex" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="muted">
          train{' '}
          <select
            value={leg.patternId}
            onChange={(e) => {
              const np = idx.patternById.get(e.target.value);
              if (!np) return;
              // keep boarding at the same station if the new train serves it,
              // otherwise board at its origin; alight at the new terminal
              const nb = np.stations.includes(leg.boardStationId) ? leg.boardStationId : np.stations[0];
              const nbi = np.stations.indexOf(nb);
              const na = np.stations.includes(leg.alightStationId) && np.stations.indexOf(leg.alightStationId) > nbi
                ? leg.alightStationId
                : np.stations[np.stations.length - 1];
              updateLeg(leg.id, { patternId: np.id, boardStationId: nb, alightStationId: na });
            }}
          >
            {patterns.every((p) => p.id !== leg.patternId) && (
              <option value={leg.patternId}>{pattern.routeId} (current)</option>
            )}
            {patterns.map((p) => (
              <option key={p.id} value={p.id}>
                {p.routeId} {p.direction === 'N' ? '↑' : '↓'} → {stationName(idx, p.stations[p.stations.length - 1])}
              </option>
            ))}
          </select>
        </label>
        <label className="muted">
          board{' '}
          <select
            value={leg.boardStationId}
            onChange={(e) => {
              const nb = e.target.value;
              const nbi = pattern.stations.indexOf(nb);
              const ai = pattern.stations.indexOf(leg.alightStationId);
              // keep alight strictly after the new board
              const na = ai > nbi ? leg.alightStationId : pattern.stations[pattern.stations.length - 1];
              updateLeg(leg.id, { boardStationId: nb, alightStationId: na });
            }}
          >
            {pattern.stations.slice(0, -1).map((sid) => (
              <option key={sid} value={sid}>{stationName(idx, sid)}</option>
            ))}
          </select>
        </label>
        <label className="muted">
          alight{' '}
          <select
            value={leg.alightStationId}
            onChange={(e) => updateLeg(leg.id, { alightStationId: e.target.value })}
          >
            {pattern.stations.slice(boardIdx + 1).map((sid) => (
              <option key={sid} value={sid}>{stationName(idx, sid)}</option>
            ))}
          </select>
        </label>
        <span className="muted"><RouteBadge idx={idx} routeId={pattern.routeId} /> {pattern.stations.length - 1 - boardIdx} stops onward</span>
      </div>
    );
  }

  if (leg.type === 'walk' || leg.type === 'bus') {
    return (
      <div className="detail rowflex" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="muted">
          from{' '}
          <StationPicker idx={idx} value={leg.fromStationId}
            onChange={(sid) => updateLeg(leg.id, { fromStationId: sid })} />
        </label>
        <label className="muted">
          to{' '}
          <StationPicker idx={idx} value={leg.toStationId}
            onChange={(sid) => updateLeg(leg.id, { toStationId: sid })} />
        </label>
      </div>
    );
  }

  // buffer
  const bufferSec = leg.type === 'wait' ? leg.sec : 0;
  return (
    <div className="detail rowflex" style={{ gap: 8, alignItems: 'center' }}>
      <label className="muted">
        buffer (min){' '}
        <input
          style={{ width: 60 }}
          type="number" step="0.5" min="0"
          value={Math.round(bufferSec / 6) / 10}
          onChange={(e) => updateLeg(leg.id, { sec: Math.round(Number(e.target.value) * 60) })}
        />
      </label>
    </div>
  );
}

function ContingencyControls({ idx, plan, legId, segments }: {
  idx: NetworkIndex; plan: Plan; legId: string;
  segments: { id: string; name: string; legs: Plan['legs'] }[];
}) {
  const branches = plan.contingencies[legId] ?? [];
  return (
    <span className="rowflex" style={{ marginBottom: 0 }}>
      {branches.map((b) => (
        <span key={b.id} className="muted" title={b.legs.map((l) => l.type).join(', ')}>
          🔀 {b.name} (&gt;{fmtDur(b.driftThresholdSec)} behind)
          <button className="danger" onClick={() => removeContingency(legId, b.id)} style={{ marginLeft: 4 }}>×</button>
        </span>
      ))}
      <button
        onClick={() => {
          if (segments.length === 0) {
            alert('Save a segment in the Library tab first — contingency branches are built from saved segments.');
            return;
          }
          const names = segments.map((g, i) => `${i + 1}: ${g.name}`).join('\n');
          const pick = prompt(`Attach which segment as a contingency? (replaces remaining legs when chosen mid-run)\n${names}`, '1');
          if (pick == null) return;
          const seg = segments[Number(pick) - 1];
          if (!seg) return;
          const thr = prompt('Surface when behind by more than (minutes):', '10');
          if (thr == null) return;
          attachContingency(legId, {
            id: uid(), name: seg.name,
            driftThresholdSec: Math.round(Number(thr) * 60),
            legs: JSON.parse(JSON.stringify(seg.legs)),
          });
        }}
        title={`attach contingency branch at ${stationName(idx, legEnd(plan, legId))}`}
      >
        + plan B
      </button>
    </span>
  );
}

function legEnd(plan: Plan, legId: string): string | null {
  const leg = plan.legs.find((l) => l.id === legId);
  if (!leg) return null;
  if (leg.type === 'ride') return leg.alightStationId;
  if (leg.type === 'wait') return null;
  return leg.toStationId;
}
