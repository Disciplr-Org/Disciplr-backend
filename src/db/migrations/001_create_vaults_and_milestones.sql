CREATE TABLE IF NOT EXISTS vaults (
  id UUID PRIMARY KEY,
  amount NUMERIC(30, 7) NOT NULL CHECK (amount > 0),
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  verifier TEXT NOT NULL,
  success_destination TEXT NOT NULL,
  failure_destination TEXT NOT NULL,
  creator TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vault_dates_valid CHECK (end_date > start_date)
);

CREATE TABLE IF NOT EXISTS milestones (
  id UUID PRIMARY KEY,
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_date TIMESTAMPTZ NOT NULL,
  amount NUMERIC(30, 7) NOT NULL CHECK (amount > 0),
  sort_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS milestones_vault_id_idx ON milestones (vault_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
