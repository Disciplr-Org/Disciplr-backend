export interface AuthenticatedUser {
  userId: string
}

export interface ApiKeyAuthContext {
  apiKeyId: string
  userId: string | null
  orgId: string | null
  scopes: string[]
  label: string
}

export interface ApiKeyRecord {
  id: string
  userId: string | null
  orgId: string | null
  keyHash: string
  label: string
  scopes: string[]
  createdAt: string
  revokedAt: string | null
}
