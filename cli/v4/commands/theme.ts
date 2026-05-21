/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/theme.ts — v4.9.0 Slice 1a.
 *
 * `/theme`              show current theme name + path + hint
 * `/theme reload`       force re-read of ~/.aiden/theme.yaml
 * `/theme reset`        delete ~/.aiden/theme.yaml, restore baseline
 * `/theme edit`         print ~/.aiden/theme.yaml path
 *
 * `/theme list` and `/theme set <name>` ship in Slice 1b alongside
 * the remaining 4 bundled themes.
 */
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import type { SlashCommand } from '../commandRegistry';
import { loadThemeFile } from '../../../core/v4/theme/themeLoader';
import {
  applyTheme,
  resetToDefault,
  getCurrentName,
  getActivePath,
} from '../../../core/v4/theme/themeRegistry';

function themeFilePath(ctx: { paths?: { root?: string } | null }): string | null {
  const root = ctx.paths?.root;
  if (!root) return null;
  return path.join(root, 'theme.yaml');
}

export const theme: SlashCommand = {
  name: 'theme',
  description: 'Show, reload, reset, or open the user theme.yaml.',
  category: 'system',
  icon: '🎨',
  handler: async (ctx) => {
    const sub = ctx.rawArgs.trim();
    const themePath = themeFilePath(ctx as { paths?: { root?: string } | null });

    if (sub === '' || sub === 'show') {
      const current = getCurrentName();
      const active  = getActivePath();
      ctx.display.info(`Active theme: ${current}`);
      if (active) {
        ctx.display.info(`Source: ${active}`);
      } else if (themePath) {
        ctx.display.info(`No user theme.yaml at ${themePath} — using bundled default.`);
      }
      ctx.display.info('Use /theme reload, /theme reset, or /theme edit.');
      ctx.display.info('(/theme list and /theme set <name> arrive in Slice 1b.)');
      return {};
    }

    if (sub === 'reload') {
      if (!themePath) {
        ctx.display.warn('/theme reload needs Aiden user-data paths — try in a real session.');
        return {};
      }
      if (!existsSync(themePath)) {
        ctx.display.warn(`No theme file at ${themePath}. Use /theme edit to create one.`);
        return {};
      }
      const { parsed, warnings } = loadThemeFile(themePath);
      for (const w of warnings) ctx.display.warn(`theme: ${w}`);
      if (parsed) {
        applyTheme(parsed, themePath);
        ctx.display.success(`Theme reloaded: ${parsed.name}`);
      } else {
        ctx.display.printError(
          'Theme parse failed; current theme retained.',
          'Check the warnings above for the specific YAML / hex error.',
        );
      }
      return {};
    }

    if (sub === 'reset') {
      if (!themePath) {
        ctx.display.warn('/theme reset needs Aiden user-data paths — try in a real session.');
        return {};
      }
      if (existsSync(themePath)) {
        try {
          unlinkSync(themePath);
        } catch (err) {
          ctx.display.warn(`Could not delete ${themePath}: ${(err as Error).message}`);
          return {};
        }
      }
      resetToDefault();
      ctx.display.success('Theme reset to bundled default.');
      return {};
    }

    if (sub === 'edit') {
      if (!themePath) {
        ctx.display.warn('/theme edit needs Aiden user-data paths — try in a real session.');
        return {};
      }
      ctx.display.info(`Theme file: ${themePath}`);
      if (!existsSync(themePath)) {
        ctx.display.info('File does not exist yet. Create it with your editor; Aiden hot-reloads on save.');
      }
      return {};
    }

    ctx.display.printError(
      `Unknown /theme subcommand: ${sub}`,
      'Available: /theme | /theme reload | /theme reset | /theme edit',
    );
    return {};
  },
};
