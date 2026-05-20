import { describe, it, expect } from 'vitest';
import {
  HonestyEnforcement,
  type HonestyTraceEntry,
} from '../../../moat/honestyEnforcement';

const trace = (entries: Partial<HonestyTraceEntry>[]): HonestyTraceEntry[] =>
  entries.map((e) => ({
    name: e.name ?? 'unknown',
    result: e.result ?? null,
    verified: e.verified,
    error: e.error,
  }));

// TODO(v4.7.0 Phase 2.3): tests assert deleted regex scanner. Rewrite against outcome-based recorder when that lands.
describe.skip('HonestyEnforcement — modes', () => {
  it('1. off mode passes everything', async () => {
    const h = new HonestyEnforcement('off');
    const res = await h.check(
      'I saved the file to ~/notes/today.md',
      [],
      [], // empty trace — would normally fail
    );
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
    expect(res.correctedResponse).toBeUndefined();
  });

  it('2. detect mode logs but does not modify response', async () => {
    let warnSeen = false;
    const h = new HonestyEnforcement('detect', undefined, (lvl) => {
      if (lvl === 'info') warnSeen = true;
    });
    const res = await h.check(
      'I saved the file to disk.',
      [],
      [], // no file_write
    );
    expect(res.passed).toBe(false);
    expect(res.correctedResponse).toBeUndefined();
    expect(warnSeen).toBe(true);
  });

  it('3. enforce mode rewrites failed claims', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check('I saved the file to disk.', [], []);
    expect(res.passed).toBe(false);
    expect(res.correctedResponse).toBeDefined();
    expect(res.correctedResponse).toContain('No tools were called');
  });
});

// TODO(v4.7.0 Phase 2.3): tests assert deleted regex scanner. Rewrite against outcome-based recorder when that lands.
describe.skip('HonestyEnforcement — file write claims', () => {
  it('4. "saved" + no file_write call → fail', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I saved the file to ~/notes/today.md',
      [],
      [],
    );
    expect(res.passed).toBe(false);
    expect(res.findings[0].found).toBe(false);
    expect(res.findings[0].reason).toBe('no_tool_call');
  });

  it('5. "saved" + file_write present → pass', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I saved the file to ~/notes/today.md',
      [],
      trace([{ name: 'file_write', result: { ok: true } }]),
    );
    expect(res.passed).toBe(true);
    expect(res.findings[0].found).toBe(true);
  });

  it('6. tool aliases recognized — file_patch counts for "saved" claim', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I saved the file to ~/notes/today.md',
      [],
      trace([{ name: 'file_patch', result: { ok: true } }]),
    );
    expect(res.passed).toBe(true);
  });
});

// TODO(v4.7.0 Phase 2.3): tests assert deleted regex scanner. Rewrite against outcome-based recorder when that lands.
describe.skip('HonestyEnforcement — memory claims (the moat)', () => {
  it('7. "remembered" + memory_add verified=true → pass', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I remembered that your favourite color is purple.',
      [],
      trace([{ name: 'memory_add', verified: true, result: { ok: true } }]),
    );
    expect(res.passed).toBe(true);
  });

  it('8. "remembered" + memory_add verified=false → FAIL (the moat)', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I remembered that your favourite color is purple.',
      [],
      trace([{ name: 'memory_add', verified: false, result: { ok: false } }]),
    );
    expect(res.passed).toBe(false);
    expect(res.findings[0].found).toBe(false);
    expect(res.findings[0].reason).toBe('memory_verified_false');
    expect(res.correctedResponse).toContain('NOT VERIFIED');
  });

  it('9. "remembered" + no memory_add at all → fail', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I remembered that your favourite color is purple.',
      [],
      [],
    );
    expect(res.passed).toBe(false);
    expect(res.findings[0].reason).toBe('no_tool_call');
  });
});

// TODO(v4.7.0 Phase 2.3): tests assert deleted regex scanner. Rewrite against outcome-based recorder when that lands.
describe.skip('HonestyEnforcement — other tool claims', () => {
  it('10. "searched" + web_search present → pass', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I searched and found the answer.',
      [],
      trace([{ name: 'web_search', result: { hits: [] } }]),
    );
    expect(res.passed).toBe(true);
  });

  it('11. "ran X" + shell_exec present → pass', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I ran the script and got a result.',
      [],
      trace([{ name: 'shell_exec', result: { stdout: '' } }]),
    );
    expect(res.passed).toBe(true);
  });
});

// TODO(v4.7.0 Phase 2.3): tests assert deleted regex scanner. Rewrite against outcome-based recorder when that lands.
describe.skip('HonestyEnforcement — multi-claim & edge cases', () => {
  it('12. multiple claims, mixed results: report all findings', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I saved the file to disk. I also searched for similar examples.',
      [],
      trace([{ name: 'file_write', result: { ok: true } }]),
      // web_search missing
    );
    expect(res.findings.length).toBeGreaterThanOrEqual(2);
    const passedClaims = res.findings.filter((f) => f.found);
    const failedClaims = res.findings.filter((f) => !f.found);
    expect(passedClaims.length).toBeGreaterThanOrEqual(1);
    expect(failedClaims.length).toBeGreaterThanOrEqual(1);
    expect(res.passed).toBe(false);
  });

  it('13. response with no action claims passes with empty findings', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'Sure, I can help with that. What would you like me to do?',
      [],
      [],
    );
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  it('14. future tense is NOT flagged as a claim', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I will save the file once you confirm the path.',
      [],
      [],
    );
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  it('15. negation handling: "I couldn\'t save" should NOT flag', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      "I couldn't save the file because the path was invalid.",
      [],
      [],
    );
    expect(res.passed).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  it('16. corrected response includes trace summary', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I saved your file.',
      [],
      trace([
        { name: 'web_search', result: { hits: [] } },
        { name: 'file_read', result: { content: '' } },
      ]),
    );
    expect(res.passed).toBe(false);
    expect(res.correctedResponse).toContain('web_search');
    expect(res.correctedResponse).toContain('file_read');
  });

  it('17. confidence scoring per finding', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check('I saved the file to disk.', [], []);
    expect(res.findings[0].confidence).toBeGreaterThan(0);
    expect(res.findings[0].confidence).toBeLessThanOrEqual(1);
    expect(res.confidence).toBeGreaterThan(0);
  });

  it('18. LLM-classified mode hooked but defaulted off (mode=off behavior unchanged)', async () => {
    // We just verify the constructor accepts a third llmAdapter arg without
    // requiring it; defaults match the documented behavior.
    const h = new HonestyEnforcement(); // default = enforce
    expect(h.getMode()).toBe('enforce');
    h.setMode('off');
    expect(h.getMode()).toBe('off');
    const res = await h.check('I saved a file.', [], []);
    expect(res.passed).toBe(true);
  });

  it('19. tool fired but errored → flagged as tool_errored', async () => {
    const h = new HonestyEnforcement('enforce');
    const res = await h.check(
      'I saved the file.',
      [],
      trace([{ name: 'file_write', error: 'EACCES' }]),
    );
    expect(res.passed).toBe(false);
    expect(res.findings[0].reason).toBe('tool_errored');
  });
});
