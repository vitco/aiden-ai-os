/**
 * core/v4/__mocks__/mockProvider.ts — Aiden v4.0.0
 *
 * Scripted ProviderAdapter for AidenAgent loop tests. Each call() consumes
 * one entry from the script in order. Throws when the script is exhausted —
 * tests should script exactly the number of calls they expect.
 *
 * Use the `stop()` and `toolUse()` static helpers to build outputs without
 * boilerplate.
 */

import {
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  ToolCallRequest,
} from '../../../providers/v4/types';

export class MockProviderAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  private callCount = 0;
  /** Inputs captured for each call — useful for verifying message history grows correctly. */
  public readonly capturedInputs: ProviderCallInput[] = [];

  constructor(private scriptedResponses: ProviderCallOutput[]) {}

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    if (this.callCount >= this.scriptedResponses.length) {
      throw new Error(
        `MockProvider: no more scripted responses (call #${this.callCount + 1})`,
      );
    }
    this.capturedInputs.push({
      ...input,
      messages: [...input.messages],
    });
    return this.scriptedResponses[this.callCount++];
  }

  static stop(
    content: string,
    usage = { inputTokens: 10, outputTokens: 10 },
  ): ProviderCallOutput {
    return { content, toolCalls: [], finishReason: 'stop', usage };
  }

  static toolUse(
    toolCalls: ToolCallRequest[],
    usage = { inputTokens: 10, outputTokens: 10 },
  ): ProviderCallOutput {
    return { content: null, toolCalls, finishReason: 'tool_use', usage };
  }
}
