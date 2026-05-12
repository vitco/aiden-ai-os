import { describe, it, expect } from 'vitest';
import { evaluateExpectations } from '../../evals/runner';

/**
 * Phase v4.1.2-slice2 — eval runner expectation evaluator.
 *
 * `evaluateExpectations` is the pure logic core of the eval runner.
 * Unit-testable without an LLM: feed it a (toolCalls, response) pair
 * and a list of expectations, get back the human-readable failure
 * strings. Empty array = all passed.
 *
 * The runner end-to-end is exercised by `npm run eval` (live LLM, no
 * vitest gate) — this file covers the deterministic assertion
 * semantics so a future expectation type addition can't silently
 * regress the existing matchers.
 */
describe('evaluateExpectations', () => {
  const toolsEmpty: Array<{ name: string; args: unknown }> = [];
  const toolsRead = [{ name: 'file_read', args: { path: '/x' } }];

  it('returns empty when all expectations pass', () => {
    const f = evaluateExpectations(
      [
        { type: 'tool_called', toolName: 'file_read' },
        { type: 'absent',       text:     'fabricated' },
      ],
      toolsRead,
      'no such file',
    );
    expect(f).toEqual([]);
  });

  describe('tool_called', () => {
    it('passes when the named tool is in the trace', () => {
      const f = evaluateExpectations(
        [{ type: 'tool_called', toolName: 'file_read' }],
        toolsRead,
        '',
      );
      expect(f).toEqual([]);
    });
    it('fails when absent', () => {
      const f = evaluateExpectations(
        [{ type: 'tool_called', toolName: 'web_search' }],
        toolsRead,
        '',
      );
      expect(f).toHaveLength(1);
      expect(f[0]).toContain("'web_search'");
      expect(f[0]).toMatch(/expected.*called/);
    });
    it('includes the reason when supplied', () => {
      const f = evaluateExpectations(
        [{ type: 'tool_called', toolName: 'web_search', reason: 'needs live data' }],
        toolsRead,
        '',
      );
      expect(f[0]).toContain('needs live data');
    });
  });

  describe('tool_not_called', () => {
    it('passes when the named tool is absent', () => {
      const f = evaluateExpectations(
        [{ type: 'tool_not_called', toolName: 'web_search' }],
        toolsRead,
        '',
      );
      expect(f).toEqual([]);
    });
    it('fails when the tool was called', () => {
      const f = evaluateExpectations(
        [{ type: 'tool_not_called', toolName: 'file_read' }],
        toolsRead,
        '',
      );
      expect(f).toHaveLength(1);
      expect(f[0]).toMatch(/NOT.*called/);
    });
  });

  describe('contains', () => {
    it('passes case-insensitively', () => {
      const f = evaluateExpectations(
        [{ type: 'contains', text: 'FOO' }],
        toolsEmpty,
        'this is the foo bar baz',
      );
      expect(f).toEqual([]);
    });
    it('fails when missing', () => {
      const f = evaluateExpectations(
        [{ type: 'contains', text: 'qux' }],
        toolsEmpty,
        'this is the foo bar baz',
      );
      expect(f[0]).toMatch(/expected response to contain 'qux'/);
    });
  });

  describe('absent', () => {
    it('passes when the text is missing', () => {
      const f = evaluateExpectations(
        [{ type: 'absent', text: 'I found' }],
        toolsEmpty,
        'I am uncertain about this.',
      );
      expect(f).toEqual([]);
    });
    it('fails when the text is present (case-insensitive)', () => {
      const f = evaluateExpectations(
        [{ type: 'absent', text: 'i found' }],
        toolsEmpty,
        'According to my search, I FOUND that...',
      );
      expect(f).toHaveLength(1);
      expect(f[0]).toMatch(/NOT.*contain/);
      // Snippet should surround the hit with ellipses.
      expect(f[0]).toContain('I FOUND');
    });
  });

  describe('response_matches', () => {
    it('passes when the pattern matches', () => {
      const f = evaluateExpectations(
        [{ type: 'response_matches', pattern: /pid \d+/i }],
        toolsEmpty,
        'process pid 1234 was killed',
      );
      expect(f).toEqual([]);
    });
    it('fails when no match', () => {
      const f = evaluateExpectations(
        [{ type: 'response_matches', pattern: /pid \d+/i }],
        toolsEmpty,
        'no process running',
      );
      expect(f[0]).toMatch(/expected response to match/);
    });
  });

  describe('either', () => {
    it('passes when at least one option passes', () => {
      // Option B passes (the tool was NOT called) → overall pass.
      const f = evaluateExpectations(
        [{
          type: 'either',
          options: [
            { type: 'tool_called', toolName: 'web_search' },
            { type: 'absent',       text:     'fabricated content' },
          ],
        }],
        toolsRead,
        'safe response',
      );
      expect(f).toEqual([]);
    });
    it('fails only when every option fails', () => {
      const f = evaluateExpectations(
        [{
          type: 'either',
          options: [
            { type: 'tool_called', toolName: 'web_search' },
            { type: 'absent',       text:     'fabricated content' },
          ],
        }],
        toolsRead,
        'this response contains fabricated content',
      );
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(' OR ');
      // Both inner failures should appear in the aggregated message.
      expect(f[0]).toContain("'web_search'");
      expect(f[0]).toContain('fabricated content');
    });
    it('passes with deeply nested either branches', () => {
      const f = evaluateExpectations(
        [{
          type: 'either',
          options: [
            { type: 'either', options: [
              { type: 'tool_called', toolName: 'nope_one' },
              { type: 'tool_called', toolName: 'nope_two' },
            ]},
            { type: 'absent', text: 'never going to appear' },
          ],
        }],
        toolsRead,
        'ordinary response',
      );
      expect(f).toEqual([]);
    });
  });

  it('reports failures in declaration order for multi-expectation scenarios', () => {
    const f = evaluateExpectations(
      [
        { type: 'tool_called',  toolName: 'aaa' },
        { type: 'contains',     text:     'beta' },
        { type: 'tool_called',  toolName: 'ccc' },
      ],
      toolsEmpty,
      'no match here',
    );
    expect(f).toHaveLength(3);
    expect(f[0]).toContain("'aaa'");
    expect(f[1]).toContain("'beta'");
    expect(f[2]).toContain("'ccc'");
  });
});
