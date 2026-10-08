// M3-1 (Phase 3) — BudgetGuard client helper unit tests (dismissal +
// shouldShowBudgetModal). The fetch / pushTier paths are exercised
// end-to-end by the daemon test; this file pins the localStorage-only
// surface so a refactor doesn't accidentally nag the user every poll.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  budgetDismissalKey,
  dismissBudget,
  isBudgetDismissed,
  shouldShowBudgetModal,
  type BudgetStatusBody,
} from './budget-status';

function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, v); },
  } as Storage;
}

// Define (not assign): another file in the same bun process may have left a non-writable `localStorage` behind.
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: fakeStorage() });
});
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('M3-1 · budget dismissal helpers', () => {
  test('dismissal key is keyed by month + status', () => {
    expect(budgetDismissalKey('2026-05', 'warning')).toBe('elanous.budget.dismissed.2026-05.warning');
    expect(budgetDismissalKey('2026-05', 'cap-exceeded')).toBe('elanous.budget.dismissed.2026-05.cap-exceeded');
  });

  test('dismissBudget persists to localStorage · isBudgetDismissed reads it', () => {
    expect(isBudgetDismissed('2026-05', 'warning')).toBe(false);
    dismissBudget('2026-05', 'warning');
    expect(isBudgetDismissed('2026-05', 'warning')).toBe(true);
  });

  test('dismissing warning does NOT silence cap-exceeded (escalation re-opens)', () => {
    dismissBudget('2026-05', 'warning');
    expect(isBudgetDismissed('2026-05', 'warning')).toBe(true);
    expect(isBudgetDismissed('2026-05', 'cap-exceeded')).toBe(false);
  });

  test('new month resets dismissal automatically', () => {
    dismissBudget('2026-05', 'warning');
    expect(isBudgetDismissed('2026-06', 'warning')).toBe(false);
  });
});

describe('M3-1 · shouldShowBudgetModal', () => {
  const baseBody: BudgetStatusBody = {
    status: 'warning',
    percent: 85,
    monthlyUsdCap: 50,
    recommendedFallback: 'budget',
    notifyAtPct: 80,
    monthSoFarUsd: 42.5,
    monthYYYYMM: '2026-05',
  };

  test('returns false for ok status', () => {
    expect(shouldShowBudgetModal({ ...baseBody, status: 'ok', recommendedFallback: undefined }))
      .toBe(false);
  });

  test('returns true for warning with fallback · undismissed', () => {
    expect(shouldShowBudgetModal(baseBody)).toBe(true);
  });

  test('returns true for cap-exceeded with fallback · undismissed', () => {
    expect(shouldShowBudgetModal({ ...baseBody, status: 'cap-exceeded', percent: 110 })).toBe(true);
  });

  test('returns false if dismissed for same month + status', () => {
    dismissBudget('2026-05', 'warning');
    expect(shouldShowBudgetModal(baseBody)).toBe(false);
  });

  test('returns false defensively when recommendedFallback is missing', () => {
    expect(shouldShowBudgetModal({ ...baseBody, recommendedFallback: undefined })).toBe(false);
  });

  test('escalation: dismissed warning does NOT silence cap-exceeded', () => {
    dismissBudget('2026-05', 'warning');
    expect(shouldShowBudgetModal({ ...baseBody, status: 'cap-exceeded', percent: 110 })).toBe(true);
  });
});
