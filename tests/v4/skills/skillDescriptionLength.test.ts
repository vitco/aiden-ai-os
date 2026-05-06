import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Phase 22 Group C, Task 8 + smoke-fix #4 — CI guard.
 *
 * Every bundled skill's description must fit on a single 80-column
 * terminal line so /skills, /help completion menus, and the boot-card
 * skill summary don't wrap. The audit + tightening pass landed across
 * 57 skills; this test prevents regression as new skills are added.
 *
 * Reads BOTH source-of-truth files:
 *   - SKILL.md frontmatter `description:` line — what skillLoader
 *     actually returns to /skills (the previous version of this test
 *     only read skill.json and missed the smoke-bug entirely).
 *   - skill.json `description` field — kept in sync for any consumer
 *     that prefers structured metadata.
 *
 * To bump the cap, justify the change here AND in the audit doc at
 * `_internal/hermes-ux-patterns.md` §8C.a.
 */
const MAX_DESCRIPTION_CHARS = 80;
const SKILLS_DIR = path.resolve(__dirname, '..', '..', '..', 'skills');

/** Extract the `description:` value from a SKILL.md YAML frontmatter. */
function readFrontmatterDescription(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') return null;
    const m = lines[i].match(/^description:\s*(.*)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

describe('bundled skill description length', () => {
  it(`every SKILL.md frontmatter description fits in ${MAX_DESCRIPTION_CHARS} chars`, async () => {
    // This is the assertion that mirrors what users see at runtime —
    // skillLoader reads `s.frontmatter.description`. The companion
    // skill.json check below catches drift between the two files.
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    const overflow: { skill: string; length: number; description: string }[] = [];
    for (const e of entries) {
      // Two skill shapes are recognised by skillLoader:
      //   1. Directory containing SKILL.md (most bundled skills)
      //   2. Top-level <name>.md single-file skill
      //      (e.g. code_interpreter.md, system_control.md)
      let mdPath: string | null = null;
      let label = e.name;
      if (e.isDirectory()) {
        mdPath = path.join(SKILLS_DIR, e.name, 'SKILL.md');
      } else if (
        e.isFile() &&
        e.name.toLowerCase().endsWith('.md') &&
        e.name.toLowerCase() !== 'aiden_catalog.md' &&
        e.name.toLowerCase() !== 'skill_template.md'
      ) {
        mdPath = path.join(SKILLS_DIR, e.name);
        label = e.name.replace(/\.md$/i, '');
      }
      if (!mdPath) continue;
      let raw: string;
      try {
        raw = await fs.readFile(mdPath, 'utf8');
      } catch {
        continue;
      }
      const desc = readFrontmatterDescription(raw) ?? '';
      if (desc.length > MAX_DESCRIPTION_CHARS) {
        overflow.push({ skill: label, length: desc.length, description: desc });
      }
    }

    if (overflow.length > 0) {
      const detail = overflow
        .map((o) => `  - ${o.skill} (${o.length} chars): ${o.description}`)
        .join('\n');
      throw new Error(
        `${overflow.length} SKILL.md description(s) exceed ${MAX_DESCRIPTION_CHARS} chars:\n${detail}\n\n` +
          `Run \`node scripts/tighten-skill-descriptions.cjs\` after adding the offending skill(s) to its REWRITES map.`,
      );
    }
    expect(overflow).toEqual([]);
  });

  it('every skill.json description fits in 80 chars and matches the SKILL.md frontmatter', async () => {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    const overflow: string[] = [];
    const drift: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(SKILLS_DIR, e.name);
      let manifest: { description?: string };
      try {
        manifest = JSON.parse(await fs.readFile(path.join(dir, 'skill.json'), 'utf8'));
      } catch {
        continue;
      }
      const jsonDesc = manifest.description ?? '';
      if (jsonDesc.length > MAX_DESCRIPTION_CHARS) {
        overflow.push(`${e.name} (${jsonDesc.length} chars)`);
      }
      try {
        const md = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
        const mdDesc = readFrontmatterDescription(md);
        if (mdDesc !== null && mdDesc !== jsonDesc) {
          drift.push(
            `${e.name}: SKILL.md "${mdDesc}" vs skill.json "${jsonDesc}"`,
          );
        }
      } catch {
        /* no SKILL.md — pure JSON skill, skip drift check */
      }
    }
    expect(overflow).toEqual([]);
    expect(drift).toEqual([]);
  });

  it('every bundled skill manifest has a non-empty description', async () => {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    const missing: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(SKILLS_DIR, e.name, 'skill.json');
      try {
        const raw = await fs.readFile(p, 'utf8');
        const m = JSON.parse(raw);
        if (typeof m.description !== 'string' || m.description.trim().length === 0) {
          missing.push(e.name);
        }
      } catch {
        // No manifest — bucket directory like installed/, skip.
      }
    }
    expect(missing).toEqual([]);
  });
});
