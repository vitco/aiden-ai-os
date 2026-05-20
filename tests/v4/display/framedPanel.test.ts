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

  it('every line starts with the left accent bar', () => {
    const out = stripAnsi(renderFramedPanel({
      title: 'Session', rows: baseRows, footer: 'type /<name> to run',
    }));
    const physicalLines = out.trim().split('\n');
    for (const line of physicalLines) {
      expect(line.startsWith('▎')).toBe(true);
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

  it('description truncates with ellipsis when wider than allocated column', () => {
    const long = 'x'.repeat(200);
    const out = stripAnsi(renderFramedPanel({
      title: 'X',
      rows: [{ command: '/c', description: long }],
      footer: 'h', width: 50,
    }));
    expect(out).toContain('…');
    // No row exceeds the configured inner width by much (allow some
    // slack for the bar + padding; just guard against unbounded output).
    for (const line of out.trim().split('\n')) {
      expect(line.length).toBeLessThan(80);
    }
  });
});
