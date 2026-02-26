CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY,
  user_id TEXT,
  org_id TEXT,
  key_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS api_keys_org_id_idx ON api_keys (org_id);
