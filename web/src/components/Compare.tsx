import { useMemo } from 'react';
import type { NetworkIndex } from '../engine/engine';
import { evaluatePlan } from '../engine/engine';
import { fmtClock, fmtDur } from '../engine/time';
import { deleteAttempt, restoreAttempt, setState, useAppState } from '../store';
import { attemptsCsv, attemptTags, downloadCsv, rankAttempts } from '../attempts';

/** A/B comparison of two saved plans */
export default function Compare({ idx }: { idx: NetworkIndex }) {
  const s = useAppState();
  const a = s.plans.find((p) => p.id === s.activePlanId) ?? null;
  const b = s.plans.find((p) => p.id === s.comparePlanId) ?? null;

  const ra = useMemo(() => (a ? evaluatePlan(idx, a) : null), [idx, a]);
  const rb = useMemo(() => (b ? evaluatePlan(idx, b) : null), [idx, b]);

  return (
    <div>
      <div className="section">
        <h3>Compare against</h3>
        <select
          value={s.comparePlanId ?? ''}
          onChange={(e) => setState({ comparePlanId: e.target.value || null })}
        >
          <option value="">— pick a plan —</option>
          {s.plans.filter((p) => p.id !== s.activePlanId).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {a && b && ra && rb && (
        <div className="section">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr className="muted">
                <th style={{ textAlign: 'left' }}></th>
                <th style={{ textAlign: 'right' }}>{a.name}</th>
                <th style={{ textAlign: 'right' }}>{b.name}</th>
                <th style={{ textAlign: 'right' }}>Δ</th>
              </tr>
            </thead>
            <tbody>
              {row('coverage', `${ra.coveredCount}/${ra.totalToCover}`, `${rb.coveredCount}/${rb.totalToCover}`, ra.coveredCount - rb.coveredCount)}
              {row('total time', fmtDur(ra.elapsedSec), fmtDur(rb.elapsedSec), null, fmtDur(ra.elapsedSec - rb.elapsedSec) + (ra.elapsedSec > rb.elapsedSec ? ' slower' : ' faster'))}
              {row('start', fmtClock(a.startClockSec), fmtClock(b.startClockSec), null)}
              {row('finish', fmtClock(ra.endSec), fmtClock(rb.endSec), null)}
              {row('legs', String(a.legs.length), String(b.legs.length), a.legs.length - b.legs.length)}
              {row('errors', String(ra.errorCount), String(rb.errorCount), ra.errorCount - rb.errorCount)}
              {row('high-risk legs (>10m headway)',
                String(ra.legs.filter((l) => (l.riskSec ?? 0) > 600).length),
                String(rb.legs.filter((l) => (l.riskSec ?? 0) > 600).length), null)}
            </tbody>
          </table>
        </div>
      )}
      {!b && <div className="muted">Pick a second plan to see the diff.</div>}

      <div className="section">
        <h3>Attempts (top 3 best + 2 latest kept)</h3>
        {s.attempts.length === 0 && (
          <div className="muted">None yet — routes autosave here a few seconds after you edit them.</div>
        )}
        {rankAttempts(s.attempts).map((a) => (
          <div key={a.id} className="rowflex" style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
            <span style={{ flex: 1 }}>
              <b>{a.plan.name}</b>{' '}
              <span className="muted">
                {a.coveredCount}/{a.totalToCover} · {fmtDur(a.elapsedSec)} · finish {fmtClock(a.endSec)}
                {a.errorCount > 0 && <> · ⚠{a.errorCount}</>}
                {' · '}{new Date(a.savedAtMs).toLocaleString()}
              </span>{' '}
              {attemptTags(s.attempts, a.id).map((t) => (
                <span key={t} className="badge" style={{ background: t === 'latest' ? '#555' : 'var(--green, #2a8)' }}>{t}</span>
              ))}
            </span>
            <button onClick={() => restoreAttempt(a.id)}>restore</button>
            <button className="danger" onClick={() => deleteAttempt(a.id)}>✕</button>
          </div>
        ))}
        {s.attempts.length > 0 && (
          <button style={{ marginTop: 8 }} onClick={() => downloadCsv('attempts.csv', attemptsCsv(s.attempts))}>
            Export attempts CSV (Google Sheets)
          </button>
        )}
      </div>
    </div>
  );
}

function row(label: string, va: string, vb: string, delta: number | null, deltaText?: string) {
  return (
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <td style={{ padding: '6px 0' }}>{label}</td>
      <td style={{ textAlign: 'right' }}>{va}</td>
      <td style={{ textAlign: 'right' }}>{vb}</td>
      <td style={{ textAlign: 'right' }} className="muted">
        {deltaText ?? (delta != null && delta !== 0 ? (delta > 0 ? `+${delta}` : String(delta)) : '')}
      </td>
    </tr>
  );
}
