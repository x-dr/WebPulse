-- M1 additive migration; preserve the immutable 001/reference baseline.
CREATE INDEX events_page_view_idx ON events(site_id, page_view_id);
CREATE INDEX events_visitor_idx ON events(site_id, visitor_key);
CREATE INDEX page_views_session_idx ON page_views(site_id, session_id);
CREATE INDEX sessions_visitor_idx ON sessions(site_id, visitor_key);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions(admin_id);

ALTER TABLE sites ADD COLUMN maintenance_state text NOT NULL DEFAULT 'active'
  CHECK (maintenance_state IN ('active', 'deleting', 'rebuilding'));
UPDATE sites SET config=config || jsonb_build_object('identity_epochs',jsonb_build_array(jsonb_build_object('visitor',key_version,'ip',key_version,'effective_at',created_at)));
CREATE TABLE site_rules (
  site_id bigint NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (site_id, version)
);
INSERT INTO site_rules(site_id, version, config) SELECT id, rule_version, config FROM sites;
ALTER TABLE visitors ADD COLUMN key_version integer NOT NULL DEFAULT 1;
ALTER TABLE visitors ADD COLUMN activity_seq bigint NOT NULL DEFAULT 0 CHECK (activity_seq >= 0);
ALTER TABLE visitors ADD COLUMN latest_page_view_id uuid;
ALTER TABLE events ADD COLUMN activity_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN fingerprint_version integer NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN key_version integer NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN first_seen_pv_at timestamptz;
ALTER TABLE events ADD COLUMN origin text NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN interaction_kind text CHECK (interaction_kind IN ('click','key','scroll'));
ALTER TABLE events ADD COLUMN reason text;
ALTER TABLE page_views ADD COLUMN activity_seq bigint NOT NULL DEFAULT 0;
