-- v4.9.0 Slice 5 — durable run queue: attempts + spans + ingress idempotency.
-- Additive only — leaves existing `runs`, `trigger_events`, `run_events`,
-- and `idempotency_keys` (the response-replay cache) untouched.

-- Per-run attempt history. One row per execution attempt of a run.
CREATE TABLE IF NOT EXISTS run_attempts (
  attempt_id     TEXT    PRIMARY KEY,
  run_id         INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  incarnation_id TEXT    NOT NULL,
  started_at     TEXT    NOT NULL,
  ended_at       TEXT,
  status         TEXT    NOT NULL,
  finish_reason  TEXT,
  error_class    TEXT,
  error_message  TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_attempts_run
  ON run_attempts(run_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_run_attempts_incarnation
  ON run_attempts(incarnation_id);

-- Span tree for tracing (LLM calls, tool calls, hooks, memory writes,
-- subagent invocations, HTTP egress, etc.). Slice 5 lands the schema +
-- store; tool dispatcher / hook integration is Slice 6+.
CREATE TABLE IF NOT EXISTS spans (
  span_id        TEXT    PRIMARY KEY,
  trace_id       TEXT    NOT NULL,
  parent_span_id TEXT,
  run_id         INTEGER,
  attempt_id     TEXT,
  incarnation_id TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  started_at     TEXT    NOT NULL,
  ended_at       TEXT,
  status         TEXT,
  attrs_json     TEXT,
  error_class    TEXT,
  error_message  TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_trace  ON spans(trace_id, started_at);
CREATE INDEX IF NOT EXISTS idx_spans_run    ON spans(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);

-- Durable idempotency keys. Distinct from the v1 `idempotency_keys`
-- response-replay cache — that one stores HTTP response bodies for
-- exact-replay; this one tracks ingress acceptance + run linkage so a
-- duplicate webhook/email/file/API request never creates a second run.
CREATE TABLE IF NOT EXISTS run_idempotency_keys (
  namespace        TEXT    NOT NULL,
  key              TEXT    NOT NULL,
  fingerprint      TEXT    NOT NULL,
  run_id           INTEGER,
  trigger_event_id INTEGER,
  span_id          TEXT,
  status           TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  expires_at       TEXT,
  result_ref       TEXT,
  PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON run_idempotency_keys(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_idempotency_run
  ON run_idempotency_keys(run_id) WHERE run_id IS NOT NULL;
