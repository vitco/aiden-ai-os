/**
 * providers/v4/runtimeResolver.ts — Aiden v4.0.0
 *
 * Maps (providerId, modelId) → fully-wired `ProviderAdapter`.
 *
 * Walks the credential precedence chain:
 *   1. `apiKeyOverride` (CLI arg)
 *   2. `config.get('providers.{id}.apiKey')` (config.yaml — stub for Phase 5)
 *   3. `process.env[entry.apiKeyEnvVar]`
 *   4. `credentialResolver.getCredentialsForMode(apiMode)` (auth.json OAuth)
 *   5. Local providers (ollama) — no credentials needed
 *
 * Error contract: throws `ProviderError` with a clear, user-actionable
 * message when the provider/model is unknown or no credentials can be
 * resolved. The "available: ..." list in the error keeps the picker
 * unblocked even when the user typoed a name.
 *
 * Status: PHASE 5.
 *
 * Hermes reference: hermes_cli/runtime_provider.py — resolve_runtime_provider().
 *   Hermes branches on provider id with explicit per-provider handlers;
 *   Aiden v4 collapses these into one switch on `apiMode` because the
 *   per-provider quirks (URL stripping, OpenCode model-family inference,
 *   Azure auth bypass, AWS SDK chain) are deferred to Phase 8 / 13.
 */

import { ApiMode, ProviderAdapter, RuntimeResolution } from './types';
import { ProviderError } from './errors';
import {
  PROVIDER_REGISTRY,
  ProviderRegistryEntry,
  getProviderEntry,
} from './registry';
import {
  MODEL_CATALOG,
  ModelEntry,
  findModel,
  listModelsForProvider,
} from './modelCatalog';
import { CredentialResolver } from './credentialResolver';
import { ChatCompletionsAdapter } from './chatCompletionsAdapter';
import { AnthropicAdapter } from './anthropicAdapter';
import { CodexResponsesAdapter } from './codexResponsesAdapter';
import { OllamaPromptToolsAdapter } from './ollamaPromptToolsAdapter';

/** Stub for Phase 6+ config.yaml parser. */
export interface ConfigProvider {
  get(key: string): string | undefined;
}

export interface ResolveOptions {
  providerId: string;
  modelId: string;
  /** Override for API key — used by tests + CLI args. */
  apiKeyOverride?: string;
  /** Override for base URL — used by `custom_openai` and tests. */
  baseUrlOverride?: string;
  /** Reserved for `aiden doctor` diagnostics — currently unused. */
  credentialSourceHint?: 'cli' | 'config' | 'env' | 'auth.json' | 'default';
  /** Optional config provider (Phase 6+); Phase 5 leaves this undefined. */
  config?: ConfigProvider;
}

interface ResolvedCredentials {
  apiKey: string | null;
  source: RuntimeResolution['source'];
  oauthRefreshable?: boolean;
}

export class RuntimeResolver {
  constructor(private readonly credentialResolver: CredentialResolver) {}

  /**
   * Build a fully-wired adapter for `(providerId, modelId)`. Throws
   * `ProviderError` when the provider, model, or credentials are missing.
   */
  async resolve(options: ResolveOptions): Promise<ProviderAdapter> {
    const { entry, model, baseUrl, credentials } = await this.describeInternal(options);

    switch (entry.apiMode) {
      case 'chat_completions':
        if (!credentials.apiKey) {
          throw missingKeyError(entry);
        }
        return new ChatCompletionsAdapter({
          baseUrl,
          apiKey: credentials.apiKey,
          model: model.id,
          providerName: entry.id,
          extraHeaders: entry.extraHeaders,
        });

      case 'anthropic_messages':
        if (!credentials.apiKey) {
          throw missingKeyError(entry);
        }
        return new AnthropicAdapter({
          baseUrl,
          apiKey: credentials.apiKey,
          authMode: credentials.source === 'auth.json' ? 'oauth' : 'api_key',
          model: model.id,
          providerName: entry.id,
          extraHeaders: entry.extraHeaders,
        });

      case 'codex_responses':
        if (!credentials.apiKey) {
          throw missingKeyError(entry);
        }
        return new CodexResponsesAdapter({
          baseUrl,
          apiKey: credentials.apiKey,
          model: model.id,
          providerName: entry.id,
          extraHeaders: entry.extraHeaders,
        });

      case 'ollama_prompt_tools':
        return new OllamaPromptToolsAdapter({
          baseUrl,
          model: model.id,
          providerName: entry.id,
        });

      default:
        // Exhaustiveness guard — switch covers every member of ApiMode.
        throw new ProviderError(
          `Unsupported apiMode '${entry.apiMode satisfies never}' for provider '${entry.id}'.`,
          entry.id,
        );
    }
  }

