-- Idempotent upload reservations and Drive reconciliation state.
CREATE TABLE IF NOT EXISTS upload_reservations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  item_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('processing', 'retryable', 'completed')),
  drive_file_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, key_hash)
);
CREATE INDEX IF NOT EXISTS upload_reservations_state_idx ON upload_reservations(state, updated_at);
