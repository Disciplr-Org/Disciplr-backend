import { UserRole } from './user.js'

export interface AuthenticatedUser {
  userId: string
}

export enum ApiScope {
  ReadAnalytics = 'read:analytics',
  ReadVaults = 'read:vaults',
}

export interface ApiKeyAuthContext {
  apiKeyId: string
  userId: string | null
  orgId: string | null
  scopes: ApiScope[]
  label: string
}

export interface ApiKeyRecord {
  id: string
  userId: string | null
  orgId: string | null
  keyHash: string
  label: string
  scopes: ApiScope[]
  createdAt: string
  revokedAt: string | null
}

export interface JWTPayload {
  userId: string
  role: UserRole
  email?: string
  jti?: string
  isEnterprise?: boolean
  enterpriseId?: string
  impersonator?: string
}

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload
    }
  }
}
