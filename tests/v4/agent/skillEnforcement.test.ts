/**
 * Phase 23.4b — skill enforcement tracker tests, focused on the new
 * `preArm()` method and the order-independence with `recordSkillView()`.
 *
 * Existing recordSkillView / evaluateOnFinal behavior is exercised
 * end-to-end in tests/v4/integration; this file covers the unit-level
 * pre-arm contract.
 */
import { describe, it, expect } from 'vitest';
import {
  SkillEnforcementTracker,
  type SkillEnforcementMetrics,
} from '../../../core/v4/agent/skillEnforcement';

function freshMetrics(): SkillEnforcementMetrics {
  return { recovered: 0, failed: 0, armed: 0, preArmed: 0 };
}

describe('SkillEnforcementTracker.preArm', () => {
  it('arms identically to recordSkillView when given non-empty required_tools', () => {
    const m = freshMetrics();
    const t = new SkillEnforcementTracker(m);
    t.preArm('media-search', ['youtube_search', 'open_url']);
    expect(t.armedSkill()).toBe('media-search');
    expect(m.armed).toBe(1);
    expect(m.preArmed).toBe(1);
  });

  it('preArm followed by recordSkillView does not double-bump armed', () => {
    const m = freshMetrics();
    const t = new SkillEnforcementTracker(m);
    t.preArm('media-search', ['youtube_search', 'open_url']);
    t.recordSkillView('media-search', ['youtube_search', 'open_url']);
    expect(t.armedSkill()).toBe('media-search');
    // armed bumps once total (the preArm); skill_view sees already-armed
    // and does not bump again.
    expect(m.armed).toBe(1);
    // preArmed counts the regex hit; skill_view doesn't touch it.
    expect(m.preArmed).toBe(1);
  });

  it('recordSkillView followed by preArm does not double-bump armed and does not overwrite the active skill', () => {
    const m = freshMetrics();
    const t = new SkillEnforcementTracker(m);
    t.recordSkillView('media-search', ['youtube_search', 'open_url']);
    // Pre-arm fires after the model already explicitly chose a skill —
    // the explicit choice wins, the regex pre-arm becomes a no-op-arm.
    t.preArm('media-search', ['youtube_search', 'open_url']);
    expect(t.armedSkill()).toBe('media-search');
    expect(m.armed).toBe(1);
    expect(m.preArmed).toBe(1);
  });

  it('preArm with empty required_tools is a no-op-arm (counter bumps, tracker stays disarmed)', () => {
    const m = freshMetrics();
    const t = new SkillEnforcementTracker(m);
    t.preArm('media-search', []);
    expect(t.armedSkill()).toBeNull();
    expect(m.armed).toBe(0);
    expect(m.preArmed).toBe(1);
  });

  it('preArm called twice for the same skill bumps preArmed each call but armed only once', () => {
    const m = freshMetrics();
    const t = new SkillEnforcementTracker(m);
    t.preArm('media-search', ['youtube_search', 'open_url']);
    t.preArm('media-search', ['youtube_search', 'open_url']);
    expect(m.armed).toBe(1);
    expect(m.preArmed).toBe(2);
  });

  it('evaluateOnFinal sees pre-armed state the same as skill_view-armed state', () => {
    const m = freshMetrics();
    const t = new SkillEnforcementTracker(m);
    t.preArm('media-search', ['youtube_search', 'open_url']);
    t.recordToolCall('youtube_search');
    // Missing open_url → first verdict is incomplete-can-retry.
    const verdict = t.evaluateOnFinal();
    expect(verdict.kind).toBe('incomplete-can-retry');
  });

  it('preArm with non-array required_tools is a no-op-arm (defensive)', () => {
    const m = freshMetrics();
    const t = new SkillEnforcementTracker(m);
    // @ts-expect-error — covering a runtime-defensive branch
    t.preArm('media-search', null);
    expect(t.armedSkill()).toBeNull();
    expect(m.armed).toBe(0);
    expect(m.preArmed).toBe(1);
  });
});
