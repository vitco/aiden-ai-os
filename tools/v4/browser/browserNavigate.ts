/**
 * tools/v4/browser/browserNavigate.ts — `browser_navigate` wrapper.
 *
 * Wraps `pwNavigate` from the v3 playwright bridge. Mutates because
 * navigating changes user-observable browser state (history, cookies,
 * outgoing requests).
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwNavigate } from '../../../core/playwrightBridge';

export const browserNavigateTool: ToolHandler = {
  schema: {
    name: 'browser_navigate',
    description:
      'Navigate the browser to a URL. Reuses the active tab; opens one if none exists.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Destination URL.' },
      },
      required: ['url'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  async execute(args) {
    const url = String(args.url ?? '').trim();
    if (!url) return { success: false, error: 'No URL provided' };
    const r = await pwNavigate(url);
    if (r.ok) return { success: true, url: r.url };
    return { success: false, error: r.error, url };
  },
};
