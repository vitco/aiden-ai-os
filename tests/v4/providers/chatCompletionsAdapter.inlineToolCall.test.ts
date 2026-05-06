import { describe, it, expect } from 'vitest';

import { extractInlineToolCalls } from '../../../providers/v4/chatCompletionsAdapter';

/**
 * Phase 21 #4 — inline `<tool_call>` extraction (Hermes/Qwen format).
 *
 * The `<tool_call>...</tool_call>` wrapping is a public format used by
 * Nous Hermes / Qwen open-source models. These tests pin parser
 * behaviour to that format spec — closed tags, truncated tags, malformed
 * JSON, multiple calls in one stream — so a model regression fails
 * loudly here rather than silently leaking tool JSON to the user.
 */
describe('Phase 21 #4 — extractInlineToolCalls', () => {
  it('1. closed <tool_call> tag → synthesizes ToolCallRequest, strips from content', () => {
    const text =
      'Reasoning aside.\n<tool_call>{"name": "memory_read", "arguments": {"path": "USER.md"}}</tool_call>';
    const r = extractInlineToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls.length).toBe(1);
    expect(r!.toolCalls[0].name).toBe('memory_read');
    expect(r!.toolCalls[0].arguments).toEqual({ path: 'USER.md' });
    expect(r!.content).toBe('Reasoning aside.');
  });

  it('2. unclosed <tool_call> (truncated generation) is recovered', () => {
    const text = '<tool_call>{"name": "web_search", "arguments": {"query": "weather"}}';
    const r = extractInlineToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls[0].name).toBe('web_search');
    expect(r!.toolCalls[0].arguments).toEqual({ query: 'weather' });
    expect(r!.content).toBeNull(); // nothing before the tag
  });

  it('3. content without <tool_call> tag → null (no extraction, no false positive)', () => {
    expect(extractInlineToolCalls('Just regular text. {"foo": "bar"}')).toBeNull();
    expect(extractInlineToolCalls('')).toBeNull();
    expect(extractInlineToolCalls(null)).toBeNull();
    expect(extractInlineToolCalls(undefined)).toBeNull();
  });

  it('4. malformed JSON inside tag → null (no crash, no spurious tool call)', () => {
    const text = '<tool_call>not json at all</tool_call>';
    expect(extractInlineToolCalls(text)).toBeNull();
  });

  it('5. tag with name missing → skipped silently', () => {
    const text = '<tool_call>{"arguments": {"path": "x"}}</tool_call>';
    expect(extractInlineToolCalls(text)).toBeNull();
  });

  it('6. multiple tool_calls in one content → all extracted, content is everything before first tag', () => {
    const text =
      'Plan:\n<tool_call>{"name": "a", "arguments": {}}</tool_call><tool_call>{"name": "b", "arguments": {"k": 1}}</tool_call>';
    const r = extractInlineToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.toolCalls.map((tc) => tc.name)).toEqual(['a', 'b']);
    expect(r!.toolCalls[1].arguments).toEqual({ k: 1 });
    expect(r!.content).toBe('Plan:');
  });

  it('7. exactly the user-reported leak shape (verbatim) extracts cleanly', () => {
    // From the user's bug report — the full closed-form string the
    // model SHOULD have emitted parses to a clean tool call with no
    // leaked text in `content`.
    const text = '<tool_call>{"name": "memory_read", "arguments": {"path": "USER.md"}}</tool_call>';
    const r = extractInlineToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.content).toBeNull();
    expect(r!.toolCalls[0]).toEqual({
      id: expect.stringMatching(/^tc-inline-/),
      name: 'memory_read',
      arguments: { path: 'USER.md' },
    });
  });
});
