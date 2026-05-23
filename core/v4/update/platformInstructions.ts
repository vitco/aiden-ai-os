/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/update/platformInstructions.ts — v4.9.1.
 *
 * Per-platform copy-paste remediation text for:
 *   - EPERM / EACCES during global npm install
 *   - Stale / risky npm prefix detection
 *
 * Branches purely on `process.platform` (and `$SHELL` for unix shell-
 * rc-file recommendations). Shell syntax MUST be correct per-platform:
 * PowerShell on Windows, bash/zsh on Unix. Cross-contamination is a
 * regression (the v4.9.0 bug we're hot-fixing).
 */

export interface PlatformInstructions {
  /** Headline summary the caller renders above the steps. */
  headline:    string;
  /** Ordered lines the user should follow. Already prefix-indented. */
  steps:       string[];
  /** Detected shell on POSIX (zsh/bash/sh); 'powershell' on Windows; undefined otherwise. */
  shell?:      string;
  /** Path to the shell rc file the user should edit (POSIX only). */
  rcFile?:     string;
}

/**
 * Detect the user's interactive shell on POSIX. Returns the basename
 * (`zsh` / `bash` / `sh`) or null when undetectable. Pure — env is
 * injected so tests pin a value.
 */
export function detectShell(env: NodeJS.ProcessEnv = process.env): string | null {
  const sh = env.SHELL;
  if (!sh) return null;
  const last = sh.split(/[\\/]/).pop() || '';
  return last.toLowerCase() || null;
}

/** rc-file path the user should edit, per shell. POSIX only. */
function rcFileFor(shell: string | null, home: string): string {
  if (shell === 'zsh')  return `${home}/.zshrc`;
  if (shell === 'bash') return `${home}/.bashrc   (or ~/.bash_profile on macOS)`;
  return `${home}/.profile`;
}

/**
 * Build the EPERM/EACCES remediation. Two options per platform —
 * elevation (one-time) and user-local prefix (permanent, no privs).
 */
export function permissionDeniedInstructions(opts: {
  platform: NodeJS.Platform;
  home:     string;
  env?:     NodeJS.ProcessEnv;
}): PlatformInstructions {
  const env = opts.env ?? process.env;

  if (opts.platform === 'win32') {
    return {
      headline: 'Install failed: permission denied. npm needs Administrator for a global install on Windows.',
      shell:    'powershell',
      steps: [
        'Option 1 — Run once with elevated privileges:',
        '  • Open PowerShell as Administrator (right-click → "Run as administrator")',
        '  • npm install -g aiden-runtime@latest',
        '',
        'Option 2 — Permanent: switch npm to a user-local prefix (no admin needed ever again):',
        '  • npm config set prefix "$env:USERPROFILE\\AppData\\Roaming\\npm"',
        '  • [Environment]::SetEnvironmentVariable("Path", "$env:USERPROFILE\\AppData\\Roaming\\npm;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")',
        '  • Close + reopen PowerShell, then:  npm install -g aiden-runtime@latest',
      ],
    };
  }

  // POSIX: darwin / linux / *bsd / etc.
  const shell  = detectShell(env);
  const rcFile = rcFileFor(shell, opts.home);
  return {
    headline: `Install failed: permission denied. npm needs sudo for a global install on ${opts.platform}.`,
    shell:    shell ?? undefined,
    rcFile,
    steps: [
      'Option 1 — Run once with elevated privileges:',
      '  • sudo npm install -g aiden-runtime@latest',
      '',
      'Option 2 — Permanent: switch npm to a user-local prefix (no sudo needed ever again):',
      `  • npm config set prefix "${opts.home}/.npm-global"`,
      `  • echo 'export PATH="${opts.home}/.npm-global/bin:$PATH"' >> ${rcFile}`,
      `  • source ${rcFile}`,
      '  • npm install -g aiden-runtime@latest',
    ],
  };
}

/**
 * Stale / risky prefix detection. Returns a warning when the npm
 * `prefix` config points at a location that needs elevation OR is
 * known to cause permission churn. `null` when the prefix is safe.
 *
 * `writable` is the result of a `fs.access` check the caller does
 * before invoking us (we don't want to do filesystem I/O in a pure
 * builder — caller controls the side effect).
 */
export function detectStalePrefix(opts: {
  platform: NodeJS.Platform;
  prefix:   string;
  writable: boolean;
  home:     string;
  env?:     NodeJS.ProcessEnv;
}): { warning: string; switchSteps: string[] } | null {
  const env = opts.env ?? process.env;
  const p   = opts.prefix;
  // Windows risk: Program Files.
  if (opts.platform === 'win32') {
    if (/^[a-zA-Z]:\\Program Files/i.test(p)) {
      return {
        warning: `npm prefix is "${p}" — global installs here require Administrator every time.`,
        switchSteps: [
          'Switch to a user-local prefix to avoid the prompt forever:',
          '  • npm config set prefix "$env:USERPROFILE\\AppData\\Roaming\\npm"',
          '  • [Environment]::SetEnvironmentVariable("Path", "$env:USERPROFILE\\AppData\\Roaming\\npm;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")',
          '  • Close + reopen PowerShell.',
        ],
      };
    }
    return null;
  }
  // POSIX risk: /usr or /usr/local without write access.
  const risky = p === '/usr' || p === '/usr/local' || p.startsWith('/usr/');
  if (risky && !opts.writable) {
    const shell  = detectShell(env);
    const rcFile = rcFileFor(shell, opts.home);
    return {
      warning: `npm prefix is "${p}" — global installs here require sudo every time.`,
      switchSteps: [
        'Switch to a user-local prefix to avoid sudo forever:',
        `  • npm config set prefix "${opts.home}/.npm-global"`,
        `  • echo 'export PATH="${opts.home}/.npm-global/bin:$PATH"' >> ${rcFile}`,
        `  • source ${rcFile}`,
      ],
    };
  }
  return null;
}
