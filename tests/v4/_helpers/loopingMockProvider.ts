/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/_helpers/loopingMockProvider.ts — v4.1.6 spike (TCE).
 *
 * Synthetic `ProviderAdapter` that issues N back-to-back tool calls
 * with the same tool name (and optionally same args), then a terminal
 * text-only response. Drives the TurnState recovery state machine
 * in integration tests without needing a live provider.
 *
 * Three modes:
 *
 *   - 'same-signature': returns identical (name + args) every call →
 *     trips the signature-streak counter (hint stage at 5).
 *
 *   - 'same-name-diff-args': returns same tool name with monotonically
 *     varying args ({name: 's0'} → {name: 's1'} → …) → trips the
 *     name-streak counter (cooldown at 8, surface at 11) but does
 *     NOT trip the signature-streak counter (hint should not fire).
 *
 *   - 'mixed': realistic-ish — first 3 calls use different tools,
 *     then 8 same-name skill_view to demonstrate the surface
 *     card's `canStill` includes the earlier successful tools.
 */
import type {
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  StreamEvent,
  ApiMode,
} from '../../../providers/v4/types';

export type LoopingMockMode =
  | 'same-signature'
  | 'same-name-diff-args'
  | 'mixed';

export interface LoopingMockOptions {
  mode:          LoopingMockMode;
  loopTool:      string;             // tool name that loops (e.g. 'skill_view')
  loopCount:     number;             // how many times to loop before terminal text
  /** Args used when mode === 'same-signature'. */
  staticArgs?:   Record<string, unknown>;
  /** Override terminal-text content. */
  terminalText?: string;
  /**
   * Honored by the loop-controlling logic — when the agent excludes
   * the loop tool from `effectiveTools` (cooldown), this mock returns
   * a terminal text response immediately instead of trying to fall
   * back to other tools (which would muddy test assertions).
   */
  honorCooldown?: boolean;
}

/**
 * Build the synthetic provider. Tracks `callCount` so tests can
 * assert the agent stopped invoking it at the expected point.
 */
export class LoopingMockProvider implements ProviderAdapter {
  readonly apiMode: ApiMode = 'chat_completions';
  callCount: number = 0;
  /** Tool names visible to the model on each call (mirrors `tools` arg). */
  lastToolNames: string[] = [];

  constructor(public readonly opts: LoopingMockOptions) {}

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    this.callCount += 1;
    this.lastToolNames = (input.tools ?? []).map((t) => t.name);

    const { mode, loopTool, loopCount, terminalText, honorCooldown } = this.opts;

    // If the loop tool has been filtered out (cooldown applied),
    // and `honorCooldown` is on, return terminal text immediately
    // so the test can observe the cooldown effect cleanly.
    if (honorCooldown && !this.lastToolNames.includes(loopTool)) {
      return makeText(terminalText ?? 'done (loop tool unavailable)');
    }

    // Past the loop budget → terminal text.
    if (this.callCount > loopCount) {
      return makeText(terminalText ?? 'done');
    }

    // Generate the looping tool call per mode.
    switch (mode) {
      case 'same-signature': {
        return makeToolCall(loopTool, this.opts.staticArgs ?? { name: 'demo' }, this.callCount);
      }
      case 'same-name-diff-args': {
        return makeToolCall(loopTool, { name: `s${this.callCount - 1}` }, this.callCount);
      }
      case 'mixed': {
        // First 3 calls are unique tools (web_search, fetch_page,
        // execute_code), then loop on `loopTool` for the remainder.
        if (this.callCount === 1) return makeToolCall('web_search',   { q: 'foo' },                   1);
        if (this.callCount === 2) return makeToolCall('fetch_page',   { url: 'http://x' },           2);
        if (this.callCount === 3) return makeToolCall('execute_code', { code: '1+1' },               3);
        return makeToolCall(loopTool, { name: `s${this.callCount - 4}` }, this.callCount);
      }
      default: {
        return makeText(terminalText ?? 'done');
      }
    }
  }

  // Streaming path mirrors `call` — yields one terminal `done` event.
  // Tests don't drive the streaming path here; non-streaming covers
  // the recovery semantics fully.
  async *callStream(input: ProviderCallInput): AsyncGenerator<StreamEvent, void, void> {
    const output = await this.call(input);
    yield { type: 'done', output };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeText(content: string): ProviderCallOutput {
  return {
    content,
    toolCalls:    [],
    finishReason: 'stop',
    usage:        { inputTokens: 0, outputTokens: content.length / 4 },
  };
}

function makeToolCall(
  name: string,
  args: Record<string, unknown>,
  callId: number,
): ProviderCallOutput {
  return {
    content:      '',
    toolCalls:    [{ id: `c${callId}`, name, arguments: args }],
    finishReason: 'tool_use',
    usage:        { inputTokens: 0, outputTokens: 0 },
  };
}
