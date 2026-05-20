import { describe, it, expect } from 'vitest';
import { renderFramedPanel } from '../../../cli/v4/display/framedPanel';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

describe('framedPanel — v4.8.0 Slice 4 Aiden-native chrome', () => {
  const baseRows = [
    { command: '/help',  description: 'List available slash commands.' },
    { command: '/model', description: 'Switch the active provider/model.' },
    { command: '/clear', description: 'Clear conversation history.' },
  ];

  it('every line carries the 2-space indent + left accent bar', () => {
    const out = stripAnsi(renderFramedPanel({
      title: 'Session', rows: baseRows, footer: 'type /<name> to run',
    }));
    // Slice 4 hotfix — bar lands at col 2 (after 2-space indent), not
    // col 0. Don't `.trim()` the output before splitting because that
    // strips the first line's leading whitespace.
    const physicalLines = out.split('\n').filter(l => l.length > 0);
    for (const line of physicalLines) {
      expect(line.startsWith('  ▎')).toBe(true);
    }
  });

  it('no closing bottom border — asymmetric chrome signature', () => {
    const out = stripAnsi(renderFramedPanel({
      title: 'X', rows: baseRows, footer: 'hint',
    }));
    // No box corners ever — and no trailing line that's purely the
    // bottom of a frame (`└──┘` style).
    expect(out).not.toContain('└');
    expect(out).not.toContain('┘');
    expect(out).not.toContain('┌');
    expect(out).not.toContain('┐');
  });

  it('title + subtitle render on the first line; subtitle right-aligned', () => {
    const out = stripAnsi(renderFramedPanel({
      title: 'Skills', subtitle: '11 commands', rows: baseRows, footer: 'h',
    }));
    const firstLine = out.split('\n')[0];
    expect(firstLine).toContain('Skills');
    expect(firstLine).toContain('11 commands');
    // Subtitle lands AFTER the title (right-aligned positioning).
    expect(firstLine.indexOf('Skills')).toBeLessThan(firstLine.indexOf('11 commands'));
  });

  it('footer is always rendered and matches the supplied text', () => {
    const out = stripAnsi(renderFramedPanel({
      title: 'X', rows: baseRows,
      footer: 'type /<name> to run · /help for this list',
    }));
    expect(out).toContain('type /<name> to run');
    expect(out).toContain('/help for this list');
    // Footer is the LAST non-empty line.
    const lines = out.trim().split('\n');
    expect(lines[lines.length - 1]).toContain('type /<name> to run');
  });

  it('top + bottom dividers paint horizontal lines (not corners)', () => {
    const out = stripAnsi(renderFramedPanel({
      title: 'X', rows: baseRows, footer: 'h',
    }));
    // Two divider rows: ─ filled, no corner glyphs.
    const dividerRows = out.split('\n').filter(l => l.includes('───'));
    expect(dividerRows.length).toBeGreaterThanOrEqual(2);
  });

  it('args column renders when supplied; absent otherwise (no extra padding)', () => {
    const withArgs = stripAnsi(renderFramedPanel({
      title: 'X',
      rows: [{ command: '/view', args: '<name>', description: 'Preview a skill' }],
      footer: 'h',
    }));
    expect(withArgs).toContain('<name>');
    const noArgs = stripAnsi(renderFramedPanel({
      title: 'X', rows: baseRows, footer: 'h',
    }));
    expect(noArgs).not.toContain('<');
  });

  it('long description WRAPS to continuation lines, no ellipsis', () => {
    // Slice 4 hotfix — replace truncation with smart word-boundary
    // wrap. Long text spans multiple visual rows under the same
    // panel row; continuation lines indent to the description column.
    const out = stripAnsi(renderFramedPanel({
      title: 'X',
      rows: [{
        command: '/cmd',
        description: 'one two three four five six seven eight nine ten eleven twelve thirteen',
      }],
      footer: 'h', width: 40,
    }));
    expect(out).not.toContain('…');
    // Should produce at least 2 wrapped continuation lines (so the
    // row body occupies ≥ 3 panel lines: 2 wrap + the cmd-leading line).
    const bodyLines = out.split('\n').filter(l => l.includes('▎  '));
    expect(bodyLines.length).toBeGreaterThan(2);
  });

  it('respects terminal width when opts.width is omitted', () => {
    const orig = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    try {
      const out = stripAnsi(renderFramedPanel({
        title: 'X',
        rows: [{ command: '/c', description: 'short desc' }],
        footer: 'h',
      }));
      // At 200 cols the divider should be much wider than the legacy
      // 72-col cap. Look at the divider row length.
      const divider = out.split('\n').find(l => l.includes('────')) ?? '';
      expect(divider.length).toBeGreaterThan(100);
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: orig, configurable: true });
    }
  });
});
