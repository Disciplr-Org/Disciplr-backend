-- Create transactions table
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  userId VARCHAR(56) NOT NULL,
  vaultId VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL CHECK (type IN ('creation', 'validation', 'release', 'redirect', 'cancel')),
  amount DECIMAL(20, 7) NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  stellarHash VARCHAR(64) UNIQUE,
  link TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(userId);
CREATE INDEX IF NOT EXISTS idx_transactions_vault_id ON transactions(vaultId);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_stellar_hash ON transactions(stellarHash);

-- Create composite index for user transaction history queries
CREATE INDEX IF NOT EXISTS idx_transactions_user_timestamp ON transactions(userId, timestamp DESC);

-- Create composite index for vault transaction history queries
CREATE INDEX IF NOT EXISTS idx_transactions_vault_timestamp ON transactions(vaultId, timestamp DESC);

-- Add trigger for updating updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_transactions_updated_at 
    BEFORE UPDATE ON transactions 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();
