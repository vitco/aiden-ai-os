/**
 * scripts/diag-autonomy.ts — Phase 16f autonomy diagnostic
 *
 * Reproduces Aiden's tool-selection behavior for a fuzzy multi-step
 * intent ("play me a popular song on youtube") to confirm or refute
 * the architectural hypothesis (PlannerGuard fallback narrows tools
 * too aggressively when no keyword rule matches).
 *
 * Does NOT make a real LLM call — keeps cost zero. Logs:
 *   1. PlannerGuard.decide() output (selectedTools / excludedTools / reason)
 *   2. Whether SkillTeacher / skill registry matches the intent
 *   3. The system-prompt skills slot Aiden builds
 */
import * as path from 'node:path';
import { PlannerGuard } from '../moat/plannerGuard';
import { ToolRegistry } from '../core/v4/toolRegistry';
import { registerAllTools } from '../tools/v4';
import { SkillLoader } from '../core/v4/skillLoader';
import { resolveAidenPaths } from '../core/v4/paths';

async function main() {
  const paths = resolveAidenPaths();
  const registry = new ToolRegistry();
  registerAllTools(registry);
  const allTools = registry.list();

  // ── Test message — fuzzy multi-step intent.
  const userMessage = 'play me a popular song on youtube';
  console.log('━'.repeat(72));
  console.log(`User message: "${userMessage}"`);
  console.log(`Total registered tools: ${allTools.length}`);
  console.log('━'.repeat(72));

  // ── 1. PlannerGuard.decide() with rule_based (the default).
  const guard = new PlannerGuard(
    {
      list: () => allTools,
      get: (n) => registry.get(n),
      getSchemas: () => registry.getSchemas(),
    },
    'rule_based',
  );
  const decision = await guard.decide(userMessage, []);
  console.log('\n[1] PlannerGuard decision (mode=rule_based):');
  console.log(`    reason:           ${decision.reason}`);
  console.log(`    selectedTools:    ${decision.selectedTools.length} tools`);
  console.log(`    selected:         ${decision.selectedTools.join(', ')}`);
  console.log(`    excluded count:   ${decision.excludedTools.length} tools`);
  console.log(`    excluded sample:  ${decision.excludedTools.slice(0, 8).join(', ')}…`);

  // ── 2. Skill registry: does any bundled skill match the intent?
  const skillLoader = new SkillLoader(paths.skillsDir);
  const skills = await skillLoader.list().catch(() => [] as any[]);
  console.log(`\n[2] Skill registry: ${skills.length} skills loaded`);
  const intentTokens = ['youtube', 'song', 'music', 'play', 'audio', 'video'];
  const fuzzyMatches = skills.filter((s: any) => {
    const blob = `${s.name ?? ''} ${s.description ?? ''}`.toLowerCase();
    return intentTokens.some((t) => blob.includes(t));
  });
  console.log(`    fuzzy matches for [${intentTokens.join(', ')}]:`);
  if (fuzzyMatches.length === 0) {
    console.log('      (none — no bundled skill mentions any of these tokens)');
  } else {
    for (const s of fuzzyMatches.slice(0, 5)) {
      console.log(`      - ${s.name}: ${(s.description ?? '').slice(0, 80)}`);
    }
  }

  // ── 3. What gets surfaced in the prompt's skills slot.
  const promptSkills = skills.slice(0, 32).map((s: any) => ({
    name: s.name,
    description: (s.description ?? '').slice(0, 120),
  }));
  console.log(`\n[3] Prompt skills slot: cap=32, surfaced=${promptSkills.length}`);
  console.log(`    framing: "## Available skills" (NOT "MUST load if relevant")`);
  if (skills.length > 32) {
    console.log(
      `    HIDDEN: ${skills.length - 32} skills past index 32 are NOT shown to the LLM`,
    );
  }

  // ── 4. What would Hermes do?
  console.log('\n[4] Comparison (Hermes pattern, see hermes-autonomy-audit.md):');
  console.log('    Hermes: all tools always passed to model (no per-turn filter).');
  console.log('    Hermes: skills slot framed as "MUST load if even partially relevant"');
  console.log('    Hermes: prompt has <act_dont_ask> + <prerequisite_checks> + autonomy directives');
  console.log('');
  console.log('    Aiden today: 3-tool subset on fuzzy intents (the bug).');
  console.log('    Aiden today: skills framed as "Available" (passive).');
  console.log('    Aiden today: SOUL.md has 1 line about action ("Default to action over discussion").');

  console.log('\n━'.repeat(72));
}

main().catch((err) => {
  console.error('diag failed:', err);
  process.exit(1);
});
