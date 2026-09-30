-- Field-level change log for bookings coming back from JotForm.
--
-- `events.updated_at` cannot answer "what changed": the import stamps it on
-- every upsert whether or not any value actually differs, so a full backfill
-- marks all ~3,500 rows as updated. This table records only real differences,
-- one row per changed field, so a report can say "status: Pending → Confirmed"
-- rather than "something touched this row".
CREATE TABLE IF NOT EXISTS event_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  jotform_id  TEXT NOT NULL,
  event_name  TEXT,            -- denormalised: the report still reads correctly
  event_date  TEXT,            -- even after the row itself changes again
  change_type TEXT NOT NULL,   -- created | updated | archived | restored
  field       TEXT,            -- NULL for created/archived/restored
  old_value   TEXT,
  new_value   TEXT,
  detected_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_changes_detected ON event_changes(detected_at);
CREATE INDEX IF NOT EXISTS idx_changes_jotform  ON event_changes(jotform_id);
CREATE INDEX IF NOT EXISTS idx_changes_field    ON event_changes(field);
