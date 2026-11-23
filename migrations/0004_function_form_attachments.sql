-- Attachments on the function form (setup maps, floor-plan diagrams, etc.) —
-- the paper form said "email a setup map to House Activities"; this lets it
-- be attached directly. Dev-stage storage: base64 in D1 with a small size cap
-- (enforced in the API route). P2 TODO: move bytes to an R2 bucket once the
-- Cloudflare account is available to provision one; keep this table for
-- metadata + swap `data_base64` for an R2 object key.
CREATE TABLE IF NOT EXISTS function_form_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  data_base64 TEXT NOT NULL,
  uploaded_by TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ff_attach_group ON function_form_attachments(group_id);
