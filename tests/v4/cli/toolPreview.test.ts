import { describe, it, expect } from 'vitest';
import { buildToolPreview, TOOL_PRIMARY_ARG } from '../../../cli/v4/toolPreview';

/**
 * Phase v4.1.2 alive-core — per-tool preview rendering.
 *
 * Contract:
 *   - Known tool + primary-arg present  → returns the arg value
 *   - Known tool + no-arg-of-interest   → returns '' (caller renders bare name)
 *   - Unknown tool                      → returns null (caller falls back to JSON.stringify)
 *   - Long values are truncated with an ellipsis
 *   - Whitespace runs collapse for single-line rendering
 */
describe('buildToolPreview', () => {
  it('extracts terminal command verbatim', () => {
    expect(buildToolPreview('shell_exec', { command: 'npm test' })).toBe('npm test');
  });

  it('extracts file path', () => {
    expect(buildToolPreview('file_read', { path: 'README.md' })).toBe('README.md');
    expect(buildToolPreview('file_write', { path: '/tmp/x.md', content: 'hi' })).toBe('/tmp/x.md');
  });

  it('extracts web search query', () => {
    expect(buildToolPreview('web_search', { query: 'how to use vitest' }))
      .toBe('how to use vitest');
  });

  it('extracts memory_add content', () => {
    expect(buildToolPreview('memory_add', { file: 'memory', content: 'hello' }))
      .toBe('hello');
  });

  it('extracts execute_code primary arg', () => {
    expect(buildToolPreview('execute_code', { code: 'print(1+1)' })).toBe('print(1+1)');
  });

  it('extracts subagent_fanout mode', () => {
    expect(buildToolPreview('subagent_fanout', { mode: 'partition', n: 3 }))
      .toBe('partition');
  });

  it('returns empty string for known no-arg tools', () => {
    expect(buildToolPreview('skills_list', {})).toBe('');
    expect(buildToolPreview('system_info', {})).toBe('');
    expect(buildToolPreview('browser_close', undefined)).toBe('');
  });

  it('returns null for unknown tools so caller falls back', () => {
    expect(buildToolPreview('mystery_tool', { foo: 'bar' })).toBeNull();
  });

  it('truncates very long values with ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = buildToolPreview('shell_exec', { command: long });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(120);
    expect(out).toMatch(/…$/);
  });

  it('collapses whitespace so multi-line values stay one-line', () => {
    const out = buildToolPreview('shell_exec', { command: 'echo a\n  echo b\n\techo c' });
    expect(out).toBe('echo a echo b echo c');
  });

  it('serialises non-string primary args via JSON.stringify', () => {
    // Force a primary arg whose value is an object.
    expect(buildToolPreview('skill_manage', { action: { kind: 'install', id: 'x' } }))
      .toBe('{"kind":"install","id":"x"}');
  });

  it('handles missing primary arg gracefully (known tool, but no value)', () => {
    expect(buildToolPreview('shell_exec', {})).toBe('');
    expect(buildToolPreview('file_read', { other: 'oops' })).toBe('');
  });

  it('exposes TOOL_PRIMARY_ARG as a frozen-shape lookup', () => {
    // Spot-check entries the dispatch mentioned in the example map.
    expect(TOOL_PRIMARY_ARG['shell_exec']).toBe('command');
    expect(TOOL_PRIMARY_ARG['web_search']).toBe('query');
    expect(TOOL_PRIMARY_ARG['memory_add']).toBe('content');
    // Phase v4.1.2: session_summary lookup uses 'trigger' as preview.
    expect(TOOL_PRIMARY_ARG['session_summary']).toBe('trigger');
  });
});

// ── v4.1.4 Phase 3b' (Issue H1) — extractor function support ───────────────
//
// TOOL_PRIMARY_ARG now accepts either a string key OR a function.
// app_launch is the first function-style extractor: it handles the
// `explorer.exe` URI-protocol dispatch case where the meaningful
// target lives in `args[0]`, not in the `app` field.

describe('buildToolPreview — function extractors (v4.1.4 Phase 3b\')', () => {
  it('app_launch URI-protocol: explorer.exe + spotify:track → "spotify"', () => {
    const out = buildToolPreview('app_launch', {
      app:  'explorer.exe',
      args: ['spotify:track/3xyz'],
    });
    expect(out).toBe('spotify');
  });

  it('app_launch URI-protocol: case-insensitive on Explorer.EXE', () => {
    const out = buildToolPreview('app_launch', {
      app:  'Explorer.EXE',
      args: ['vscode:open/file.txt'],
    });
    expect(out).toBe('vscode');
  });

  it('app_launch URI-protocol: surfaces raw arg if no scheme', () => {
    // No `scheme:` prefix → fall through to the raw arg so the user
    // still sees what got launched.
    const out = buildToolPreview('app_launch', {
      app:  'explorer.exe',
      args: ['C:/some/path'],
    });
    expect(out).toBe('C:/some/path');
  });

  it('app_launch normal exe: surfaces the app name', () => {
    const out = buildToolPreview('app_launch', {
      app: 'firefox.exe',
    });
    expect(out).toBe('firefox.exe');
  });

  it('app_launch friendly name (no .exe): passes through', () => {
    const out = buildToolPreview('app_launch', { app: 'Spotify' });
    expect(out).toBe('Spotify');
  });

  it('app_launch empty args → empty preview (degraded gracefully)', () => {
    expect(buildToolPreview('app_launch', {})).toBe('');
    expect(buildToolPreview('app_launch', null)).toBe('');
    expect(buildToolPreview('app_launch', undefined)).toBe('');
  });

  it('app_launch extractor exception → empty (never crashes tool row)', () => {
    // Pass a getter that throws — extractor should catch and return ''.
    const evil = Object.defineProperty({} as Record<string, unknown>, 'app', {
      get() { throw new Error('boom'); },
    });
    const out = buildToolPreview('app_launch', evil);
    expect(out).toBe('');
  });

  it('clipboard_write surfaces text field (added in Phase 3b\')', () => {
    expect(buildToolPreview('clipboard_write', { text: 'hello world' }))
      .toBe('hello world');
  });

  it('clipboard_read: empty preview (no meaningful args)', () => {
    expect(buildToolPreview('clipboard_read', {})).toBe('');
  });

  it('string-key extractors still work (back-compat sentinel)', () => {
    // The function-extractor path must not break the legacy string-key
    // path. Spot-check a representative legacy entry.
    expect(buildToolPreview('shell_exec', { command: 'ls -la' }))
      .toBe('ls -la');
    expect(buildToolPreview('file_read', { path: '/tmp/x' }))
      .toBe('/tmp/x');
  });
});
