/**
 * Phase 16b — moat boot wiring tests for `buildAgentRuntime`.
 *
 * These tests verify the wiring (which moat layers are constructed, in
 * which mode, attached to which agent option) — NOT the runtime behaviour
 * of any moat layer. Each layer has its own behavioural test elsewhere
 * (`tests/v4/moat/*`, `tests/v4/aidenAgent.moat.test.ts`).
 *
 * We mock the heavy boot dependencies so the test stays fast and
 * deterministic: the provider resolver returns a fake adapter, MCP setup
 * returns no-op, and the underlying file system is redirected to an
 * isolated tmp dir per test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

vi.mock('../../../providers/v4/runtimeResolver', () => {
  return {
    RuntimeResolver: class {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(_resolver: unknown) {}
      async resolve(_o: unknown) {
        return {
          providerId: 'fake',
          modelId: 'fake-model',
          async call() {
            return {
              content: '',
              toolCalls: [],
              usage: { inputTokens: 0, outputTokens: 0 },
              finishReason: 'stop' as const,
            };
          },
        };
      }
    },
  };
});

vi.mock('../../../tools/v4/mcpSetup', () => ({
  setupMcpFromConfig: async () => ({ client: null, connected: [], failures: {} }),
}));

import { buildAgentRuntime } from '../../../cli/v4/aidenCLI';
import { PlannerGuard } from '../../../moat/plannerGuard';
import { HonestyEnforcement } from '../../../moat/honestyEnforcement';
import { SkillTeacher } from '../../../moat/skillTeacher';
import { MemoryGuard } from '../../../moat/memoryGuard';
import { SSRFProtection } from '../../../moat/ssrfProtection';
import { TirithScanner } from '../../../moat/tirithScanner';
import { resolveAidenPaths } from '../../../core/v4/paths';

let tmpRoot: string;
const stores: Array<{ close?: () => void }> = [];

function track<T extends { store: { close?: () => void } }>(runtime: T): T {
  stores.push(runtime.store);
  return runtime;
}

async function makeIsolatedHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-moatboot-'));
  await fs.mkdir(path.join(root, 'skills'), { recursive: true });
  await fs.mkdir(path.join(root, 'memories'), { recursive: true });
  await fs.mkdir(path.join(root, 'plugins'), { recursive: true });
  await fs.mkdir(path.join(root, 'logs'), { recursive: true });
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true });
  // Make config.yaml non-empty so isFreshInstall returns false. Phase 18
  // Task 7 also requires a non-empty providers: section.
  await fs.writeFile(
    path.join(root, 'config.yaml'),
    'model:\n  provider: fake\n  modelId: fake-model\nproviders:\n  fake:\n    apiKey: test\n',
    'utf8',
  );
  await fs.writeFile(path.join(root, '.env'), 'FAKE=1\n', 'utf8');
  return root;
}

async function writeConfig(root: string, body: Record<string, unknown>): Promise<void> {
  // Phase 18 Task 7: isFreshInstall now checks for an empty providers
  // section in addition to missing config.yaml. Inject a stub providers
  // entry so these moat-boot tests don't trip the wizard.
  const merged = body.providers
    ? body
    : { ...body, providers: { fake: { apiKey: 'test' } } };
  await fs.writeFile(path.join(root, 'config.yaml'), yaml.dump(merged), 'utf8');
}

beforeEach(async () => {
  tmpRoot = await makeIsolatedHome();
});

afterEach(async () => {
  while (stores.length > 0) {
    const s = stores.pop();
    try {
      s?.close?.();
    } catch {
      /* ignore */
    }
  }
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('Phase 16b — runInteractiveChat builds full moat at boot', () => {
  it('builds PlannerGuard with config mode (default rule_based)', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(await buildAgentRuntime({}, { pathsOverride: paths }));
    expect(runtime.plannerGuard).toBeInstanceOf(PlannerGuard);
    expect(runtime.plannerGuard.getMode()).toBe('rule_based');
    expect(runtime.plannerGuardMode).toBe('rule_based');
  });

  it('builds PlannerGuard with explicit config mode', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
      agent: { planner_guard_mode: 'off' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(await buildAgentRuntime({}, { pathsOverride: paths }));
    expect(runtime.plannerGuard.getMode()).toBe('off');
  });

  it('CLI flag overrides config for PlannerGuard', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
      agent: { planner_guard_mode: 'rule_based' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(
      await buildAgentRuntime(
        { plannerGuard: 'off' },
        { pathsOverride: paths },
      ),
    );
    expect(runtime.plannerGuard.getMode()).toBe('off');
  });

  it('builds HonestyEnforcement with config mode (default enforce)', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(await buildAgentRuntime({}, { pathsOverride: paths }));
    expect(runtime.honestyEnforcement).toBeInstanceOf(HonestyEnforcement);
    expect(runtime.honestyEnforcement.getMode()).toBe('enforce');
    expect(runtime.honestyMode).toBe('enforce');
  });

  it('CLI flag overrides config for HonestyEnforcement', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
      agent: { honesty_mode: 'enforce' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(
      await buildAgentRuntime(
        { honesty: 'detect' },
        { pathsOverride: paths },
      ),
    );
    expect(runtime.honestyEnforcement.getMode()).toBe('detect');
  });

  it('builds SkillTeacher with skillLoader and default tier_3_propose', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(await buildAgentRuntime({}, { pathsOverride: paths }));
    expect(runtime.skillTeacher).toBeInstanceOf(SkillTeacher);
    expect(runtime.skillTeacher.getTier()).toBe('tier_3_propose');
    expect(runtime.skillTeacherTier).toBe('tier_3_propose');
    expect(runtime.skillLoader).toBeDefined();
  });

  it('CLI flag overrides config for SkillTeacher', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
      agent: { skill_teacher_tier: 'tier_3_propose' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(
      await buildAgentRuntime(
        { skillTeacher: 'off' },
        { pathsOverride: paths },
      ),
    );
    expect(runtime.skillTeacher.getTier()).toBe('off');
  });

  it('builds MemoryGuard wrapping MemoryManager', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(await buildAgentRuntime({}, { pathsOverride: paths }));
    expect(runtime.memoryGuard).toBeInstanceOf(MemoryGuard);
    expect(runtime.memoryManager).toBeDefined();
  });

  it('builds stateless SSRFProtection + TirithScanner', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(await buildAgentRuntime({}, { pathsOverride: paths }));
    expect(runtime.ssrfProtection).toBeInstanceOf(SSRFProtection);
    expect(runtime.tirithScanner).toBeInstanceOf(TirithScanner);
  });

  it('attaches all 3 Phase 12 layers + Phase 13 callbacks to AidenAgent', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(await buildAgentRuntime({}, { pathsOverride: paths }));
    // Reach into the agent's private fields. The shape is part of
    // AidenAgent's stable surface (Phase 12); this assertion fails loudly
    // if the wiring drops.
    const agent = runtime.agent as unknown as Record<string, unknown>;
    expect(agent.plannerGuard).toBe(runtime.plannerGuard);
    expect(agent.honestyEnforcement).toBe(runtime.honestyEnforcement);
    expect(agent.skillTeacher).toBe(runtime.skillTeacher);
    expect(agent.skillTeacherCallbacks).toBeDefined();
    expect(agent.onPlannerGuardDecision).toBe(
      runtime.callbacks.onPlannerGuardDecision,
    );
    expect(agent.onCompression).toBe(runtime.callbacks.onCompression);
    expect(agent.onBudgetWarning).toBe(runtime.callbacks.onBudgetWarning);
    expect(typeof agent.resolveVerifiedFlag).toBe('function');
    expect(typeof agent.resolveToolset).toBe('function');
  });

  it('toolExecutor closes over Phase 9 ssrf — private URLs blocked', async () => {
    // The tool executor's ToolContext is captured by the closure inside
    // ToolRegistry.buildExecutor. We verify the wiring took effect via
    // behaviour: a network tool with a private URL gets blocked.
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(await buildAgentRuntime({}, { pathsOverride: paths }));
    const exec = runtime.toolRegistry.buildExecutor({
      cwd: process.cwd(),
      paths,
      ssrfProtection: runtime.ssrfProtection,
    });
    const result = await exec({
      id: 'test-1',
      name: 'fetch_url',
      arguments: { url: 'http://127.0.0.1/admin' },
    });
    expect(result.error ?? '').toMatch(/URL blocked|blocked/i);
  });

  it('invalid mode in config falls back to default', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
      agent: {
        planner_guard_mode: 'banana',
        honesty_mode: 'banana',
        skill_teacher_tier: 'banana',
      },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(await buildAgentRuntime({}, { pathsOverride: paths }));
    expect(runtime.plannerGuard.getMode()).toBe('rule_based');
    expect(runtime.honestyEnforcement.getMode()).toBe('enforce');
    expect(runtime.skillTeacher.getTier()).toBe('tier_3_propose');
  });

  it('agent receives the same provider adapter the resolver returned', async () => {
    await writeConfig(tmpRoot, {
      model: { provider: 'fake', modelId: 'fake-model' },
    });
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    const runtime = track(await buildAgentRuntime({}, { pathsOverride: paths }));
    const agent = runtime.agent as unknown as Record<string, unknown>;
    expect(agent.provider).toBe(runtime.adapter);
  });
});
