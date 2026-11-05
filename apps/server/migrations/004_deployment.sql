-- M4: independent-journal completion, backup inventory and durable recovery gate.
ALTER TABLE deletion_jobs ADD COLUMN completion_sequence bigint;
CREATE TABLE backup_inventory (
  id uuid PRIMARY KEY,
  snapshot_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  key_versions jsonb NOT NULL,
  location text NOT NULL,
  journal_sequence bigint NOT NULL,
  journal_mac text NOT NULL,
  destroyed_at timestamptz
);
CREATE TABLE recovery_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state text NOT NULL CHECK (state IN ('open','locked','verified')),
  journal_sequence bigint,
  journal_mac text,
  verified_at timestamptz
);
INSERT INTO recovery_state(singleton,state) VALUES (true,'open');
CREATE TABLE recovery_replays (
  task_id uuid PRIMARY KEY,
  journal_sequence bigint NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result jsonb NOT NULL
);
