import { useMemo, useState } from 'react';
import type { NetworkIndex } from '../engine/engine';

interface Props {
  idx: NetworkIndex;
  value: string;
  onChange: (stationId: string) => void;
  placeholder?: string;
}

/** text search over station names; shows "name (routes) — borough" */
export default function StationPicker({ idx, value, onChange, placeholder }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const current = idx.stationById.get(value);

  const matches = useMemo(() => {
    if (!q) return [];
    const needle = q.toLowerCase();
    return idx.net.stations
      .filter((s) => s.name.toLowerCase().includes(needle))
      .slice(0, 12);
  }, [idx, q]);

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <input
        style={{ width: 220 }}
        placeholder={placeholder ?? 'station…'}
        value={open ? q : current ? `${current.name} (${current.routes.join(' ')})` : ''}
        onFocus={() => { setOpen(true); setQ(''); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQ(e.target.value)}
      />
      {open && matches.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 30, width: 300,
          background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 6,
          maxHeight: 260, overflowY: 'auto',
        }}>
          {matches.map((s) => (
            <div
              key={s.id}
              style={{ padding: '5px 8px', cursor: 'pointer' }}
              onMouseDown={() => { onChange(s.id); setOpen(false); }}
            >
              {s.name} <span className="muted">({s.routes.join(' ')}) — {s.borough}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
