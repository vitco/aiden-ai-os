/**
 * core/v4/skillLoader.ts — Aiden v4.0.0
 *
 * Walks `paths.skillsDir` and loads every SKILL.md it finds. Two
 * layouts are supported:
 *
 *   skills/<skill-name>/SKILL.md          (preferred — one dir per skill,
 *                                          may include reference files)
 *   skills/<skill-name>.md                (single-file skill — v3 has 4
 *                                          of these: code_interpreter,
 *                                          folder_watch, social_research,
 *                                          system_control)
 *
 * Malformed SKILL.md files are SKIPPED with a console.warn — one bad
 * skill never breaks `loadAll()`. The optional `log` callback in the
 * constructor receives the same diagnostic so non-CLI hosts can pipe
 * it elsewhere.
 *
 * Status: PHASE 10.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from './paths';
import {
  parseSkillContent,
  type ParsedSkill,
} from './skillSpec';

export interface SkillSummary {
  name: string;
  description: string;
  version: string;
  category?: string;
  trustLevel?: string;
  userModified?: boolean;
  filePath: string;
}

export interface SkillLoaderOptions {
  log?: (level: 'warn' | 'info', msg: string) => void;
}

export class SkillLoader {
  constructor(
    private readonly paths: AidenPaths,
    private readonly options: SkillLoaderOptions = {},
  ) {}

  /** Walk skills/ and load every parseable SKILL.md (or single-file
   *  `<name>.md`). Unparseable files are skipped; one bad skill
   *  never breaks the others. */
  async loadAll(): Promise<ParsedSkill[]> {
    const out: ParsedSkill[] = [];
    let entries: string[];
    try {
      entries = await fs.readdir(this.paths.skillsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    for (const entry of entries) {
      const entryPath = path.join(this.paths.skillsDir, entry);
      let stat;
      try {
        stat = await fs.stat(entryPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const skillFile = path.join(entryPath, 'SKILL.md');
        const parsed = await this.tryParse(skillFile);
        if (parsed) out.push(parsed);
      } else if (stat.isFile() && entry.toLowerCase().endsWith('.md')) {
        // Single-file skills. Skip TEMPLATE / CATALOG markers.
        const lc = entry.toLowerCase();
        if (lc === 'aiden_catalog.md' || lc === 'skill_template.md') continue;
        const parsed = await this.tryParse(entryPath);
        if (parsed) out.push(parsed);
      }
    }
    return out;
  }

  async load(name: string): Promise<ParsedSkill | null> {
    const dirSkill = path.join(this.paths.skillsDir, name, 'SKILL.md');
    const fileSkill = path.join(this.paths.skillsDir, `${name}.md`);
    return (await this.tryParse(dirSkill)) ?? (await this.tryParse(fileSkill));
  }

  async list(): Promise<SkillSummary[]> {
    const skills = await this.loadAll();
    return skills.map((s) => ({
      name: s.frontmatter.name,
      description: s.frontmatter.description,
      version: s.frontmatter.version,
      category: s.frontmatter.category ?? s.frontmatter.metadata?.aiden?.category,
      trustLevel: s.frontmatter._trustLevel,
      userModified: undefined, // SkillLoader doesn't know; BundledManifest does.
      filePath: s.filePath,
    }));
  }

  /** Read a reference file inside a skill's directory. Used by
   *  `skill_view` for progressive-disclosure level 2. */
  async readSkillFile(skillName: string, relativePath: string): Promise<string> {
    const skillDir = path.join(this.paths.skillsDir, skillName);
    // Refuse path traversal: resolve, then check it stays inside skillDir.
    const target = path.resolve(skillDir, relativePath);
    const resolvedDir = path.resolve(skillDir);
    if (!target.startsWith(resolvedDir + path.sep) && target !== resolvedDir) {
      throw new Error(
        `Path traversal refused: ${relativePath} escapes skill directory`,
      );
    }
    return fs.readFile(target, 'utf-8');
  }

  // ── Internals ───────────────────────────────────────────────

  private async tryParse(filePath: string): Promise<ParsedSkill | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
    try {
      return parseSkillContent(raw, filePath);
    } catch (e) {
      const msg = `Skipping malformed skill at ${filePath}: ${(e as Error).message}`;
      this.options.log
        ? this.options.log('warn', msg)
        : console.warn(`[SkillLoader] ${msg}`);
      return null;
    }
  }
}