  /**
   * Returns the resolution data without instantiating an adapter.
   * Useful for `aiden doctor` diagnostics or dry-run previews.
   */
  async describe(options: ResolveOptions): Promise<RuntimeResolution> {
    const { entry, baseUrl, credentials } = await this.describeInternal(options);
    return {
      provider: entry.id,
      apiMode: entry.apiMode,
      baseUrl,
      apiKey: credentials.apiKey,
      oauthRefreshable: credentials.oauthRefreshable,
      source: credentials.source,
    };
  }

  /** All providers in registry order — feeds the picker UI. */
  listProviders(): ProviderRegistryEntry[] {
    return Object.values(PROVIDER_REGISTRY);
  }

  /** All models for `providerId`. Empty when unknown — never throws. */
  listModels(providerId: string): ModelEntry[] {
    return listModelsForProvider(providerId);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async describeInternal(options: ResolveOptions): Promise<{
    entry: ProviderRegistryEntry;
    model: ModelEntry;
    baseUrl: string;
    credentials: ResolvedCredentials;
  }> {
    const entry = getProviderEntry(options.providerId);
    if (!entry) {
      const available = Object.keys(PROVIDER_REGISTRY).join(', ');
      throw new ProviderError(
        `Provider '${options.providerId}' not found. Available: ${available}`,
        options.providerId,
      );
    }

    const model = findModel(entry.id, options.modelId);
    if (!model) {
      const available = listModelsForProvider(entry.id)
        .map((m) => m.id)
        .join(', ');
      throw new ProviderError(
        `Model '${options.modelId}' not found for provider '${entry.id}'. ` +
          `Available: ${available || '(none)'}`,
        entry.id,
      );
    }

    const baseUrl = (options.baseUrlOverride ?? entry.baseUrl).replace(/\/+$/, '');
    const credentials = await this.resolveCredentials(entry, options);
    return { entry, model, baseUrl, credentials };
  }

  private async resolveCredentials(
    entry: ProviderRegistryEntry,
    options: ResolveOptions,
  ): Promise<ResolvedCredentials> {
    // 1. CLI override.
    if (options.apiKeyOverride && options.apiKeyOverride.length > 0) {
      return { apiKey: options.apiKeyOverride, source: 'cli' };
    }

    // 2. Config provider (stub for Phase 5).
    if (options.config) {
      const fromConfig = options.config.get(`providers.${entry.id}.apiKey`);
      if (fromConfig && fromConfig.length > 0) {
        return { apiKey: fromConfig, source: 'config' };
      }
    }

    // 3. Env var.
    if (entry.apiKeyEnvVar) {
      const fromEnv = process.env[entry.apiKeyEnvVar];
      if (fromEnv && fromEnv.length > 0) {
        return { apiKey: fromEnv, source: 'env' };
      }
    }

    // 4. OAuth via credentialResolver.
    if (
      entry.apiMode === 'anthropic_messages' ||
      entry.apiMode === 'codex_responses'
    ) {
      try {
        const creds = await this.credentialResolver.getCredentialsForMode(entry.apiMode);
        const refreshed = await this.credentialResolver.refreshIfNeeded(creds);
        const token = refreshed.oauthToken ?? refreshed.apiKey;
        if (token && token.length > 0) {
          return {
            apiKey: token,
            source: 'auth.json',
            oauthRefreshable: refreshed.oauthRefreshable,
          };
        }
      } catch (err) {
        // No usable auth.json entry — surface a clearer error for OAuth-only
        // providers (claude_subscription, chatgpt_subscription) and fall
        // through for paid providers that still might succeed via a missing
        // env var (handled by the missingKeyError below).
        if (entry.apiKeyEnvVar === null) {
          throw new ProviderError(
            `OAuth credentials missing or expired for ${entry.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            entry.id,
            undefined,
            err,
          );
        }
      }
    }

    // 5. Local providers — no credentials required.
    if (entry.apiMode === 'ollama_prompt_tools') {
      return { apiKey: null, source: 'default' };
    }

    return { apiKey: null, source: 'default' };
  }
}

function missingKeyError(entry: ProviderRegistryEntry): ProviderError {
  if (entry.apiKeyEnvVar) {
    return new ProviderError(
      `No API key found for ${entry.id}. Set the ${entry.apiKeyEnvVar} environment variable ` +
        `or add it to config.yaml under providers.${entry.id}.apiKey.`,
      entry.id,
    );
  }
  return new ProviderError(
    `No credentials found for ${entry.id}. Run 'aiden model' to authenticate.`,
    entry.id,
  );
}

// Make MODEL_CATALOG re-exportable at the resolver entry point so callers
// don't need to import from two files when both are needed.
export { MODEL_CATALOG };
