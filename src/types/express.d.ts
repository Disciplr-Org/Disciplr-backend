import type { AuthenticatedUser, ApiKeyAuthContext } from './auth.js'
import type { VerifierProfile } from '../services/verifiers.js'

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser
      apiKeyAuth?: ApiKeyAuthContext
      verifier?: VerifierProfile
    }
  }
}

export {}
