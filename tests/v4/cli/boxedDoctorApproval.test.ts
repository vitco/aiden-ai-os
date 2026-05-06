import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';

import { renderHealthBox, type DoctorReport } from '../../../cli/v4/doctor';
import { renderApprovalBox } from '../../../cli/v4/callbacks';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeDisplay(opts: { mono: boolean }): Display {
  const out = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  return new Display({
    skin: new SkinEngine({ forceMono: opts.mono }),
    stdout: out,
  });
}

const SAMPLE_REPORT: DoctorReport = {
  results: [
    { name: 'config file', passed: true, message: '/home/x/.aiden/config.yaml', durationMs: 1 },
    { name: 'provider auth', passed: true, message: '1 provider key (TOGETHER_API_KEY)', durationMs: 1 },
    {
      name: 'ollama',
      passed: false,
      message: 'not reachable',
      suggestion: 'install from https://ollama.com',
      durationMs: 5,
    },
    { name: 'python', passed: true, message: '3.11.9', durationMs: 30 },
    { name: 'docker', passed: true, message: '29.2.1', durationMs: 28 },
  ],
  passed: false,
  totalMs: 468,
};

describe('renderHealthBox (Phase 22 Task 5A)', () => {
  it('opens with a rounded box top titled "Health Check"', () => {
    const display = makeDisplay({ mono: true });
    const out = renderHealthBox(SAMPLE_REPORT, display);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^╭── Health Check /);
  });

  it('closes with a rounded box bottom border', () => {
    const display = makeDisplay({ mono: true });
    const lines = renderHealthBox(SAMPLE_REPORT, display).split('\n');
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
  });

  it('renders one row per check with the passed/warn/failed glyph', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderHealthBox(SAMPLE_REPORT, display));
    // Passed: ✓; failed: ✗ (ollama row).
    expect(out).toMatch(/✓\s+config file\s+\/home\/x\/\.aiden\/config\.yaml/);
    expect(out).toMatch(/✓\s+python\s+3\.11\.9/);
    expect(out).toMatch(/✗\s+ollama\s+not reachable/);
  });

  it('emits a hint continuation line for failed checks with a suggestion', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderHealthBox(SAMPLE_REPORT, display));
    expect(out).toMatch(/hint: install from https:\/\/ollama\.com/);
  });

  it('footer summary shows passedCount of total + duration', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderHealthBox(SAMPLE_REPORT, display));
    expect(out).toMatch(/4 of 5 checks passed in 468 ms/);
  });

  it('coloured output uses the brand orange #FF6B35 for box borders', () => {
    const display = makeDisplay({ mono: false });
    const out = renderHealthBox(SAMPLE_REPORT, display);
    expect(out).toContain('\x1b[38;2;255;107;53m');
    // No grey #808080.
    expect(out).not.toContain('\x1b[38;2;128;128;128m');
  });

  it('all-pass report shows summary in success colour', () => {
    const display = makeDisplay({ mono: false });
    const allPass: DoctorReport = {
      ...SAMPLE_REPORT,
      results: SAMPLE_REPORT.results.map((r) => ({ ...r, passed: true, suggestion: undefined })),
      passed: true,
    };
    const out = renderHealthBox(allPass, display);
    // success colour in default skin = #4CAF50 → rgb 76, 175, 80.
    expect(out).toContain('\x1b[38;2;76;175;80m');
  });
});

describe('renderApprovalBox (Phase 22 Task 5B)', () => {
  const SAMPLE_REQ = {
    toolName: 'file_delete',
    category: 'filesystem',
    args: { path: 'C:\\Users\\shiva\\backups\\old.zip' },
    riskTier: 'caution' as const,
    reason: 'destructive operation',
  };

  it('opens with a rounded box top titled "Approval required"', () => {
    const display = makeDisplay({ mono: true });
    const out = renderApprovalBox(SAMPLE_REQ as any, display);
    expect(out.split('\n')[0]).toMatch(/^╭── Approval required /);
  });

  it('renders Tool, Reason, and Args fields inside the box', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderApprovalBox(SAMPLE_REQ as any, display));
    expect(out).toMatch(/Tool: file_delete/);
    expect(out).toMatch(/Reason: destructive operation/);
    expect(out).toMatch(/Args: \{"path":"C:\\\\Users\\\\shiva\\\\backups\\\\old\.zip"\}/);
  });

  it('omits the Reason row when no reason is supplied', () => {
    const display = makeDisplay({ mono: true });
    const noReason = { ...SAMPLE_REQ, reason: undefined };
    const out = stripAnsi(renderApprovalBox(noReason as any, display));
    expect(out).not.toMatch(/Reason:/);
    expect(out).toMatch(/Tool: file_delete/);
  });

  it('truncates oversized args with an ellipsis', () => {
    const display = makeDisplay({ mono: true });
    const big = { ...SAMPLE_REQ, args: { blob: 'x'.repeat(500) } };
    const out = stripAnsi(renderApprovalBox(big as any, display));
    // Args line ends with the truncation ellipsis.
    expect(out).toMatch(/Args: \{"blob":"x+…/);
  });

  it('shows the [y]/[a]/[n] action keys at the bottom', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderApprovalBox(SAMPLE_REQ as any, display));
    expect(out).toMatch(/\[y\] allow once.*\[a\] allow always.*\[n\] deny/);
  });

  it('coloured output uses yellow (warn) for box borders', () => {
    const display = makeDisplay({ mono: false });
    const out = renderApprovalBox(SAMPLE_REQ as any, display);
    // warn colour in default skin = #FFC107 → rgb 255, 193, 7.
    expect(out).toContain('\x1b[38;2;255;193;7m');
    expect(out).not.toContain('\x1b[38;2;128;128;128m'); // no grey
  });
});
