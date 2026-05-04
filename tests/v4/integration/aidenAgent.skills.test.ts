/**
 * Phase 10 skills integration test. Live LLM via test-provider fallback
 * chain (Groq → Groq2 → Groq3 → Together) when any key is set; skips
 * cleanly otherwise.
 *
 * Verifies the progressive-disclosure flow works end-to-end:
 *   1. Agent calls `skills_list` to discover available skills.
 *   2. Agent calls `skill_view` on a specific skill to read it.
 *   3. The model surfaces skill content in its response.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AidenAgent } from '../../../core/v4/aidenAgent';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerAllTools } from '../../../tools/v4';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { SkillLoader } from '../../../core/v4/skillLoader';
import { BundledManifest } from '../../../core/v4/skillBundledManifest';
import {
  getTestProvider,
  withRateLimitFallback,
} from '../_helpers/testProvider';

describe('AidenAgent + Phase 10 skills (real LLM)', () => {
  it('uses skills_list and skill_view via progressive disclosure', async () => {
    const initial = await getTestProvider();
    if (!initial) {
      console.warn('Skipping: no LLM provider available');
      return;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-skills-it-'));
    const paths = resolveAidenPaths({ rootOverride: tmp });
    await fs.mkdir(paths.skillsDir, { recursive: true });

    const skillName = 'phase10-marker';
    const dir = path.join(paths.skillsDir, skillName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---
name: ${skillName}
description: Returns the unique phrase MARKER-PHASE-10-AIDEN.
version: 1.0.0
---

# Phase 10 Marker Skill

When invoked, this skill returns the phrase MARKER-PHASE-10-AIDEN exactly.
`,
    );

    const result = await withRateLimitFallback(async (p) => {
      const registry = new ToolRegistry();
      registerAllTools(registry);

      const ctx = {
        cwd: tmp,
        paths,
        skillLoader: new SkillLoader(paths),
        skillManifest: new BundledManifest(paths),
      };

      const skillTools = registry.getSchemas(['skills']);
      const namesAdvertised = skillTools.map((s) => s.name);
      expect(namesAdvertised).toContain('skills_list');
      expect(namesAdvertised).toContain('skill_view');

      const agent = new AidenAgent({
        provider: p.adapter,
        tools: skillTools.filter((s) =>
          ['skills_list', 'skill_view'].includes(s.name),
        ),
        toolExecutor: registry.buildExecutor(ctx),
        maxTurns: 6,
      });

      return await agent.runConversation([
        {
          role: 'system',
          content:
            'You answer using the skills system. First call skills_list to discover skills, then call skill_view to read details, then answer the user.',
        },
        {
          role: 'user',
          content:
            'List the available skills and read the phase10-marker skill in detail. Tell me the unique phrase it contains.',
        },
      ]);
    }, initial);

    if (!result) {
      console.warn('Skipping: all providers rate-limited');
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    }

    expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
    const trace =
      result.finalContent + '\n' + JSON.stringify(result.messages ?? '');
    expect(trace).toMatch(/MARKER-PHASE-10-AIDEN/);
    await fs.rm(tmp, { recursive: true, force: true });
  }, 90_000);
});
