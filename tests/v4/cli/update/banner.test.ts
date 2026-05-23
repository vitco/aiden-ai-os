/**
 * v4.9.1 — modal-after-banner ordering.
 * Source-check: the chatSession startup-card flow must emit a blank
 * line BEFORE `maybeShowBootUpdatePrompt()` so the modal box can't
 * visually overlap the welcome banner.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(
  path.join(__dirname, '../../../../cli/v4/chatSession.ts'),
  'utf8',
);

describe('renderStartupCard → modal ordering', () => {
  it('emits a blank line before maybeShowBootUpdatePrompt()', () => {
    const idxModal = SRC.indexOf('await this.maybeShowBootUpdatePrompt()');
    expect(idxModal).toBeGreaterThan(0);
    // Look at the 6 lines preceding the modal call.
    const preceding = SRC.slice(Math.max(0, idxModal - 200), idxModal);
    expect(preceding).toMatch(/display\.write\(\s*['"`]\\n['"`]\s*\)/);
  });
});
