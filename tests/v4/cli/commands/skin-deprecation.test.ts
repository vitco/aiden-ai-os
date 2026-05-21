/**
 * tests/v4/cli/commands/skin-deprecation.test.ts — v4.9.0 Slice 1a.
 *
 * /skin still works but prints a deprecation pointer to /theme.
 */
import { describe, it, expect } from 'vitest';
import { skin } from '../../../../cli/v4/commands/skin';

describe('/skin deprecation banner — Slice 1a', () => {
  it('prints deprecation warning regardless of subcommand', async () => {
    const warns: string[] = [];
    const ctx = {
      args: [],
      rawArgs: '',
      paths: { root: '/tmp/x' },
      skin: undefined, // forces the early-return after the warning
      display: {
        warn: (m: string) => warns.push(m),
      },
    } as unknown as Parameters<typeof skin.handler>[0];
    await skin.handler(ctx);
    expect(warns.some((m) => /deprecated/.test(m) && /\/theme/.test(m))).toBe(true);
  });
});
