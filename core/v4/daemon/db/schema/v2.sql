-- v4.5 Phase 2 — file_observations.
-- Tracks the most-recent observed state of each watched path per
-- file-watcher trigger. Reconciliation reads this on daemon boot
-- to decide whether to skip pre-existing files or emit catch-up events.

CREATE TABLE IF NOT EXISTS file_observations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_id          TEXT    NOT NULL,
  abs_path            TEXT    NOT NULL,
  file_key            TEXT    NOT NULL DEFAULT '',
  size                INTEGER,
  mtime_ms            INTEGER NOT NULL,
  content_hash        TEXT,
  last_event_type     TEXT,
  last_seen_at        INTEGER NOT NULL,
  last_processed_at   INTEGER,
  last_event_id       INTEGER,
  last_status         TEXT    NOT NULL DEFAULT 'pending',
  coalesced_count     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (watcher_id)   REFERENCES triggers(id)        ON DELETE CASCADE,
  FOREIGN KEY (last_event_id) REFERENCES trigger_events(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_obs_watcher_path
  ON file_observations(watcher_id, abs_path);
CREATE INDEX IF NOT EXISTS idx_file_obs_last_seen
  ON file_observations(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_file_obs_pending
  ON file_observations(watcher_id, last_status) WHERE last_status = 'pending';
