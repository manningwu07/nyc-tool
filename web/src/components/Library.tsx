import { useState } from 'react';
import type { NetworkIndex } from '../engine/engine';
import type { Plan } from '../engine/types';
import { deleteSegment, removeCustomTransfer, saveSegment, spliceSegment, useAppState } from '../store';
import { legSummary, stationName } from './LegRow';
import { fmtDur } from '../engine/time';

interface Props {
  idx: NetworkIndex;
  plan: Plan;
}

/** segment library + custom walk edges */
export default function Library({ idx, plan }: Props) {
  const s = useAppState();
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(plan.legs.length || 1);

  return (
    <div>
      <div className="section">
        <h3>Save legs as segment</h3>
        <div className="rowflex">
          <label className="muted">legs <input style={{ width: 50 }} type="number" min={1} max={plan.legs.length} value={from} onChange={(e) => setFrom(Number(e.target.value))} /></label>
          <label className="muted">to <input style={{ width: 50 }} type="number" min={1} max={plan.legs.length} value={to} onChange={(e) => setTo(Number(e.target.value))} /></label>
          <button onClick={() => {
            const legs = plan.legs.slice(from - 1, to);
            if (legs.length === 0) { alert('No legs in that range.'); return; }
            const name = prompt('Segment name:', 'Rockaways sweep');
            if (name) saveSegment(name, legs);
          }}>
            Save
          </button>
        </div>
      </div>

      <div className="section">
        <h3>Segments ({s.segments.length})</h3>
        {s.segments.length === 0 && <div className="muted">None yet. Segments are reusable chunks (“Rockaways sweep”) you can splice into any plan or attach as contingency branches.</div>}
        {s.segments.map((g) => (
          <div key={g.id} className="leg">
            <div className="row1">
              <b style={{ flex: 1 }}>{g.name}</b>
              <span className="muted">{g.legs.length} legs</span>
              <button onClick={() => spliceSegment(g.id)}>splice at end</button>
              <button className="danger" onClick={() => deleteSegment(g.id)}>×</button>
            </div>
            <div className="detail">
              {g.legs.map((l, i) => {
                const { badge, text } = legSummary(idx, l);
                return <div key={i}>{badge ? `[${badge}] ` : ''}{text}</div>;
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="section">
        <h3>Custom walk edges ({s.customTransfers.length})</h3>
        {s.customTransfers.map((tEdge, i) => (
          <div key={i} className="rowflex">
            <span style={{ flex: 1 }}>
              {stationName(idx, tEdge.from)} ↔ {stationName(idx, tEdge.to)}
              <span className="muted"> · {tEdge.kind} {fmtDur(tEdge.sec)}</span>
            </span>
            <button className="danger" onClick={() => removeCustomTransfer(i)}>×</button>
          </div>
        ))}
        {s.customTransfers.length === 0 && (
          <div className="muted">Add strategic street walks (e.g. Lefferts Blvd → Rockaway Blvd) from the “Add leg” tab after selecting a station.</div>
        )}
      </div>
    </div>
  );
}
