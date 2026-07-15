-- When the booking was actually submitted in JotForm (JotForm's created_at,
-- US Eastern). D1's own created_at only records when the row first reached
-- this database, which backfills reset — so it can't serve as the submission
-- date. Applied automatically by the import route (guarded ALTER); this file
-- documents the schema change.
ALTER TABLE events ADD COLUMN submitted_at TEXT;
