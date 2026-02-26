import { UserRole } from '@prisma/client'

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

export interface JWTPayload {
  userId: string
  role: UserRole
  email?: string
}

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload
    }
  }
}
