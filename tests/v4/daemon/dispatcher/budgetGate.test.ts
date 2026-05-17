/**
 * v4.5 Phase 7 — budget gate + daily tracker tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import {
  createDailyBudgetTracker,
  utcDateKey,
} from '../../../../core/v4/daemon/dispatcher/dailyBudgetTracker';
import {
  evaluatePreTurn,
  consumePostTurn,
  createPerTurnBudgetWatcher,
} from '../../../../core/v4/daemon/dispatcher/budgetGate';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('utcDateKey', () => {
  it('formats yyyy-mm-dd in UTC', () => {
    expect(utcDateKey(Date.UTC(2026, 4, 17, 12, 0, 0))).toBe('2026-05-17');
  });
  it('rolls over at midnight UTC', () => {
    const beforeMidnight = Date.UTC(2026, 4, 17, 23, 59, 0);   // May 17 23:59 UTC
    const afterMidnight  = Date.UTC(2026, 4, 18, 0,  1,  0);   // May 18 00:01 UTC
    expect(utcDateKey(beforeMidnight)).toBe('2026-05-17');
    expect(utcDateKey(afterMidnight)).toBe('2026-05-18');
  });
});

describe('createDailyBudgetTracker — addAndCheck', () => {
  it('unlimited budget always allows', () => {
    const t = createDailyBudgetTracker({ db });
    expect(t.addAndCheck(100, { budget: null }).allowed).toBe(true);
    expect(t.addAndCheck(999999, { budget: null }).allowed).toBe(true);
  });

  it('rejects when consume would exceed budget', () => {
    const t = createDailyBudgetTracker({ db, budget: 1000 });
    expect(t.addAndCheck(800).allowed).toBe(true);
    expect(t.addAndCheck(300).allowed).toBe(false);
    // Used did not increment after rejection.
    expect(t.peek().used).toBe(800);
  });

  it('rejects further consumes once exhausted', () => {
    const t = createDailyBudgetTracker({ db, budget: 100 });
    expect(t.addAndCheck(100).allowed).toBe(true);
    expect(t.peek().exhausted).toBe(true);
    expect(t.addAndCheck(1).allowed).toBe(false);
  });

  it('separate UTC day rolls over (new key, fresh budget)', () => {
    const t = createDailyBudgetTracker({ db, budget: 100 });
    const day1 = Date.UTC(2026, 4, 17, 12, 0, 0);
    const day2 = Date.UTC(2026, 4, 18, 12, 0, 0);
    expect(t.addAndCheck(100, { now: day1 }).allowed).toBe(true);
    expect(t.addAndCheck(1, { now: day1 }).allowed).toBe(false);
    // Day 2 has its own row → fresh budget.
    expect(t.addAndCheck(50, { now: day2 }).allowed).toBe(true);
  });

  it('peek does not consume', () => {
    const t = createDailyBudgetTracker({ db, budget: 100 });
    t.addAndCheck(50);
    expect(t.peek().used).toBe(50);
    expect(t.peek().used).toBe(50);
  });
});

describe('evaluatePreTurn', () => {
  it('exhausted → allowed=false with trigger_quota reason', () => {
    const t = createDailyBudgetTracker({ db, budget: 100 });
    t.addAndCheck(100);
    const v = evaluatePreTurn({ tracker: t, dailyBudget: 100 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/trigger_quota/);
  });

  it('estimated tokens would exceed → allowed=false', () => {
    const t = createDailyBudgetTracker({ db, budget: 100 });
    t.addAndCheck(80);
    const v = evaluatePreTurn({ tracker: t, dailyBudget: 100, estimatedTokens: 50 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/exceeds remaining/);
  });

  it('estimated within remaining → allowed=true (no consume)', () => {
    const t = createDailyBudgetTracker({ db, budget: 100 });
    t.addAndCheck(50);
    const v = evaluatePreTurn({ tracker: t, dailyBudget: 100, estimatedTokens: 30 });
    expect(v.allowed).toBe(true);
    expect(v.daily.used).toBe(50);   // peek did not consume
  });
});

describe('consumePostTurn', () => {
  it('zero tokens → no consume', () => {
    const t = createDailyBudgetTracker({ db, budget: 100 });
    const snap = consumePostTurn({ tracker: t, actualTokens: 0, dailyBudget: 100 });
    expect(snap.used).toBe(0);
  });

  it('positive tokens consume + return updated snapshot', () => {
    const t = createDailyBudgetTracker({ db, budget: 100 });
    const snap = consumePostTurn({ tracker: t, actualTokens: 25, dailyBudget: 100 });
    expect(snap.used).toBe(25);
    expect(snap.remaining).toBe(75);
  });
});

describe('createPerTurnBudgetWatcher', () => {
  it('aborts the signal when cumulative tokens cross maxTokensPerFire', () => {
    const w = createPerTurnBudgetWatcher({ maxTokensPerFire: 100 });
    expect(w.hit()).toBe(false);
    w.tally(50);
    expect(w.hit()).toBe(false);
    expect(w.signal.aborted).toBe(false);
    w.tally(60);   // 110 > 100
    expect(w.hit()).toBe(true);
    expect(w.signal.aborted).toBe(true);
    expect(w.reason()).toMatch(/per_trigger_budget_exhausted/);
  });

  it('null maxTokensPerFire → never trips', () => {
    const w = createPerTurnBudgetWatcher({ maxTokensPerFire: null });
    w.tally(999999);
    expect(w.hit()).toBe(false);
    expect(w.signal.aborted).toBe(false);
  });

  it('manual abort flips state + signal', () => {
    const w = createPerTurnBudgetWatcher({ maxTokensPerFire: 100 });
    w.abort('manual stop');
    expect(w.hit()).toBe(true);
    expect(w.reason()).toBe('manual stop');
    expect(w.signal.aborted).toBe(true);
  });
});
