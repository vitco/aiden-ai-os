import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { PromptBuilder, shouldInjectExecutionDiscipline } from '../../core/v4/promptBuilder';
import { resolveAidenPaths, ensureAidenDirsExist } from '../../core/v4/paths';

/**
 * Phase v4.1.2 alive-core — tool-conditional guidance + execution
 * discipline injection in the system-prompt builder.
 *
 * Contract:
 *   - When toolsetsLoaded contains 'memory'         → MEMORY_GUIDANCE present
 *   - When toolsetsLoaded contains 'session-search' → SESSION_SEARCH_GUIDANCE present
 *   - When toolsetsLoaded contains 'skills'         → SKILLS_GUIDANCE present
 *   - When toolsetsLoaded is undefined / empty      → none of the above present
 *   - Execution-discipline prose is always-on (current predicate)
 *   - All guidance lands AFTER USER.md and BEFORE the skills slot
 */
async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pb-alive-'));
}

const MEMORY_HEADER          = '## Persistent memory';
const SESSION_SEARCH_HEADER  = '## Session recall';
const SKILLS_HEADER          = '## Skill upkeep';
const EXECUTION_HEADER       = '## Tool use enforcement';

describe('PromptBuilder alive-core guidance slots', () => {
  it('omits all tool-conditional guidance when toolsetsLoaded is missing', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({ paths });
    expect(prompt).not.toContain(MEMORY_HEADER);
    expect(prompt).not.toContain(SESSION_SEARCH_HEADER);
    expect(prompt).not.toContain(SKILLS_HEADER);
  });

  it('omits all tool-conditional guidance when toolsetsLoaded is empty', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({
      paths,
      toolsetsLoaded: new Set(),
    });
    expect(prompt).not.toContain(MEMORY_HEADER);
    expect(prompt).not.toContain(SESSION_SEARCH_HEADER);
    expect(prompt).not.toContain(SKILLS_HEADER);
  });

  it('emits MEMORY_GUIDANCE only when "memory" toolset is loaded', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({
      paths,
      toolsetsLoaded: new Set(['memory']),
    });
    expect(prompt).toContain(MEMORY_HEADER);
    expect(prompt).not.toContain(SESSION_SEARCH_HEADER);
    expect(prompt).not.toContain(SKILLS_HEADER);
  });

  it('emits SESSION_SEARCH_GUIDANCE only when "session-search" toolset is loaded', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({
      paths,
      toolsetsLoaded: new Set(['session-search']),
    });
    expect(prompt).toContain(SESSION_SEARCH_HEADER);
    expect(prompt).not.toContain(MEMORY_HEADER);
    expect(prompt).not.toContain(SKILLS_HEADER);
  });

  it('emits SKILLS_GUIDANCE only when "skills" toolset is loaded', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({
      paths,
      toolsetsLoaded: new Set(['skills']),
    });
    expect(prompt).toContain(SKILLS_HEADER);
    expect(prompt).not.toContain(MEMORY_HEADER);
    expect(prompt).not.toContain(SESSION_SEARCH_HEADER);
  });

  it('emits all three blocks deterministically (memory → session → skills) when all three loaded', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({
      paths,
      toolsetsLoaded: new Set(['memory', 'skills', 'session-search']),
    });
    const memIdx = prompt.indexOf(MEMORY_HEADER);
    const ssIdx  = prompt.indexOf(SESSION_SEARCH_HEADER);
    const skIdx  = prompt.indexOf(SKILLS_HEADER);
    expect(memIdx).toBeGreaterThan(-1);
    expect(ssIdx).toBeGreaterThan(memIdx);
    expect(skIdx).toBeGreaterThan(ssIdx);
  });

  it('always emits the execution-discipline prose (current predicate is always-on)', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({ paths });
    expect(prompt).toContain(EXECUTION_HEADER);
  });

  it('shouldInjectExecutionDiscipline returns true regardless of model id', () => {
    expect(shouldInjectExecutionDiscipline(undefined)).toBe(true);
    expect(shouldInjectExecutionDiscipline('gpt-5.5')).toBe(true);
    expect(shouldInjectExecutionDiscipline('llama-3.3-70b-versatile')).toBe(true);
    expect(shouldInjectExecutionDiscipline('claude-opus-4-7')).toBe(true);
  });

  it('places tool-conditional guidance AFTER USER.md and BEFORE the skills slot', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const prompt = await (new PromptBuilder()).build({
      paths,
      toolsetsLoaded: new Set(['memory']),
      memorySnapshot: { memoryMd: '', userMd: 'I like terseness.' },
      skillsList: [{ name: 'demo-skill', description: 'demo' }],
    });
    const userIdx   = prompt.indexOf('I like terseness');
    const memIdx    = prompt.indexOf(MEMORY_HEADER);
    const skillsIdx = prompt.indexOf('## Skills (mandatory)');
    expect(userIdx).toBeGreaterThan(-1);
    expect(memIdx).toBeGreaterThan(userIdx);
    expect(skillsIdx).toBeGreaterThan(memIdx);
  });
});
