/**
 * v4.9.1 amendment — /help lists the new /memory + /hooks slashes.
 * (/daemon was already mapped to the System subsection pre-amendment.)
 */
import { describe, it, expect } from 'vitest';
import { SUBSECTION_MAP } from '../../../../cli/v4/commands/help';
import { allCommands } from '../../../../cli/v4/commands';

describe('/help integration', () => {
  it('SUBSECTION_MAP includes memory + hooks + daemon under System', () => {
    expect(SUBSECTION_MAP.memory).toBe('System');
    expect(SUBSECTION_MAP.hooks).toBe('System');
    expect(SUBSECTION_MAP.daemon).toBe('System');
  });
  it('allCommands export includes the new memory + hooks slashes', () => {
    const names = allCommands.map((c) => c.name);
    expect(names).toContain('memory');
    expect(names).toContain('hooks');
    expect(names).toContain('daemon');
  });
  it('no duplicate slash-command names registered', () => {
    const names = allCommands.map((c) => c.name);
    const dups  = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dups).toEqual([]);
  });
});
