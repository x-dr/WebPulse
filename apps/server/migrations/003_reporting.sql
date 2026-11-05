-- M2: additive reporting/maintenance state. 001 and 002 remain immutable.
CREATE TABLE site_data_coverage (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  layer text NOT NULL CHECK (layer IN ('raw_pv','sessions','hour_members','day_members','hour_aggregates','day_aggregates')),
  observed_from timestamptz NOT NULL,
  available_from timestamptz NOT NULL,
  available_through timestamptz NOT NULL,
  aggregated_through timestamptz,
  finalized_through timestamptz,
  cleanup_target timestamptz,
  cleanup_cursor jsonb,
  retention_version integer NOT NULL DEFAULT 1,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(site_id,layer),
  CHECK (observed_from <= available_from AND available_from <= available_through)
);
CREATE TABLE coverage_gaps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  layer text NOT NULL,
  start_utc timestamptz NOT NULL,
  end_utc timestamptz NOT NULL CHECK (end_utc > start_utc),
  reason text NOT NULL,
  job_id uuid,
  revision bigint NOT NULL DEFAULT 1,
  resolved_at timestamptz,
  FOREIGN KEY(site_id,layer) REFERENCES site_data_coverage(site_id,layer)
);
CREATE INDEX coverage_gaps_open_idx ON coverage_gaps(site_id,layer,start_utc) WHERE resolved_at IS NULL;
CREATE TABLE freeze_cursors (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  grain text NOT NULL CHECK (grain IN ('hour','day')),
  next_bucket_start timestamptz NOT NULL,
  last_scan_at timestamptz,
  PRIMARY KEY(site_id,grain)
);
CREATE FUNCTION initialize_site_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO site_data_coverage(site_id,layer,observed_from,available_from,available_through)
    SELECT NEW.id,layer,NEW.created_at,NEW.created_at,NEW.created_at FROM unnest(ARRAY['raw_pv','sessions','hour_members','day_members','hour_aggregates','day_aggregates']) layer;
  RETURN NEW;
END $$;
CREATE TRIGGER sites_coverage_insert AFTER INSERT ON sites FOR EACH ROW EXECUTE FUNCTION initialize_site_coverage();
INSERT INTO site_data_coverage(site_id,layer,observed_from,available_from,available_through)
  SELECT id,layer,created_at,created_at,CASE WHEN layer LIKE '%aggregates' THEN created_at ELSE clock_timestamp() END FROM sites CROSS JOIN unnest(ARRAY['raw_pv','sessions','hour_members','day_members','hour_aggregates','day_aggregates']) layer;

ALTER TABLE stats_hourly ADD COLUMN metric_version integer NOT NULL DEFAULT 1;
ALTER TABLE stats_hourly ADD COLUMN revision bigint NOT NULL DEFAULT 0;
ALTER TABLE stats_hourly ADD COLUMN computed_at timestamptz;
ALTER TABLE stats_hourly ADD COLUMN source_dirty_version bigint NOT NULL DEFAULT 0;
ALTER TABLE stats_hourly ADD COLUMN finalized_at timestamptz;
ALTER TABLE stats_daily ADD COLUMN metric_version integer NOT NULL DEFAULT 1;
ALTER TABLE stats_daily ADD COLUMN revision bigint NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN computed_at timestamptz;
ALTER TABLE stats_daily ADD COLUMN source_dirty_version bigint NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN finalized_at timestamptz;
ALTER TABLE stats_pages_daily ADD COLUMN revision bigint NOT NULL DEFAULT 0;
ALTER TABLE stats_sources_daily ADD COLUMN revision bigint NOT NULL DEFAULT 0;

CREATE TABLE site_tombstones (
  site_public_id text PRIMARY KEY,
  job_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION prevent_site_id_reuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM site_tombstones WHERE site_public_id=NEW.public_id) THEN
    RAISE EXCEPTION 'site identifier retired';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sites_prevent_reuse BEFORE INSERT OR UPDATE OF public_id ON sites FOR EACH ROW EXECUTE FUNCTION prevent_site_id_reuse();
CREATE TABLE deletion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_public_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('site','visitor')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version>0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','blocked','succeeded')),
  phase text NOT NULL DEFAULT 'journal' CHECK (phase IN ('journal','facts','sessions','visitors','members','aggregates','site','verify','complete')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cutoff_at timestamptz NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  selector_ciphertext jsonb NOT NULL,
  encryption_key_id text NOT NULL,
  cursor jsonb NOT NULL DEFAULT '{}',
  cursor_version integer NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error_code text,
  lease_owner uuid,
  lease_expires_at timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0,
  deleted_counts jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  completed_at timestamptz,
  journal_sequence bigint UNIQUE,
  journal_ack_at timestamptz
);
CREATE UNIQUE INDEX deletion_jobs_active_idx ON deletion_jobs(site_public_id) WHERE status<>'succeeded';
CREATE INDEX deletion_jobs_due_idx ON deletion_jobs(status,next_attempt_at);
CREATE TABLE deletion_outbox (
  task_id uuid PRIMARY KEY REFERENCES deletion_jobs(id),
  schema_version integer NOT NULL DEFAULT 1,
  selector_ciphertext jsonb NOT NULL,
  encryption_key_id text NOT NULL,
  journal_sequence bigint UNIQUE,
  acknowledged_at timestamptz
);
CREATE INDEX visitor_days_key_idx ON visitor_days(site_id,visitor_key);
CREATE INDEX sessions_closed_idx ON sessions(site_id,closed_at) WHERE status='closed';
CREATE TABLE deletion_rebuild_buckets (
  task_id uuid NOT NULL REFERENCES deletion_jobs(id),
  grain text NOT NULL CHECK (grain IN ('hour','day')),
  bucket_start timestamptz NOT NULL,
  done boolean NOT NULL DEFAULT false,
  PRIMARY KEY(task_id,grain,bucket_start)
);
