import { describe, it, expect } from 'vitest';
import { McpCredentialFilter } from '../../../core/v4/mcp/credentialFilter';

describe('McpCredentialFilter.buildEnv', () => {
  const f = new McpCredentialFilter();

  it('inherits PATH and HOME from source', () => {
    const env = f.buildEnv({ source: { PATH: '/usr/bin', HOME: '/home/u' } });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
  });

  it('does NOT inherit AIDEN_* by default', () => {
    const env = f.buildEnv({ source: { AIDEN_API_KEY: 'sk-secret', PATH: '/usr/bin' } });
    expect(env.AIDEN_API_KEY).toBeUndefined();
  });

  it('does NOT inherit ANTHROPIC_API_KEY by default', () => {
    const env = f.buildEnv({ source: { ANTHROPIC_API_KEY: 'sk-ant-blah', PATH: '/usr/bin' } });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('explicit overrides take effect', () => {
    const env = f.buildEnv({
      source: { PATH: '/usr/bin' },
      explicit: { GITHUB_TOKEN: 'literal-value' },
    });
    expect(env.GITHUB_TOKEN).toBe('literal-value');
  });

  it('allowlist pulls extra names from source', () => {
    const env = f.buildEnv({
      source: { PATH: '/usr/bin', GITHUB_PAT: 'plainvalue' },
      allowlist: ['GITHUB_PAT'],
    });
    expect(env.GITHUB_PAT).toBe('plainvalue');
  });

  it('allowlist does NOT pull through token-shaped values', () => {
    const env = f.buildEnv({
      source: { PATH: '/usr/bin', LEAKY: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      allowlist: ['LEAKY'],
    });
    expect(env.LEAKY).toBeUndefined();
  });

  it('explicit overrides allowlist for the same key', () => {
    const env = f.buildEnv({
      source: { PATH: '/usr/bin', K: 'fromsource' },
      allowlist: ['K'],
      explicit: { K: 'fromexplicit' },
    });
    expect(env.K).toBe('fromexplicit');
  });

  it('strips PATH if it itself looks like a token (defensive)', () => {
    const env = f.buildEnv({ source: { PATH: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    expect(env.PATH).toBeUndefined();
  });
});

describe('McpCredentialFilter.redact', () => {
  const f = new McpCredentialFilter();

  it('redacts Anthropic keys', () => {
    expect(f.redact('key=sk-ant-abcdefghijklmnopqrstuvwxyz')).not.toMatch(/sk-ant-/);
  });

  it('redacts OpenAI legacy keys', () => {
    const out = f.redact('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).not.toMatch(/sk-[A-Za-z0-9]{32}/);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts OpenAI project keys', () => {
    const out = f.redact('val sk-proj-abcdefghijklmnopqrstuvwxyz tail');
    expect(out).not.toMatch(/sk-proj-[A-Za-z0-9\-_]+/);
  });

  it('redacts Groq keys', () => {
    const out = f.redact('gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(out).not.toMatch(/gsk_/);
  });

  it('redacts Together keys (v1 + v2)', () => {
    expect(f.redact('tgp_v1_aaaaaaaaaaaaaaaaaaaa_xx')).not.toMatch(/tgp_v1_/);
    expect(f.redact('tgp_v2_aaaaaaaaaaaaaaaaaaaa_xx')).not.toMatch(/tgp_v2_/);
  });

  it('redacts GitHub PAT (classic)', () => {
    expect(f.redact('ghp_abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED]');
  });

  it('redacts GitHub fine-grained PAT', () => {
    expect(f.redact('github_pat_abcdefghijklmnopqrstuvwxyz1234567890')).toContain('[REDACTED]');
  });

  it('redacts Slack bot tokens', () => {
    expect(f.redact('xoxb-1234567890-1234567890-abcdefghij')).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    expect(f.redact('Authorization: Bearer abc.def.ghi=')).toContain('[REDACTED]');
  });

  it('redacts AWS access keys', () => {
    expect(f.redact('aws-id=AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
  });

  it('redacts token=value syntax', () => {
    expect(f.redact('Connecting with token=abcdefghijkl in URL')).toContain('[REDACTED]');
  });

  it('redacts multiple credentials in one string', () => {
    const out = f.redact(
      'first sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa then ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const matches = out.match(/\[REDACTED\]/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it('passes through clean text unchanged', () => {
    expect(f.redact('the quick brown fox jumps over')).toBe('the quick brown fox jumps over');
  });

  it('handles empty string', () => {
    expect(f.redact('')).toBe('');
  });
});
