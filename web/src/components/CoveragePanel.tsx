import { useMemo } from 'react';
import type { NetworkIndex } from '../engine/engine';
import type { PlanResult } from '../engine/types';

const BOROUGHS: Record<string, string> = {
  M: 'Manhattan', Bk: 'Brooklyn', Q: 'Queens', Bx: 'Bronx', SI: 'Staten Island',
};

interface Props {
  idx: NetworkIndex;
  result: PlanResult | null;
}

export default function CoveragePanel({ idx, result }: Props) {
  const covered = useMemo(() => new Set(result?.covered ?? []), [result]);
  // covered ∪ uncovered from the engine is exactly the target set (472 or 493)
  const targetIds = useMemo(
    () => (result ? new Set([...result.covered, ...result.uncovered]) : idx.recordStationIds),
    [result, idx],
  );
  const record = idx.net.stations.filter((s) => targetIds.has(s.id));

  const byBorough = useMemo(() => {
    const m = new Map<string, { total: number; done: number }>();
    for (const s of record) {
      const e = m.get(s.borough) ?? { total: 0, done: 0 };
      e.total++;
      if (covered.has(s.id)) e.done++;
      m.set(s.borough, e);
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [record, covered]);

  // stranded: uncovered stations grouped by the route-set serving them
  const stranded = useMemo(() => {
    const groups = new Map<string, { stations: string[]; routes: string[] }>();
    for (const s of record) {
      if (covered.has(s.id)) continue;
      const key = s.routes.join(' ');
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { stations: [], routes: s.routes }));
      g.stations.push(s.name);
    }
    return [...groups.entries()].sort((a, b) => b[1].stations.length - a[1].stations.length);
  }, [record, covered]);

  return (
    <div>
      <div className="section">
        <h3>By borough</h3>
        {byBorough.map(([b, { total, done }]) => (
          <div key={b} className="rowflex">
            <span style={{ width: 110 }}>{BOROUGHS[b] ?? b}</span>
            <div style={{ flex: 1, height: 8, background: 'var(--panel2)', borderRadius: 4 }}>
              <div style={{
                width: `${(done / total) * 100}%`, height: '100%',
                background: done === total ? 'var(--green)' : 'var(--blue)', borderRadius: 4,
              }} />
            </div>
            <span className="muted" style={{ width: 70, textAlign: 'right' }}>{done}/{total}</span>
          </div>
        ))}
      </div>

      <div className="section">
        <h3>Stranded stations ({result ? result.uncovered.length : record.length})</h3>
        {stranded.length === 0 && <div style={{ color: 'var(--green)' }}>✅ Full coverage — {record.length}/{record.length}</div>}
        {stranded.map(([key, g]) => (
          <div key={key} className="stranded-group">
            <b>{key || '(no daytime routes)'}</b>
            <span className="muted"> — {g.stations.length} stations</span>
            <div className="muted">{g.stations.join(' · ')}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
