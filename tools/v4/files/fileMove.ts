/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/files/fileMove.ts — `file_move` wrapper.
 *
 * Move/rename a file or directory. Creates parent dirs at the
 * destination if missing. Falls back to copy+delete if `fs.rename`
 * fails with EXDEV (cross-device move).
 *
 * Status: PHASE 8.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { isProtectedPath } from '../utils/paths';
import { isPathAllowed, violationEnvelope } from '../../../core/v4/sandboxFs';

export const fileMoveTool: ToolHandler = {
  schema: {
    name: 'file_move',
    description:
      'Move or rename a file or directory. Creates parent dirs at the destination.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path.' },
        to: { type: 'string', description: 'Destination path.' },
      },
      required: ['from', 'to'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'files',
  riskTier: 'caution',   // v4.4 Phase 1
  async execute(args, ctx) {
    const fromRaw = String(args.from ?? args.source ?? '').trim();
    const toRaw = String(args.to ?? args.dest ?? args.destination ?? '').trim();
    if (!fromRaw || !toRaw) {
      return { success: false, error: 'Both from and to required' };
    }
    if (isProtectedPath(fromRaw) || isProtectedPath(toRaw)) {
      return { success: false, error: 'Access denied: protected path' };
    }
    // v4.4 Phase 2 — sandbox preflight. Move = read source + write dest;
    // since the source is also being deleted, this could arguably be
    // 'delete' on source — but delete and write share the same allowlist
    // semantics in the policy. 'read' on source matches copy's shape.
    const srcPolicy = isPathAllowed(fromRaw, 'write', ctx.cwd);
    if (!srcPolicy.allowed) {
      return {
        success: false,
        error: srcPolicy.violation!.message,
        sandbox_violation: violationEnvelope(srcPolicy),
      };
    }
    const dstPolicy = isPathAllowed(toRaw, 'write', ctx.cwd);
    if (!dstPolicy.allowed) {
      return {
        success: false,
        error: dstPolicy.violation!.message,
        sandbox_violation: violationEnvelope(dstPolicy),
      };
    }
    const from = srcPolicy.resolvedPath;
    const to   = dstPolicy.resolvedPath;
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      try {
        await fs.rename(from, to);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EXDEV') {
          await fs.cp(from, to, { recursive: true });
          await fs.rm(from, { recursive: true, force: true });
        } else {
          throw err;
        }
      }
      return { success: true, from, to };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message, from, to };
    }
  },
};
