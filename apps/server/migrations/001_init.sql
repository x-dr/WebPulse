-- Based on design/reference/database/001_init.sql. Transactions are owned by the migrator.
CREATE TABLE admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (username = lower(username)),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(expires_at);

CREATE TABLE sites (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (length(public_id) BETWEEN 8 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  primary_origin text NOT NULL,
  allowed_origins jsonb NOT NULL CHECK (jsonb_typeof(allowed_origins) = 'array'),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  enabled boolean NOT NULL DEFAULT true,
  raw_retention_days integer NOT NULL DEFAULT 30 CHECK (raw_retention_days BETWEEN 7 AND 30),
  member_retention_days integer NOT NULL DEFAULT 90 CHECK (member_retention_days BETWEEN 30 AND 90),
  aggregate_retention_days integer NOT NULL DEFAULT 365 CHECK (aggregate_retention_days BETWEEN 90 AND 365),
  rule_version integer NOT NULL DEFAULT 1 CHECK (rule_version > 0),
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (raw_retention_days <= member_retention_days),
  CHECK (member_retention_days <= aggregate_retention_days)
);

CREATE TABLE visitors (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  visitor_key bytea NOT NULL CHECK (octet_length(visitor_key) = 32),
  first_seen_pv_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  latest_path text NOT NULL CHECK (octet_length(latest_path) <= 512),
  PRIMARY KEY (site_id, visitor_key),
  CHECK (first_seen_pv_at <= last_activity_at)
);
CREATE INDEX visitors_realtime_idx ON visitors(site_id, last_activity_at DESC);

CREATE TABLE sessions (
  site_id bigint NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  visitor_key bytea NOT NULL CHECK (octet_length(visitor_key) = 32),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  started_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  ended_at timestamptz,
  closed_at timestamptz,
  close_reason text CHECK (close_reason IN ('timeout','max_duration','deleted')),
  entry_path text NOT NULL CHECK (octet_length(entry_path) <= 512),
  exit_path text NOT NULL CHECK (octet_length(exit_path) <= 512),
  source_channel text NOT NULL CHECK (source_channel IN ('direct','organic','referral','campaign','unknown')),
  referrer_host text NOT NULL DEFAULT '' CHECK (length(referrer_host) <= 253),
  utm_source text NOT NULL DEFAULT '' CHECK (length(utm_source) <= 64),
  utm_medium text NOT NULL DEFAULT '' CHECK (length(utm_medium) <= 64),
  utm_campaign text NOT NULL DEFAULT '' CHECK (length(utm_campaign) <= 64),
  page_views integer NOT NULL DEFAULT 1 CHECK (page_views >= 1),
  interactions integer NOT NULL DEFAULT 0 CHECK (interactions >= 0),
  active_ms bigint NOT NULL DEFAULT 0 CHECK (active_ms BETWEEN 0 AND 43200000),
  active_ranges tstzmultirange NOT NULL DEFAULT '{}'::tstzmultirange,
  duration_truncated boolean NOT NULL DEFAULT false,
  rule_version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (site_id, id),
  FOREIGN KEY (site_id, visitor_key) REFERENCES visitors(site_id, visitor_key),
  CHECK (last_activity_at >= started_at),
  CHECK ((status = 'open' AND ended_at IS NULL AND closed_at IS NULL AND close_reason IS NULL)
      OR (status = 'closed' AND ended_at IS NOT NULL AND closed_at IS NOT NULL
          AND close_reason IS NOT NULL AND ended_at >= started_at))
);
CREATE UNIQUE INDEX sessions_one_open_idx ON sessions(site_id, visitor_key) WHERE status = 'open';
CREATE INDEX sessions_started_idx ON sessions(site_id, started_at);
CREATE INDEX sessions_timeout_idx ON sessions(last_activity_at) WHERE status = 'open';

CREATE TABLE events (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  ingest_seq bigint GENERATED ALWAYS AS IDENTITY,
  session_id uuid NOT NULL,
  visitor_key bytea NOT NULL CHECK (octet_length(visitor_key) = 32),
  ip_key bytea NOT NULL CHECK (octet_length(ip_key) = 32),
  event_type text NOT NULL CHECK (event_type IN ('page_view','interaction')),
  page_view_id uuid NOT NULL,
  path text NOT NULL CHECK (octet_length(path) <= 512),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  local_date date NOT NULL,
  payload_fingerprint bytea NOT NULL CHECK (octet_length(payload_fingerprint) = 32),
  rule_version integer NOT NULL,
  PRIMARY KEY (site_id, event_id),
  FOREIGN KEY (site_id, session_id) REFERENCES sessions(site_id, id),
  FOREIGN KEY (site_id, visitor_key) REFERENCES visitors(site_id, visitor_key),
  CHECK (event_type <> 'page_view' OR event_id = page_view_id)
);
CREATE INDEX events_time_idx ON events(site_id, occurred_at DESC);
CREATE INDEX events_session_idx ON events(site_id, session_id, occurred_at);

CREATE TABLE page_views (
  site_id bigint NOT NULL,
  id uuid NOT NULL,
  session_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  total_visible_ms bigint NOT NULL DEFAULT 0 CHECK (total_visible_ms >= 0),
  last_heartbeat_at timestamptz,
  interacted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (site_id, id),
  FOREIGN KEY (site_id, id) REFERENCES events(site_id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (site_id, session_id) REFERENCES sessions(site_id, id)
);
ALTER TABLE events ADD CONSTRAINT events_page_view_fk
  FOREIGN KEY (site_id, page_view_id) REFERENCES page_views(site_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE visitor_days (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  visitor_key bytea NOT NULL CHECK (octet_length(visitor_key) = 32),
  first_seen_pv_at timestamptz NOT NULL,
  PRIMARY KEY (site_id, local_date, visitor_key)
);
CREATE TABLE ip_days (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  ip_key bytea NOT NULL CHECK (octet_length(ip_key) = 32),
  PRIMARY KEY (site_id, local_date, ip_key)
);
CREATE TABLE distinct_hours (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  kind smallint NOT NULL CHECK (kind IN (1,2)), -- 1=visitor, 2=IP
  member_key bytea NOT NULL CHECK (octet_length(member_key) = 32),
  first_seen_pv_at timestamptz,
  PRIMARY KEY (site_id, bucket_start, kind, member_key),
  CHECK (kind <> 1 OR first_seen_pv_at IS NOT NULL)
);

CREATE TABLE stats_hourly (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  pv bigint NOT NULL DEFAULT 0 CHECK (pv >= 0),
  uv bigint NOT NULL DEFAULT 0 CHECK (uv >= 0),
  ip bigint NOT NULL DEFAULT 0 CHECK (ip >= 0),
  sessions_total bigint NOT NULL DEFAULT 0 CHECK (sessions_total >= 0),
  closed_sessions bigint NOT NULL DEFAULT 0 CHECK (closed_sessions >= 0),
  bounced_sessions bigint NOT NULL DEFAULT 0 CHECK (bounced_sessions >= 0),
  active_ms bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  is_final boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, bucket_start),
  CHECK (bounced_sessions <= closed_sessions AND closed_sessions <= sessions_total)
);
CREATE TABLE stats_daily (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  pv bigint NOT NULL DEFAULT 0 CHECK (pv >= 0),
  uv bigint NOT NULL DEFAULT 0 CHECK (uv >= 0),
  ip bigint NOT NULL DEFAULT 0 CHECK (ip >= 0),
  sessions_total bigint NOT NULL DEFAULT 0 CHECK (sessions_total >= 0),
  closed_sessions bigint NOT NULL DEFAULT 0 CHECK (closed_sessions >= 0),
  bounced_sessions bigint NOT NULL DEFAULT 0 CHECK (bounced_sessions >= 0),
  active_ms bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  is_final boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, local_date),
  CHECK (bounced_sessions <= closed_sessions AND closed_sessions <= sessions_total)
);
CREATE TABLE stats_pages_daily (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  path text NOT NULL CHECK (octet_length(path) <= 512),
  pv bigint NOT NULL DEFAULT 0 CHECK (pv >= 0),
  entry_sessions bigint NOT NULL DEFAULT 0 CHECK (entry_sessions >= 0),
  exit_sessions bigint NOT NULL DEFAULT 0 CHECK (exit_sessions >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, local_date, path)
);
CREATE TABLE stats_sources_daily (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  source_key bytea NOT NULL CHECK (octet_length(source_key) = 32),
  channel text NOT NULL CHECK (channel IN ('direct','organic','referral','campaign','unknown')),
  referrer_host text NOT NULL DEFAULT '',
  utm_source text NOT NULL DEFAULT '',
  utm_medium text NOT NULL DEFAULT '',
  utm_campaign text NOT NULL DEFAULT '',
  sessions_total bigint NOT NULL DEFAULT 0 CHECK (sessions_total >= 0),
  closed_sessions bigint NOT NULL DEFAULT 0 CHECK (closed_sessions >= 0),
  bounced_sessions bigint NOT NULL DEFAULT 0 CHECK (bounced_sessions >= 0),
  active_ms bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, local_date, source_key),
  CHECK (bounced_sessions <= closed_sessions AND closed_sessions <= sessions_total)
);

CREATE TABLE dirty_buckets (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  grain text NOT NULL CHECK (grain IN ('hour','day')),
  bucket_start timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, grain, bucket_start)
);
CREATE TABLE job_state (
  name text PRIMARY KEY,
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_error_code text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
