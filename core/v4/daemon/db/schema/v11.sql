-- v4.9.0 Slice 12a — Hook system tables.
--
-- hooks               : one row per discovered HOOK.yaml manifest.
-- hook_subscriptions  : (hook, event) tuples + authority/mode/policy.
-- hook_capability_grants : declared capabilities (warn-only in 12a).
-- hook_executions     : per-firing audit row — every subprocess run logged.
CREATE TABLE IF NOT EXISTS hooks (
  hook_id        TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  version        TEXT,
  source         TEXT    NOT NULL,     -- 'global' | 'project' | 'bundled'
  runtime        TEXT    NOT NULL,     -- 'subprocess' only in 12a
  manifest_path  TEXT    NOT NULL,
  code_hash      TEXT    NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 0,
  trust_state    TEXT    NOT NULL,     -- 'untrusted' | 'trusted' | 'revoked' | 'drifted'
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  UNIQUE(manifest_path)
);

CREATE TABLE IF NOT EXISTS hook_subscriptions (
  subscription_id TEXT    PRIMARY KEY,
  hook_id         TEXT    NOT NULL REFERENCES hooks(hook_id) ON DELETE CASCADE,
  event           TEXT    NOT NULL,
  matcher_json    TEXT,
  authority       TEXT    NOT NULL,   -- 'observe' | 'decision' | 'transform_input' | 'transform_output'
  mode            TEXT    NOT NULL,   -- 'best_effort_observer' | 'advisory_policy' | 'mandatory_policy'
  priority        INTEGER NOT NULL DEFAULT 0,
  timeout_ms      INTEGER NOT NULL,
  on_error        TEXT    NOT NULL,   -- 'allow' | 'block' | 'disable_hook'
  on_timeout      TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_hook_subscriptions_event
  ON hook_subscriptions(event, enabled);

CREATE TABLE IF NOT EXISTS hook_capability_grants (
  grant_id     TEXT    PRIMARY KEY,
  hook_id      TEXT    NOT NULL REFERENCES hooks(hook_id) ON DELETE CASCADE,
  capability   TEXT    NOT NULL,      -- 'fs.read' | 'fs.write' | 'network' | 'secret' | 'process.spawn'
  scope_json   TEXT    NOT NULL,
  granted_by   TEXT,
  granted_at   TEXT    NOT NULL,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS hook_executions (
  hook_execution_id TEXT    PRIMARY KEY,
  hook_id           TEXT    NOT NULL REFERENCES hooks(hook_id),
  subscription_id   TEXT    REFERENCES hook_subscriptions(subscription_id),
  event             TEXT    NOT NULL,
  run_id            TEXT,
  trace_id          TEXT,
  span_id           TEXT,
  parent_span_id    TEXT,
  tool_call_id      TEXT,
  status            TEXT    NOT NULL, -- 'ok' | 'timeout' | 'crash' | 'malformed_output' | 'skipped' | 'blocked_by_error_policy'
  decision          TEXT,             -- 'allow' | 'block' | 'require_approval' | 'rewrite' | 'none'
  elapsed_ms        INTEGER NOT NULL,
  cpu_ms            INTEGER,
  max_rss_kb        INTEGER,
  exit_code         INTEGER,
  payload_hash      TEXT,
  response_hash     TEXT,
  stdout_preview    TEXT,
  stderr_preview    TEXT,
  error_kind        TEXT,
  error_message     TEXT,
  started_at        TEXT    NOT NULL,
  finished_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hook_executions_run   ON hook_executions(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_hook_executions_hook  ON hook_executions(hook_id, started_at);
CREATE INDEX IF NOT EXISTS idx_hook_executions_event ON hook_executions(event, started_at);
