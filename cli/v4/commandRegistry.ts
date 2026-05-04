/**
 * cli/v4/commandRegistry.ts — Aiden v4.0.0 (Phase 14b)
 *
 * Central slash-command registry. Parses `/foo arg1 arg2` strings, routes
 * them to registered handlers, and exposes both `list()` (for `/help`) and
 * `filter()` (for the autocomplete dropdown landing in 14c).
 *
 * Hermes reference: hermes_cli/commands.py + hermes_cli/_parser.py.
 *
 * Status: PHASE 14b.
 */

import type { Display } from './display';
import type { SkinEngine } from './skinEngine';
import type { RuntimeResolver } from '../../providers/v4/runtimeResolver';
import type { ToolRegistry } from '../../core/v4/toolRegistry';
import type { SessionManager } from '../../core/v4/sessionManager';
import type { SkillLoader } from '../../core/v4/skillLoader';
import type { ConfigManager } from '../../core/v4/config';
import type { ContextCompressor } from '../../core/v4/contextCompressor';
import type { ApprovalEngine } from '../../moat/approvalEngine';
import type { McpClient } from '../../core/v4/mcpClient';
import type { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import type { SkillsHub } from '../../core/v4/skillsHub';
import type { Message } from '../../providers/v4/types';

/**
 * Lightweight session abstraction commands consume. The full chat REPL
 * (Phase 14c) implements this directly; tests provide stubs.
 */
export interface ChatSessionLike {
  history: Message[];
  setHistory(messages: Message[]): void;
  clearHistory(): void;
  getCurrentProvider(): string;
  getCurrentModel(): string;
  setProvider(providerId: string, modelId: string): Promise<void>;
  /** Optional — sessions persisted by SessionManager carry an id. */
  getSessionId?(): string | undefined;
  /** Optional — total token usage across the whole session. */
  getTotalUsage?(): { inputTokens: number; outputTokens: number };
}

/**
 * Slash-command execution context. Most fields are optional so unit tests
 * (and 14c's bootstrap path) can wire up only what each command needs.
 */
export interface SlashCommandContext {
  args: string[];
  rawArgs: string;
  display: Display;
  registry: CommandRegistry;
  session?: ChatSessionLike;
  resolver?: RuntimeResolver;
  toolRegistry?: ToolRegistry;
  sessionManager?: SessionManager;
  skillLoader?: SkillLoader;
  config?: ConfigManager;
  compressor?: ContextCompressor;
  approvalEngine?: ApprovalEngine;
  skin?: SkinEngine;
  mcpClient?: McpClient;
  auxiliaryClient?: AuxiliaryClient;
  skillsHub?: SkillsHub;
}

/** Result produced by a command handler. */
export interface SlashCommandResult {
  /** Caller (chat REPL) should exit after the handler returns. */
  exit?: boolean;
  /** Caller should drop conversation history. */
  clearHistory?: boolean;
}

export type SlashCommandHandler = (
  ctx: SlashCommandContext,
) => Promise<SlashCommandResult | void>;

export interface SlashCommand {
  name: string;
  description: string;
  category: 'system' | 'skill';
  /** Glyph rendered next to the name in `/help` and the autocomplete dropdown. */
  icon?: string;
  handler: SlashCommandHandler;
  aliases?: string[];
  /** Hide from the default `list()` and autocomplete (still callable). */
  hidden?: boolean;
}

/** What `parse()` produces. */
export interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

export interface ListOptions {
  includeHidden?: boolean;
  categoryFilter?: 'system' | 'skill';
}

/** Strip a leading slash and split on whitespace. */
function splitArgs(rest: string): { rawArgs: string; args: string[] } {
  const rawArgs = rest;
  const trimmed = rest.trim();
  const args = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  return { rawArgs, args };
}

export class CommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();
  private readonly aliasIndex = new Map<string, string>();

  register(cmd: SlashCommand): void {
    if (!cmd.name || cmd.name.includes(' ')) {
      throw new Error(`Invalid command name: ${JSON.stringify(cmd.name)}`);
    }
    this.commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const a of cmd.aliases) {
        this.aliasIndex.set(a, cmd.name);
      }
    }
  }

  unregister(name: string): void {
    const cmd = this.commands.get(name);
    if (!cmd) return;
    this.commands.delete(name);
    if (cmd.aliases) {
      for (const a of cmd.aliases) {
        if (this.aliasIndex.get(a) === name) {
          this.aliasIndex.delete(a);
        }
      }
    }
  }

  /** Lookup by canonical name OR by alias. */
  get(name: string): SlashCommand | null {
    const direct = this.commands.get(name);
    if (direct) return direct;
    const aliasTarget = this.aliasIndex.get(name);
    if (aliasTarget) return this.commands.get(aliasTarget) ?? null;
    return null;
  }

  /** All commands, sorted by name, optionally filtered by category. */
  list(opts: ListOptions = {}): SlashCommand[] {
    const { includeHidden = false, categoryFilter } = opts;
    const out: SlashCommand[] = [];
    for (const cmd of this.commands.values()) {
      if (!includeHidden && cmd.hidden) continue;
      if (categoryFilter && cmd.category !== categoryFilter) continue;
      out.push(cmd);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Parse `/foo bar baz` → `{ name: 'foo', args: ['bar', 'baz'], rawArgs: 'bar baz' }`.
   * Returns `null` for empty input or anything not starting with `/`.
   * Aliases are resolved here so handlers always see canonical names.
   */
  parse(input: string): ParsedCommand | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;

    const head = trimmed.slice(1);
    const spaceIdx = head.indexOf(' ');
    let nameToken: string;
    let rest: string;
    if (spaceIdx === -1) {
      nameToken = head;
      rest = '';
    } else {
      nameToken = head.slice(0, spaceIdx);
      rest = head.slice(spaceIdx + 1);
    }
    if (!nameToken) return null;

    // Resolve aliases.
    const canonical =
      this.commands.has(nameToken) ? nameToken : this.aliasIndex.get(nameToken);
    if (!canonical) {
      // Unknown command — still parseable (for /help "unknown command" UX).
      const split = splitArgs(rest);
      return { name: nameToken, args: split.args, rawArgs: split.rawArgs };
    }
    const split = splitArgs(rest);
    return { name: canonical, args: split.args, rawArgs: split.rawArgs };
  }

  /**
   * Parse + dispatch. Returns `{ handled: false }` for non-slash input so
   * the caller can route the line to the LLM instead.
   */
  async execute(
    input: string,
    ctx: Omit<SlashCommandContext, 'args' | 'rawArgs' | 'registry'>,
  ): Promise<{ handled: boolean; exit?: boolean; clearHistory?: boolean }> {
    const parsed = this.parse(input);
    if (!parsed) return { handled: false };

    const cmd = this.get(parsed.name);
    if (!cmd) {
      ctx.display.printError(
        `Unknown command: /${parsed.name}`,
        'Type /help for a list.',
      );
      return { handled: true };
    }

    const fullCtx: SlashCommandContext = {
      ...ctx,
      args: parsed.args,
      rawArgs: parsed.rawArgs,
      registry: this,
    };

    const raw = (await cmd.handler(fullCtx)) as SlashCommandResult | void;
    const result: SlashCommandResult = raw ? raw : {};
    return { handled: true, exit: result.exit, clearHistory: result.clearHistory };
  }

  /**
   * Autocomplete data feed for 14c's dropdown. `prefix` is the user's
   * partial input (with or without leading `/`). Matches against canonical
   * names (and aliases). Hidden commands are excluded.
   */
  filter(prefix: string): SlashCommand[] {
    let p = (prefix ?? '').trim();
    if (p.startsWith('/')) p = p.slice(1);
    const lower = p.toLowerCase();
    const out: SlashCommand[] = [];
    const seen = new Set<string>();
    for (const cmd of this.commands.values()) {
      if (cmd.hidden) continue;
      const nameMatches = cmd.name.toLowerCase().startsWith(lower);
      const aliasMatches =
        cmd.aliases?.some((a) => a.toLowerCase().startsWith(lower)) ?? false;
      if (nameMatches || aliasMatches) {
        if (!seen.has(cmd.name)) {
          out.push(cmd);
          seen.add(cmd.name);
        }
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
