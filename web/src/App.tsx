import { useEffect, useMemo, useState } from 'react';
import type { Network } from './engine/types';
import { buildIndex, evaluatePlan } from './engine/engine';
import { fmtClock, fmtDur, parseClock } from './engine/time';
import { activePlan, updateActivePlan, useAppState, setState, newPlan, duplicateActivePlan, deletePlan, importPlan, recordAttempt, startRun } from './store';
import { downloadCsv, planResultCsv } from './attempts';
import MapView from './components/MapView';
import PlanEditor from './components/PlanEditor';
import LegEntry from './components/LegEntry';
import CoveragePanel from './components/CoveragePanel';
import Library from './components/Library';
import Compare from './components/Compare';
import Shortcuts from './components/Shortcuts';
import RunMode from './run/RunMode';

type Tab = 'plan' | 'add' | 'coverage' | 'shortcuts' | 'library' | 'compare';

export default function App() {
  const [net, setNet] = useState<Network | null>(null);
  const [tab, setTab] = useState<Tab>('plan');
  const s = useAppState();

  useEffect(() => {
    fetch(import.meta.env.BASE_URL + 'network.json')
      .then((r) => r.json())
      .then(setNet)
      .catch((e) => console.error('failed to load network.json', e));
  }, []);

  const idx = useMemo(() => {
    if (!net) return null;
    const merged: Network = {
      ...net,
      transfers: [...net.transfers, ...s.customTransfers],
    };
    return buildIndex(merged);
  }, [net, s.customTransfers]);

  const plan = activePlan(s);
  const result = useMemo(
    () => (idx && plan ? evaluatePlan(idx, plan) : null),
    [idx, plan],
  );

  // autosave the route as an attempt 3s after edits settle (deduped by
  // content, pruned to top 3 best + 2 latest in the store)
  useEffect(() => {
    if (!plan || !result || plan.legs.length === 0) return;
    const t = setTimeout(() => recordAttempt(plan, result), 3000);
    return () => clearTimeout(t);
  }, [plan, result]);

  if (!idx || !plan) return <div style={{ padding: 24 }}>Loading network…</div>;

  if (s.mode === 'run' && s.run) {
    return <RunMode idx={idx} />;
  }

  const finish = result ? fmtClock(result.endSec) : '—';

  return (
    <div className="app">
      <div className="topbar">
        <span className="stat">
          <b style={{ color: result && result.coveredCount >= result.totalToCover ? 'var(--green)' : undefined }}>
            {result?.coveredCount ?? 0}/{result?.totalToCover ?? 472}
          </b>
        </span>
        <span className="stat">est. <b>{result ? fmtDur(result.elapsedSec) : '—'}</b> elapsed</span>
        <span className="stat">finish ~<b>{finish}</b></span>
        {result && result.errorCount > 0 && (
          <span className="stat" style={{ color: 'var(--red)' }}>
            ⚠ {result.errorCount} error{result.errorCount > 1 ? 's' : ''}
          </span>
        )}
        <span className="spacer" />
        <select
          value={plan.id}
          onChange={(e) => setState({ activePlanId: e.target.value })}
        >
          {s.plans.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input
          style={{ width: 130 }}
          value={plan.name}
          onChange={(e) => updateActivePlan((p) => ({ ...p, name: e.target.value }))}
        />
        <select
          value={plan.serviceDay}
          onChange={(e) => updateActivePlan((p) => ({ ...p, serviceDay: e.target.value as never }))}
        >
          <option>Weekday</option>
          <option>Saturday</option>
          <option>Sunday</option>
        </select>
        <input
          style={{ width: 64 }}
          type="time"
          value={fmtClock(plan.startClockSec)}
          onChange={(e) => updateActivePlan((p) => ({ ...p, startClockSec: parseClock(e.target.value) }))}
        />
        <button onClick={() => newPlan(`Plan ${s.plans.length + 1}`)}>New</button>
        <button onClick={duplicateActivePlan}>Dup</button>
        <button className="danger" onClick={() => { if (confirm(`Delete plan "${plan.name}"?`)) deletePlan(plan.id); }}>Del</button>
        <button onClick={() => exportPlanJson(plan.name, plan)}>Export</button>
        <button
          title="Export the evaluated route as CSV (opens directly in Google Sheets)"
          onClick={() => result && downloadCsv(
            `${plan.name.replace(/\s+/g, '_')}.route.csv`,
            planResultCsv(plan, result, {
              stationName: (sid) => (sid && idx.stationById.get(sid)?.name) || sid || '',
              routeOfPattern: (pid) => idx.patternById.get(pid)?.routeId ?? '?',
            }),
          )}
        >
          Sheets CSV
        </button>
        <button onClick={() => importPlanFile()}>Import</button>
        <button
          className="primary"
          onClick={() => {
            // snapshot now: taking a contingency rewrites the plan mid-run
            if (result && plan.legs.length > 0) recordAttempt(plan, result);
            startRun(plan.id, plan.serviceDay);
          }}
          title="Start live run mode with this plan"
        >
          ▶ Run
        </button>
      </div>
      <div className="covbar">
        <div style={{ width: `${((result?.coveredCount ?? 0) / (result?.totalToCover ?? 472)) * 100}%` }} />
      </div>
      <div className="main">
        <MapView idx={idx} plan={plan} result={result} onSelect={(sid) => { setState({ selectedStationId: sid }); setTab('add'); }} />
        <div className="side">
          <div className="tabs">
            {(['plan', 'add', 'coverage', 'shortcuts', 'library', 'compare'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t === 'add' ? 'Add leg' : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div className="side-body">
            {tab === 'plan' && <PlanEditor idx={idx} plan={plan} result={result} />}
            {tab === 'add' && <LegEntry idx={idx} plan={plan} result={result} />}
            {tab === 'coverage' && <CoveragePanel idx={idx} result={result} />}
            {tab === 'shortcuts' && <Shortcuts idx={idx} plan={plan} />}
            {tab === 'library' && <Library idx={idx} plan={plan} />}
            {tab === 'compare' && <Compare idx={idx} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function exportPlanJson(name: string, plan: unknown) {
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/\s+/g, '_')}.plan.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importPlanFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      importPlan(await f.text());
    } catch (e) {
      alert(`Import failed: ${e}`);
    }
  };
  input.click();
}
