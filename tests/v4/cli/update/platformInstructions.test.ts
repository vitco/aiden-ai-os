/**
 * v4.9.1 — per-platform EPERM remediation text.
 * Windows = PowerShell syntax; darwin/linux = bash/zsh syntax. NO
 * cross-contamination of `export PATH=…` into the Windows branch
 * (the v4.9.0 regression we're hot-fixing).
 */
import { describe, it, expect } from 'vitest';
import {
  permissionDeniedInstructions,
  detectShell,
  detectStalePrefix,
} from '../../../../core/v4/update/platformInstructions';

describe('permissionDeniedInstructions — Windows', () => {
  const win = permissionDeniedInstructions({ platform: 'win32', home: 'C:\\Users\\shiva' });
  it('headline names Administrator (not sudo)', () => {
    expect(win.headline).toMatch(/Administrator/);
    expect(win.headline).not.toMatch(/sudo/);
  });
  it('uses $env:USERPROFILE — not ~/', () => {
    const steps = win.steps.join('\n');
    expect(steps).toMatch(/\$env:USERPROFILE/);
    expect(steps).not.toMatch(/~\//);
  });
  it('uses PowerShell setter, not bash export', () => {
    const steps = win.steps.join('\n');
    expect(steps).toMatch(/\[Environment\]::SetEnvironmentVariable/);
    expect(steps).not.toMatch(/^export /m);
    expect(steps).not.toMatch(/echo .* >> .*rc/);
  });
  it('shows BOTH options: Admin one-shot AND user-local prefix', () => {
    const steps = win.steps.join('\n');
    expect(steps).toMatch(/Option 1.*elevated/i);
    expect(steps).toMatch(/Option 2.*user-local/i);
  });
});

describe('permissionDeniedInstructions — darwin/zsh', () => {
  const mac = permissionDeniedInstructions({
    platform: 'darwin', home: '/Users/shiva', env: { SHELL: '/bin/zsh' },
  });
  it('headline names sudo (not Administrator)', () => {
    expect(mac.headline).toMatch(/sudo/);
    expect(mac.headline).not.toMatch(/Administrator/);
  });
  it('uses bash export syntax, recommends .zshrc', () => {
    const steps = mac.steps.join('\n');
    expect(steps).toMatch(/export PATH/);
    expect(steps).toMatch(/\.zshrc/);
    expect(steps).not.toMatch(/PowerShell/);
    expect(steps).not.toMatch(/\$env:/);
  });
  it('detects zsh shell', () => {
    expect(mac.shell).toBe('zsh');
  });
});

describe('permissionDeniedInstructions — linux/bash', () => {
  const lin = permissionDeniedInstructions({
    platform: 'linux', home: '/home/shiva', env: { SHELL: '/bin/bash' },
  });
  it('uses bash export + recommends .bashrc', () => {
    const steps = lin.steps.join('\n');
    expect(steps).toMatch(/export PATH/);
    expect(steps).toMatch(/\.bashrc/);
    expect(steps).not.toMatch(/PowerShell/);
  });
  it('detects bash shell', () => {
    expect(lin.shell).toBe('bash');
  });
});

describe('detectShell', () => {
  it('returns the basename of $SHELL', () => {
    expect(detectShell({ SHELL: '/bin/zsh'  })).toBe('zsh');
    expect(detectShell({ SHELL: '/bin/bash' })).toBe('bash');
    expect(detectShell({ SHELL: '/usr/local/bin/fish' })).toBe('fish');
  });
  it('returns null when SHELL is unset', () => {
    expect(detectShell({})).toBeNull();
  });
});

describe('detectStalePrefix', () => {
  it('Windows + Program Files → warns', () => {
    const r = detectStalePrefix({
      platform: 'win32', prefix: 'C:\\Program Files\\nodejs',
      writable: false, home: 'C:\\Users\\shiva',
    });
    expect(r).not.toBeNull();
    expect(r!.warning).toMatch(/Administrator every time/);
  });
  it('Windows + user-local prefix → no warning', () => {
    const r = detectStalePrefix({
      platform: 'win32', prefix: 'C:\\Users\\shiva\\AppData\\Roaming\\npm',
      writable: true, home: 'C:\\Users\\shiva',
    });
    expect(r).toBeNull();
  });
  it('Mac + /usr/local + not writable → warns with zsh/bash syntax', () => {
    const r = detectStalePrefix({
      platform: 'darwin', prefix: '/usr/local', writable: false,
      home: '/Users/shiva', env: { SHELL: '/bin/zsh' },
    });
    expect(r).not.toBeNull();
    expect(r!.warning).toMatch(/sudo every time/);
    expect(r!.switchSteps.join('\n')).toMatch(/\.zshrc/);
  });
  it('Linux + /usr + not writable → warns', () => {
    const r = detectStalePrefix({
      platform: 'linux', prefix: '/usr', writable: false,
      home: '/home/shiva', env: { SHELL: '/bin/bash' },
    });
    expect(r).not.toBeNull();
    expect(r!.switchSteps.join('\n')).toMatch(/\.bashrc/);
  });
  it('Mac + /usr/local but writable → no warning', () => {
    const r = detectStalePrefix({
      platform: 'darwin', prefix: '/usr/local', writable: true,
      home: '/Users/shiva',
    });
    expect(r).toBeNull();
  });
});
