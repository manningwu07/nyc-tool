import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from './store';
import type { Leg } from './engine/types';

function mockStorage() {
  const data = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: vi.fn((key: string) => { data.delete(key); }),
    clear: vi.fn(() => { data.clear(); }),
    key: vi.fn((i: number) => Array.from(data.keys())[i] ?? null),
    get length() { return data.size; },
  };
}

describe('store cross-tab persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', mockStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges partial writes onto the newest persisted state', async () => {
    const store = await import('./store');
    const stale = store.getState();
    const leg: Leg = { id: 'l1', type: 'wait', sec: 60 };
    const newer: AppState = {
      ...stale,
      plans: stale.plans.map((p) => (
        p.id === stale.activePlanId ? { ...p, legs: [leg] } : p
      )),
    };

    localStorage.setItem('subway-speedrun-v1', JSON.stringify(newer));
    store.setState({ comparePlanId: null });

    const saved = JSON.parse(localStorage.getItem('subway-speedrun-v1')!) as AppState;
    expect(saved.plans.find((p) => p.id === stale.activePlanId)?.legs).toEqual([leg]);
  });

  it('applies storage events from another tab', async () => {
    type StorageCallback = (e: { key: string; newValue: string | null }) => void;
    const storageCallbacks: StorageCallback[] = [];
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, cb: StorageCallback) => {
        if (type === 'storage') storageCallbacks.push(cb);
      }),
    });
    const store = await import('./store');
    const state = store.getState();
    const leg: Leg = { id: 'l2', type: 'wait', sec: 120 };
    const next: AppState = {
      ...state,
      plans: state.plans.map((p) => (
        p.id === state.activePlanId ? { ...p, legs: [leg] } : p
      )),
    };

    storageCallbacks[0]?.({ key: 'subway-speedrun-v1', newValue: JSON.stringify(next) });

    expect(store.activePlan(store.getState())?.legs).toEqual([leg]);
  });

  it('migrates imported aggregate weekday plans to Monday', async () => {
    const store = await import('./store');
    const oldPlan = {
      id: 'old', name: 'old', startStationId: '', startClockSec: 0,
      serviceDay: 'Weekday', legs: [], contingencies: {},
      config: { passThroughCounts: false, walkPaceMultiplier: 0.8 },
    };

    store.importPlan(JSON.stringify(oldPlan));

    expect(store.activePlan(store.getState())?.serviceDay).toBe('Monday');
  });
});
