-- Create Enum for Vault Status
CREATE TYPE vault_status AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED');

-- Create Vaults Table
CREATE TABLE IF NOT EXISTS vaults (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(56) UNIQUE, 
    creator_address VARCHAR(56) NOT NULL,
    amount NUMERIC NOT NULL,
    milestone_hash VARCHAR(64) NOT NULL, 
    verifier_address VARCHAR(56) NOT NULL,
    success_destination VARCHAR(56) NOT NULL,
    failure_destination VARCHAR(56) NOT NULL,
    status vault_status NOT NULL DEFAULT 'PENDING',
    deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying by the most common access patterns
CREATE INDEX idx_vaults_creator_address ON vaults(creator_address);
CREATE INDEX idx_vaults_status ON vaults(status);