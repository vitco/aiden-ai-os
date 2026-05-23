/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/util/closestAction.ts — v4.9.1 amendment.
 * Suggest the closest known action when the user mis-types a subcommand.
 * Matches if input is a substring of a known action OR Levenshtein
 * distance ≤ 2. Returns null when nothing is reasonably close.
 */
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i - 1; row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cur = row[j];
      row[j] = a[i-1] === b[j-1] ? prev : Math.min(prev, row[j-1], row[j]) + 1;
      prev = cur;
    }
  }
  return row[n];
}

export function closestAction(input: string, known: ReadonlyArray<string>): string | null {
  if (!input) return null;
  const lo = input.toLowerCase();
  let best: { name: string; d: number } | null = null;
  for (const k of known) {
    const kl = k.toLowerCase();
    if (kl.includes(lo) || lo.includes(kl)) return k;
    const d = lev(lo, kl);
    if (d <= 2 && (!best || d < best.d)) best = { name: k, d };
  }
  return best?.name ?? null;
}
