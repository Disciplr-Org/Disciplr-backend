import type { AuthenticatedUser, ApiKeyAuthContext } from './auth.js'

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser
      apiKeyAuth?: ApiKeyAuthContext
    }
  }
}

export {}
