CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Event Information
  event_name      TEXT    NOT NULL,
  department      TEXT,
  location        TEXT,

  -- Time & Scheduling (dates as YYYY-MM-DD, times as HH:MM 24h for range queries)
  event_date      TEXT    NOT NULL,
  day_of_week     TEXT,
  event_start     TEXT    NOT NULL,
  event_end       TEXT    NOT NULL,
  hold_start      TEXT,
  hold_end        TEXT,
  doors_open      TEXT,
  check_in_time   TEXT,
  run_time        TEXT,

  -- Contact & Notes
  contact_name    TEXT    NOT NULL,
  email           TEXT    NOT NULL,
  phone           TEXT,
  description     TEXT,
  attachment_url  TEXT,
  status          TEXT    NOT NULL DEFAULT 'Pending',
  count           INTEGER,

  -- Sync / internal
  jotform_id      TEXT    UNIQUE,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  archived_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_date        ON events (event_date);
CREATE INDEX IF NOT EXISTS idx_events_status      ON events (status);
CREATE INDEX IF NOT EXISTS idx_events_is_archived ON events (is_archived);
CREATE INDEX IF NOT EXISTS idx_events_department  ON events (department);
CREATE INDEX IF NOT EXISTS idx_events_location    ON events (location);
-- Composite for the most common query: active events in a date range
CREATE INDEX IF NOT EXISTS idx_events_active_date ON events (is_archived, event_date);
