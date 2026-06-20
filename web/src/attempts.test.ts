import { describe, expect, it } from 'vitest';
import type { Attempt } from './attempts';
import { attemptsCsv, attemptTags, planSignature, pruneAttempts, toCsv } from './attempts';
import type { Plan } from './engine/types';

function mkAttempt(over: Partial<Attempt>): Attempt {
  const plan = {
    id: 'p', name: over.id ?? 'plan', startStationId: '', startClockSec: 0,
    serviceDay: 'Monday', legs: [], contingencies: {},
    config: { passThroughCounts: false, walkPaceMultiplier: 0.8 },
  } as Plan;
  return {
    id: 'a', signature: over.id ?? 'sig', savedAtMs: 0, plan, coveredCount: 0,
    totalToCover: 472, elapsedSec: 80000, endSec: 100000, errorCount: 0, ...over,
  };
}

describe('planSignature', () => {
  it('ignores leg ids but not leg content or start conditions', () => {
    const base = mkAttempt({}).plan;
    const legs = (id: string, sec: number) => [{ id, type: 'wait', sec }] as Plan['legs'];
    const a = { ...base, legs: legs('x', 60) };
    expect(planSignature({ ...base, legs: legs('y', 60) })).toBe(planSignature(a));
    expect(planSignature({ ...base, legs: legs('x', 90) })).not.toBe(planSignature(a));
    expect(planSignature({ ...a, startClockSec: 1 })).not.toBe(planSignature(a));
  });
});

describe('pruneAttempts', () => {
  it('keeps 5 when best and latest are disjoint', () => {
    // best are the oldest three, latest are the newest two
    const as = [1, 2, 3, 4, 5].map((i) => mkAttempt({ id: `a${i}`, savedAtMs: i, coveredCount: 10 - i }));
    expect(pruneAttempts(as)).toHaveLength(5);
  });

  it('keeps top 3 best plus 2 latest', () => {
    // best by coverage: b470, b460, b450; latest by time: late1, late2
    const as = [
      mkAttempt({ id: 'b470', coveredCount: 470, savedAtMs: 1 }),
      mkAttempt({ id: 'b460', coveredCount: 460, savedAtMs: 2 }),
      mkAttempt({ id: 'b450', coveredCount: 450, savedAtMs: 3 }),
      mkAttempt({ id: 'old-bad', coveredCount: 100, savedAtMs: 4 }),
      mkAttempt({ id: 'late1', coveredCount: 200, savedAtMs: 5 }),
      mkAttempt({ id: 'late2', coveredCount: 150, savedAtMs: 6 }),
    ];
    const kept = pruneAttempts(as).map((a) => a.id).sort();
    expect(kept).toEqual(['b450', 'b460', 'b470', 'late1', 'late2']);
  });

  it('an attempt that is both best and latest counts once (fewer than 5 kept)', () => {
    const as = [
      mkAttempt({ id: 'a', coveredCount: 470, savedAtMs: 10 }), // best #1 and latest
      mkAttempt({ id: 'b', coveredCount: 460, savedAtMs: 9 }),  // best #2 and latest
      mkAttempt({ id: 'c', coveredCount: 450, savedAtMs: 1 }),
      mkAttempt({ id: 'd', coveredCount: 100, savedAtMs: 2 }),
    ];
    const kept = pruneAttempts(as).map((a) => a.id).sort();
    expect(kept).toEqual(['a', 'b', 'c']);
  });

  it('ties on coverage break by errors then elapsed time', () => {
    const as = [
      mkAttempt({ id: 'slow', coveredCount: 472, elapsedSec: 90000, savedAtMs: 1 }),
      mkAttempt({ id: 'fast', coveredCount: 472, elapsedSec: 70000, savedAtMs: 2 }),
      mkAttempt({ id: 'erry', coveredCount: 472, elapsedSec: 60000, errorCount: 2, savedAtMs: 3 }),
    ];
    expect(attemptTags(as, 'fast')).toContain('best #1');
    expect(attemptTags(as, 'slow')).toContain('best #2');
    expect(attemptTags(as, 'erry')).toContain('best #3');
  });
});

describe('csv', () => {
  it('escapes commas and quotes', () => {
    expect(toCsv([['a,b', 'say "hi"', 5]])).toBe('"a,b","say ""hi""",5\n');
  });

  it('attemptsCsv produces a header plus one row per attempt', () => {
    const as = [
      mkAttempt({ id: 'x', coveredCount: 472, savedAtMs: 1700000000000 }),
      mkAttempt({ id: 'y', coveredCount: 100, savedAtMs: 1700000100000 }),
    ];
    const lines = attemptsCsv(as).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('saved_at,plan,covered');
    expect(lines[1]).toContain('472'); // best ranked first
  });
});
