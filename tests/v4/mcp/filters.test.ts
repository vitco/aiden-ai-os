import { describe, it, expect } from 'vitest';
import { McpToolFilter } from '../../../core/v4/mcp/filters';

const tools = [
  { rawName: 'list_directory' },
  { rawName: 'read_file' },
  { rawName: 'write_file' },
  { rawName: 'delete_repo' },
  { rawName: 'force_push' },
];

describe('McpToolFilter', () => {
  const f = new McpToolFilter();

  it('returns all tools when no filter is given', () => {
    expect(f.filter(tools)).toEqual(tools);
    expect(f.filter(tools, {})).toEqual(tools);
  });

  it('include keeps only listed names', () => {
    expect(f.filter(tools, { include: ['read_file'] }).map((t) => t.rawName)).toEqual([
      'read_file',
    ]);
  });

  it('exclude wins over include', () => {
    const out = f.filter(tools, {
      include: ['*'],
      exclude: ['delete_repo', 'force_push'],
    });
    expect(out.map((t) => t.rawName)).toEqual(['list_directory', 'read_file', 'write_file']);
  });

  it('glob `*` matches everything', () => {
    expect(f.matches('anything', '*')).toBe(true);
  });

  it('glob with prefix matches', () => {
    expect(f.matches('list_directory', 'list_*')).toBe(true);
    expect(f.matches('read_file', 'list_*')).toBe(false);
  });

  it('glob `?` matches single char', () => {
    expect(f.matches('cat', 'c?t')).toBe(true);
    expect(f.matches('coat', 'c?t')).toBe(false);
  });

  it('empty list returns empty', () => {
    expect(f.filter([], { include: ['x'] })).toEqual([]);
  });

  it('exclude alone (no include) only removes matched', () => {
    const out = f.filter(tools, { exclude: ['*_repo', '*_push'] });
    expect(out.map((t) => t.rawName)).toEqual(['list_directory', 'read_file', 'write_file']);
  });
});
