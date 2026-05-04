import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryManager } from '../../../core/v4/memoryManager';
import { MemoryGuard } from '../../../moat/memoryGuard';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { MemoryProvider } from '../../../core/v4/memoryProvider';
import type { MemoryFile } from '../../../core/v4/memoryManager';

let tmp: string;
let mgr: MemoryManager;
let guard: MemoryGuard;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mg-test-'));
  const paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(path.dirname(paths.memoryMd), { recursive: true });
  mgr = new MemoryManager(paths);
  guard = new MemoryGuard(mgr);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('MemoryGuard — guardedAdd', () => {
  it('1. writes content and verifies via re-read', async () => {
    const r = await guard.guardedAdd('memory', 'I prefer concise answers');
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
  });

  it('2. rejects empty content', async () => {
    const r = await guard.guardedAdd('memory', '   ');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/empty/i);
  });

  it('3. surfaces capacity-exceeded as ok=false, verified=false', async () => {
    const big = 'x'.repeat(2400);
    const r = await guard.guardedAdd('memory', big);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/capacity/i);
  });

  it('4. catches provider lying (claims ok=true, no write happened)', async () => {
    // A liar provider — returns ok:true but never persists.
    const liar: MemoryProvider = {
      name: 'liar',
      async loadSnapshot() {
        return { memoryMd: '', userMd: '', loadedAt: 0, isEmpty: true };
      },
      async add() { return { ok: true }; },
      async replace() { return { ok: true }; },
      async remove() { return { ok: true }; },
    };
    const liarGuard = new MemoryGuard(liar);
    const r = await liarGuard.guardedAdd('memory', 'fabricated note');
    expect(r.ok).toBe(false);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/verification failed/i);
  });
});

describe('MemoryGuard — guardedReplace', () => {
  it('5. verifies new content present, old content absent', async () => {
    await guard.guardedAdd('memory', 'I like coffee');
    const r = await guard.guardedReplace(
      'memory',
      'I like coffee',
      'I like tea',
    );
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toMatch(/I like tea/);
    expect(snap.memoryMd).not.toMatch(/I like coffee/);
  });

  it('6. rejects identical old/new texts', async () => {
    const r = await guard.guardedReplace('memory', 'foo', 'foo');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/identical/i);
  });

  it('7. surfaces missing-target cleanly', async () => {
    const r = await guard.guardedReplace('memory', 'absent', 'new');
    expect(r.ok).toBe(false);
    expect(r.verified).toBe(false);
  });
});

describe('MemoryGuard — guardedRemove', () => {
  it('8. verifies content gone after removal', async () => {
    await guard.guardedAdd('user', 'remove me later');
    const r = await guard.guardedRemove('user', 'remove me later');
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.userMd).not.toMatch(/remove me later/);
  });

  it('9. catches provider lying about remove', async () => {
    const liar: MemoryProvider = {
      name: 'liar',
      async loadSnapshot() {
        return {
          memoryMd: 'still here',
          userMd: '',
          loadedAt: 0,
          isEmpty: false,
        };
      },
      async add() { return { ok: true }; },
      async replace() { return { ok: true }; },
      async remove() { return { ok: true }; },
    };
    const liarGuard = new MemoryGuard(liar);
    const r = await liarGuard.guardedRemove('memory', 'still here');
    expect(r.ok).toBe(false);
    expect(r.verified).toBe(false);
  });
});

describe('MemoryGuard — file isolation', () => {
  it('10. memory and user files do not bleed', async () => {
    await guard.guardedAdd('memory', 'memory-only');
    await guard.guardedAdd('user', 'user-only');
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toMatch(/memory-only/);
    expect(snap.memoryMd).not.toMatch(/user-only/);
    expect(snap.userMd).toMatch(/user-only/);
    expect(snap.userMd).not.toMatch(/memory-only/);
  });
});
