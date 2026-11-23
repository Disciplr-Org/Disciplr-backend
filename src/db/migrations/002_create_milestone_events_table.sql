CREATE TABLE IF NOT EXISTS milestone_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS milestone_events_user_id_idx ON milestone_events (user_id);
CREATE INDEX IF NOT EXISTS milestone_events_vault_id_idx ON milestone_events (vault_id);
CREATE INDEX IF NOT EXISTS milestone_events_timestamp_idx ON milestone_events (timestamp);
