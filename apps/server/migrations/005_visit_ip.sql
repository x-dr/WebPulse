-- Preserve existing facts: only newly accepted events have a recoverable client IP.
ALTER TABLE events ADD COLUMN client_ip inet;
COMMENT ON COLUMN events.client_ip IS 'Canonical request IP from the configured trusted proxy chain; retained with raw events.';
