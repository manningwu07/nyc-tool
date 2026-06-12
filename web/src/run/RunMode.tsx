import { useEffect, useMemo, useState } from 'react';
import type { NetworkIndex } from '../engine/engine';
import { evaluatePlan } from '../engine/engine';
import type { Leg, Plan, PlanResult } from '../engine/types';
import { fmtClock, fmtDur } from '../engine/time';
import {
  clockSecNow, exitRun, logRunEvent, setState, uid, updatePlan, useAppState,
} from '../store';
import { LegRow, legSummary, stationName } from '../components/LegRow';
import PlanEditor from '../components/PlanEditor';

interface Props {
  idx: NetworkIndex;
}

export default function RunMode({ idx }: Props) {
  const s = useAppState();
  const run = s.run!;
  const plan = s.plans.find((p) => p.id === run.planId)!;
  const [editing, setEditing] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(h);
  }, []);

  const nowSec = clockSecNow(run);

  // baseline: the plan as drafted
  const planned = useMemo(() => evaluatePlan(idx, plan), [idx, plan]);

  // what we've actually covered so far (completed legs + start station)
  const donePart = useMemo(() => {
    const done: Plan = { ...plan, legs: plan.legs.slice(0, run.currentLegIndex) };
    return evaluatePlan(idx, done);
  }, [idx, plan, run.currentLegIndex]);

  const hereStation = run.currentLegIndex === 0
    ? plan.startStationId
    : donePart.legs[donePart.legs.length - 1]?.endStationId ?? plan.startStationId;

  // remaining plan, re-timed from (current station, actual current time)
  const remainingLegs = useMemo(() => {
    const legs: Leg[] = [];
    for (const leg of plan.legs.slice(run.currentLegIndex)) {
      const extra = run.extraWaitSec[leg.id];
      if (extra) legs.push({ id: `xw-${leg.id}`, type: 'wait', sec: extra });
      legs.push(leg);
    }
    return legs;
  }, [plan, run.currentLegIndex, run.extraWaitSec]);

  const remainingPlan: Plan = useMemo(() => ({
    ...plan,
    startStationId: hereStation,
    startClockSec: nowSec,
    legs: remainingLegs,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [plan, hereStation, remainingLegs, run.lastEventClockSec, Math.floor(nowSec / 30)]);

  const remaining: PlanResult = useMemo(
    () => evaluatePlan(idx, remainingPlan, donePart.covered),
    [idx, remainingPlan, donePart],
  );

  // drift: actual elapsed vs planned elapsed to this point in the plan
  // (independent of when the run actually started; bands still use real clock)
  const plannedHereSec = run.currentLegIndex === 0
    ? plan.startClockSec
    : planned.legs[run.currentLegIndex - 1]?.arriveSec ?? plan.startClockSec;
  const runStartClockSec = Math.round((run.startedAtMs - run.dayStartMs) / 1000);
  const drift = (nowSec - runStartClockSec) - (plannedHereSec - plan.startClockSec);

  const currentLeg = plan.legs[run.currentLegIndex] ?? null;
  const currentLegResult = remaining.legs.find((l) => l.legId === currentLeg?.id);
  const finished = currentLeg === null;
  const coveredTotal = remaining.coveredCount;

  // contingencies on the current leg whose threshold is crossed; bus legs
  // always show their fallback (buses sit in traffic and don't show up)
  const triggered = currentLeg
    ? (plan.contingencies[currentLeg.id] ?? []).filter(
        (b) => drift > b.driftThresholdSec || currentLeg.type === 'bus')
    : [];
  const busNoFallback = currentLeg?.type === 'bus'
    && (plan.contingencies[currentLeg.id] ?? []).length === 0;

  function advance() {
    if (!currentLeg) return;
    const dest = currentLeg.type === 'ride' ? currentLeg.alightStationId
      : currentLeg.type === 'wait' ? null : currentLeg.toStationId;
    logRunEvent(
      { kind: 'arrived', atMs: Date.now(), legId: currentLeg.id, stationId: dest },
      { currentLegIndex: run.currentLegIndex + 1, finished: run.currentLegIndex + 1 >= plan.legs.length },
    );
  }

  function missedTrain() {
    if (!currentLeg) return;
    const headway = currentLegResult?.riskSec ?? 600;
    logRunEvent(
      { kind: 'missed', atMs: Date.now(), legId: currentLeg.id, headwaySec: headway },
      { extraWaitSec: { ...run.extraWaitSec, [currentLeg.id]: (run.extraWaitSec[currentLeg.id] ?? 0) + headway } },
    );
  }

  function takeContingency(branchId: string) {
    if (!currentLeg) return;
    const branch = (plan.contingencies[currentLeg.id] ?? []).find((b) => b.id === branchId);
    if (!branch) return;
    // splice: branch replaces all remaining legs
    updatePlan(plan.id, (p) => ({
      ...p,
      legs: [...p.legs.slice(0, run.currentLegIndex), ...branch.legs.map((l) => ({ ...l, id: uid() } as Leg))],
    }));
    logRunEvent({ kind: 'contingency', atMs: Date.now(), legId: currentLeg.id, branchName: branch.name });
  }

  if (editing) {
    return (
      <div className="run">
        <div className="rowflex">
          <button className="primary" onClick={() => setEditing(false)}>← back to run</button>
          <span className="muted">editing remaining plan (legs {run.currentLegIndex + 1}+)</span>
        </div>
        <div style={{ overflowY: 'auto' }}>
          <PlanEditor idx={idx} plan={plan} result={planned} />
        </div>
      </div>
    );
  }

  return (
    <div className="run">
      <div className="rowflex" style={{ justifyContent: 'space-between' }}>
        <span className="stat"><b>{coveredTotal}/{remaining.totalToCover}</b> projected · <b>{donePart.coveredCount}</b> so far</span>
        <span className="stat">{fmtClock(nowSec)}</span>
        <button onClick={() => setEditing(true)}>edit</button>
        <button onClick={() => { if (confirm('Exit run mode?')) exitRun(); }}>exit</button>
      </div>

      <div className={`drift ${drift > 60 ? 'behind' : drift < -60 ? 'ahead' : ''}`}>
        {drift >= 0 ? '+' : '−'}{fmtDur(drift)} {drift >= 0 ? 'behind' : 'ahead'}
        <div className="muted" style={{ fontSize: 16, fontWeight: 400 }}>
          projected finish {fmtClock(remaining.endSec)} · {remaining.uncovered.length} stations left
        </div>
      </div>

      {triggered.map((b) => (
        <ContingencyCard
          key={b.id} idx={idx} branch={b} basePlan={remainingPlan}
          doneCovered={donePart.covered} baseline={remaining}
          onTake={() => takeContingency(b.id)}
        />
      ))}

      {finished ? (
        <div className="current">
          <div className="dest">🏁 Run complete</div>
          <div className="muted">{donePart.coveredCount}/{remaining.totalToCover} covered</div>
          <div className="rowflex" style={{ justifyContent: 'center', marginTop: 10 }}>
            <button onClick={() => exportLog(run.log, 'json')}>export JSON</button>
            <button onClick={() => exportLog(run.log, 'csv')}>export CSV</button>
          </div>
        </div>
      ) : (
        <>
          <div className="current">
            <div className="muted">leg {run.currentLegIndex + 1}/{plan.legs.length}</div>
            <CurrentLegView idx={idx} leg={currentLeg!} />
            {currentLeg!.type === 'bus' && (
              <div className="err" style={{ marginTop: 4 }}>
                🚌 HIGH RISK bus leg{busNoFallback
                  ? ' — NO rail fallback attached!'
                  : ' — fallback below if it no-shows'}
              </div>
            )}
            {currentLegResult && (
              <div className="muted" style={{ marginTop: 6 }}>
                {currentLegResult.waitSec > 0 && <>wait ~{fmtDur(currentLegResult.waitSec)} · </>}
                {fmtDur(currentLegResult.moveSec)} ride · arrive ~{fmtClock(currentLegResult.arriveSec)}
                {currentLegResult.errors.map((e, i) => <div key={i} className="err">⛔ {e}</div>)}
              </div>
            )}
          </div>
          <div className="bigbtns">
            <button className="arrive" onClick={advance}>
              ✓ {currentLeg!.type === 'wait' ? 'buffer done' : `arrived ${stationName(idx, legDest(currentLeg!))}`}
            </button>
            <button onClick={() => logRunEvent({ kind: 'boarded', atMs: Date.now(), legId: currentLeg!.id })}>
              boarded
            </button>
            <button className="missed" onClick={missedTrain}>
              ✗ missed train (+{fmtDur(currentLegResult?.riskSec ?? 600)})
            </button>
          </div>
        </>
      )}

      <div className="upcoming">
        <h3 className="muted" style={{ margin: '4px 0' }}>up next</h3>
        {plan.legs.slice(run.currentLegIndex + 1, run.currentLegIndex + 8).map((leg, i) => {
          const lr = remaining.legs.find((l) => l.legId === leg.id);
          return <LegRow key={leg.id} idx={idx} plan={plan} leg={leg} n={run.currentLegIndex + i + 2} result={lr} />;
        })}
        <h3 className="muted" style={{ margin: '8px 0 4px' }}>
          unvisited not in remaining plan: {remaining.uncovered.length}
        </h3>
        {remaining.uncovered.length > 0 && remaining.uncovered.length <= 60 && (
          <div className="muted" style={{ fontSize: 15 }}>
            {remaining.uncovered.map((sid) => stationName(idx, sid)).join(' · ')}
          </div>
        )}
      </div>
    </div>
  );
}

function legDest(leg: Leg): string {
  if (leg.type === 'ride') return leg.alightStationId;
  if (leg.type === 'wait') return '';
  return leg.toStationId;
}

function CurrentLegView({ idx, leg }: { idx: NetworkIndex; leg: Leg }) {
  const { badge, text } = legSummary(idx, leg);
  return (
    <div className="dest">
      {badge && <span style={{
        background: idx.net.routes.find((r) => r.id === badge)?.color ?? '#555',
        borderRadius: '50%', padding: '2px 10px', marginRight: 8, fontSize: 23,
      }}>{badge}</span>}
      {text}
    </div>
  );
}

function ContingencyCard({ idx, branch, basePlan, doneCovered, baseline, onTake }: {
  idx: NetworkIndex;
  branch: { id: string; name: string; legs: Leg[]; driftThresholdSec: number };
  basePlan: Plan;
  doneCovered: string[];
  baseline: PlanResult;
  onTake: () => void;
}) {
  const alt = useMemo(() => evaluatePlan(idx, { ...basePlan, legs: branch.legs }, doneCovered),
    [idx, basePlan, branch, doneCovered]);
  return (
    <div className="contingency">
      <b>🔀 {branch.name}</b>
      <div className="rowflex" style={{ marginTop: 4 }}>
        <span>plan A: finish {fmtClock(baseline.endSec)} · {baseline.coveredCount}/{baseline.totalToCover}</span>
        <span>→ <b>plan B: finish {fmtClock(alt.endSec)} · {alt.coveredCount}/{alt.totalToCover}</b></span>
      </div>
      <button className="primary" style={{ marginTop: 6, width: '100%', padding: 12 }} onClick={onTake}>
        Take {branch.name} (replaces remaining legs)
      </button>
    </div>
  );
}

function exportLog(log: unknown[], kind: 'json' | 'csv') {
  let content: string;
  if (kind === 'json') {
    content = JSON.stringify(log, null, 2);
  } else {
    const rows = (log as Record<string, unknown>[]).map((e) =>
      [new Date(e.atMs as number).toISOString(), e.kind, e.legId ?? '', e.stationId ?? '', e.headwaySec ?? '', e.branchName ?? ''].join(','));
    content = 'timestamp,kind,legId,stationId,headwaySec,branchName\n' + rows.join('\n');
  }
  const blob = new Blob([content], { type: kind === 'json' ? 'application/json' : 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `run-log.${kind}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export { setState };
