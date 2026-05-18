-- v6 — Phase 1 of v4.6 sub-agents: lineage columns on runs.
--
-- Adds two nullable columns plus a partial index. Phase 1 of the
-- v4.6 sub-agent subsystem uses these to record parent→child
-- spawn relationships WITHOUT overloading the v4.5 `trigger_event_id`
-- column (which already carries one parent-child semantic: "this
-- run was fired by a daemon trigger event"). Adding a second
-- relationship type to the same column would force every consumer
-- to disambiguate at query time; a dedicated FK column keeps the
-- read path simple.
--
-- Column semantics:
--   * NULL          → top-level run (REPL turn, daemon-fired turn).
--   * non-NULL      → sub-agent run, spawned by another run via the
--                     v4.6 `spawn_sub_agent` tool. The two columns
--                     together identify the parent unambiguously
--                     (run_id is canonical; session_id is denormalised
--                     so session-scoped queries don't need a join).
--
-- Type choices:
--   * `spawned_from_run_id INTEGER` to match `runs.id INTEGER PRIMARY
--     KEY AUTOINCREMENT`. The original brief listed TEXT; INTEGER is
--     the only valid choice for a reference to runs.id.
--   * `spawned_from_session_id TEXT` to match `runs.session_id TEXT
--     NOT NULL`.
--
-- FK constraint:
--   SQLite does not support adding a FOREIGN KEY clause via ALTER
--   TABLE ADD COLUMN — FKs must be declared in the original CREATE
--   TABLE. The v4.5 `runs` table predates this column, so adding
--   enforced FKs here would require a table rebuild (create new
--   table, copy rows, drop old, rename). For Phase 1 the partial
--   index provides the same query performance; orphan rows are
--   detectable and cleanable via maintenance queries. If a future
--   phase needs hard FK enforcement on these columns, a rebuild
--   migration is the right vehicle for it.

ALTER TABLE runs ADD COLUMN spawned_from_run_id     INTEGER;
ALTER TABLE runs ADD COLUMN spawned_from_session_id TEXT;

-- Partial index: most rows are top-level, so we only index the
-- minority that actually have a parent. Queries like
-- "show me the children of run X" use this index; queries on
-- top-level runs ignore it.
CREATE INDEX IF NOT EXISTS idx_runs_spawned_from
  ON runs(spawned_from_run_id)
  WHERE spawned_from_run_id IS NOT NULL;
