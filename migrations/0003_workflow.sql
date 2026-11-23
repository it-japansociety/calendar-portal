-- Booking Workflow v2 backbone: one booking (event_groups) fans into per-day
-- JotForm submissions via a durable queue (submission_jobs); the function form
-- mirrors into function_forms; rule_actions is the audit/undo log; settings
-- holds thresholds and the live/dry switch.

CREATE TABLE IF NOT EXISTS event_groups (
  group_id      TEXT PRIMARY KEY,
  event_name    TEXT NOT NULL,
  department    TEXT,
  location      TEXT,
  description   TEXT,
  contact_name  TEXT,
  email         TEXT,
  phone         TEXT,
  count         INTEGER,
  date_from     TEXT NOT NULL,
  date_to       TEXT NOT NULL,
  weekday_mask  TEXT NOT NULL DEFAULT '1111111',  -- Sun..Sat, '1' = include
  event_start   TEXT, event_end TEXT,
  hold_start    TEXT, hold_end TEXT,
  doors_open    TEXT, check_in_time TEXT, run_time TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',   -- draft|queued|creating|active|confirmed|cancelled|partial_error
  created_by    TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submission_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT NOT NULL,
  form        TEXT NOT NULL DEFAULT 'event',      -- event|function
  action      TEXT NOT NULL DEFAULT 'create',     -- create|edit|release
  event_date  TEXT,                               -- one job per day for event form
  payload     TEXT,                               -- JSON of fields at enqueue time
  state       TEXT NOT NULL DEFAULT 'pending',    -- pending|in_flight|done|failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  jotform_id  TEXT,                               -- filled when done
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(group_id, form, action, event_date)
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON submission_jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_group ON submission_jobs(group_id);

CREATE TABLE IF NOT EXISTS function_forms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT NOT NULL UNIQUE,
  jotform_id  TEXT UNIQUE,                        -- once fanned to JotForm (live mode)
  data        TEXT NOT NULL DEFAULT '{}',         -- JSON of all answers
  complete    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rule_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule          TEXT NOT NULL,                    -- auto_confirm|hold_expiry|hold_count|cancel|admin_confirm|admin_release|retry|undo|on_behalf
  group_id      TEXT,
  event_id      INTEGER,
  jotform_id    TEXT,
  detail        TEXT,
  before_status TEXT,
  after_status  TEXT,
  dry_run       INTEGER NOT NULL DEFAULT 1,
  actor         TEXT NOT NULL DEFAULT 'rules',    -- 'rules' or an email; 'admin:<email> on behalf of <email>'
  undone        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('live_mode', '0'),
  ('hold_max_age_days', '30'),
  ('near_date_days', '14'),
  ('max_holds_per_contact', '10'),
  ('email_enabled', '0');

-- Fresh databases get group_id here; existing databases get it from the
-- guarded ALTER in the import route (P2).
ALTER TABLE events ADD COLUMN group_id TEXT;
