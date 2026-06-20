import { useState } from 'react';
import type { NetworkIndex } from '../engine/engine';
import type { BandIndex, Plan, TransferEdge } from '../engine/types';
import { BAND_NAMES } from '../engine/types';
import { fmtDur, serviceDayAt } from '../engine/time';
import { findShortcuts, type ShortcutCandidate } from '../engine/shortcuts';
import { addCustomTransfer, removeCustomTransfer, updateCustomTransfer, useAppState } from '../store';
import { stationName } from './LegRow';

interface Props {
  idx: NetworkIndex;
  plan: Plan;
}

export default function Shortcuts({ idx, plan }: Props) {
  const s = useAppState();
  const [mode, setMode] = useState<'walk' | 'bus'>('walk');
  const [maxKm, setMaxKm] = useState(2.0);
  const [minMin, setMinMin] = useState(15);
  const [tipsOnly, setTipsOnly] = useState(true);
  const [paceMinMi, setPaceMinMi] = useState(10);
  const [band, setBand] = useState<BandIndex>(2);
  const [results, setResults] = useState<ShortcutCandidate[] | null>(null);

  function compute() {
    setResults(findShortcuts(idx, {
      day: serviceDayAt(plan.serviceDay, plan.startClockSec), band,
      maxMeters: maxKm * 1000,
      minNetworkSec: minMin * 60,
      branchTipsOnly: tipsOnly,
      paceSecPerKm: (paceMinMi * 60) / 1.60934,
    }));
  }

  function pickMode(m: 'walk' | 'bus') {
    setMode(m);
    setMaxKm(m === 'walk' ? 2.0 : 5.0);
    setResults(null);
  }

  function draftEdge(c: ShortcutCandidate) {
    if (mode === 'walk') {
      addCustomTransfer({
        from: c.a, to: c.b, kind: 'walk', sec: c.estWalkSec,
        notes: '', confirmed: false,
      });
    } else {
      const route = prompt('Bus route (e.g. Q52-SBS)?\nTip: run ingest/add_bus_edge.py for real GTFS timing, then paste its JSON below.');
      if (!route) return;
      const ride = Number(prompt('Ride minutes (rough):', '15') ?? 15);
      const headway = Number(prompt('Headway minutes (rough):', '15') ?? 15);
      const access = Number(prompt('Walk-to-stop buffer minutes:', '2') ?? 2);
      addCustomTransfer({
        from: c.a, to: c.b, kind: 'bus', sec: Math.round(ride * 60),
        notes: '', confirmed: false, routeLabel: route,
        accessSec: Math.round(access * 60),
        busService: {
          [serviceDayAt(plan.serviceDay, plan.startClockSec)]: {
            rideSec: Array(5).fill(Math.round(ride * 60)),
            headwaySec: Array(5).fill(Math.round(headway * 60)),
          },
        },
      });
    }
  }

  function importBusJson() {
    const raw = prompt('Paste TransferEdge JSON from ingest/add_bus_edge.py:');
    if (!raw) return;
    try {
      const e = JSON.parse(raw) as TransferEdge;
      if (!e.from || !e.to || e.kind !== 'bus') throw new Error('not a bus TransferEdge');
      if (!idx.stationById.has(e.from) || !idx.stationById.has(e.to)) throw new Error('unknown station id');
      addCustomTransfer({ confirmed: false, ...e });
    } catch (err) {
      alert(`Import failed: ${err}`);
    }
  }

  const edgeOf = (c: ShortcutCandidate) =>
    s.customTransfers.some((e) =>
      (e.from === c.a && e.to === c.b) || (e.from === c.b && e.to === c.a));

  return (
    <div>
      <div className="section">
        <h3>Shortcut finder</h3>
        <div className="muted" style={{ marginBottom: 6 }}>
          Station pairs that are close on the street but slow in-system — where
          walks and buses win back minutes. Scout before trusting.
        </div>
        <div className="rowflex" style={{ flexWrap: 'wrap', gap: 6 }}>
          <label><input type="radio" checked={mode === 'walk'} onChange={() => pickMode('walk')} /> 🚶 walk</label>
          <label><input type="radio" checked={mode === 'bus'} onChange={() => pickMode('bus')} /> 🚌 bus</label>
          <label>≤ <input type="number" step="0.5" style={{ width: 48 }} value={maxKm}
            onChange={(e) => setMaxKm(Number(e.target.value))} /> km</label>
          <label>in-system ≥ <input type="number" style={{ width: 42 }} value={minMin}
            onChange={(e) => setMinMin(Number(e.target.value))} /> min</label>
          <label>pace <input type="number" style={{ width: 42 }} value={paceMinMi}
            onChange={(e) => setPaceMinMi(Number(e.target.value))} /> min/mi</label>
          <label><input type="checkbox" checked={tipsOnly} onChange={(e) => setTipsOnly(e.target.checked)} /> branch tips only</label>
          <select value={band} onChange={(e) => setBand(Number(e.target.value) as BandIndex)}>
            {BAND_NAMES.map((b, i) => <option key={b} value={i}>{b}</option>)}
          </select>
          <button className="primary" onClick={compute}>Find shortcuts</button>
        </div>
      </div>

      {results && (
        <div className="section">
          <h3>{results.length} candidates ({plan.serviceDay}, {BAND_NAMES[band]})</h3>
          {results.length === 0 && <div className="muted">Nothing beats the rails under these thresholds.</div>}
          {results.slice(0, 60).map((c) => (
            <div key={`${c.a}|${c.b}`} className="opt" style={{ alignItems: 'baseline' }}>
              <span style={{ flex: 1 }}>
                {stationName(idx, c.a)} ↔ {stationName(idx, c.b)}
                <span className="muted"> · {(c.meters / 1000).toFixed(2)} km</span>
              </span>
              <span className="muted" style={{ whiteSpace: 'nowrap' }}>
                rail {fmtDur(c.networkSec)} vs {mode === 'walk' ? 'walk' : '~walk'} {fmtDur(c.estWalkSec)}
                {' '}· saves <b style={{ color: 'var(--green)' }}>{fmtDur(c.savingSec)}</b>
              </span>
              {edgeOf(c)
                ? <span className="muted" style={{ marginLeft: 6 }}>✓ drafted</span>
                : <button style={{ marginLeft: 6 }} onClick={() => draftEdge(c)}>+ draft</button>}
            </div>
          ))}
          {results.length > 60 && <div className="muted">…{results.length - 60} more (tighten the filters)</div>}
        </div>
      )}

      <div className="section">
        <h3>Your shortcut edges ({s.customTransfers.length})</h3>
        <div className="muted" style={{ marginBottom: 6 }}>
          ⚠ = unconfirmed draft. Confirm only after street-viewing / scouting the
          exits; note which exit and street route to use.
        </div>
        {s.customTransfers.map((e, i) => (
          <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid #333' }}>
            <div className="rowflex">
              <span style={{ flex: 1 }}>
                {e.confirmed ? '✓' : '⚠'} {e.kind === 'bus' ? `🚌 ${e.routeLabel ?? 'bus'}` : '🚶'}
                {' '}{stationName(idx, e.from)} ↔ {stationName(idx, e.to)}
              </span>
              <label>
                <input type="number" style={{ width: 46 }} value={Math.round(e.sec / 60)}
                  onChange={(ev) => updateCustomTransfer(i, { sec: Math.round(Number(ev.target.value) * 60) })} /> min
              </label>
              <label>
                <input type="checkbox" checked={!!e.confirmed}
                  onChange={(ev) => updateCustomTransfer(i, { confirmed: ev.target.checked })} /> confirmed
              </label>
              <button className="danger" onClick={() => removeCustomTransfer(i)}>✕</button>
            </div>
            <input
              style={{ width: '100%', marginTop: 4 }}
              placeholder="notes: exit to use, street route, bus stop location…"
              value={e.notes}
              onChange={(ev) => updateCustomTransfer(i, { notes: ev.target.value })}
            />
          </div>
        ))}
        <button style={{ marginTop: 8 }} onClick={importBusJson}>Import bus edge JSON (from add_bus_edge.py)</button>
      </div>
    </div>
  );
}
