import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthService } from '../services/auth.service.js'
import { registerSchema, loginSchema, refreshSchema } from '../lib/validation.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { authenticate } from '../middleware/auth.js'
import { revokeSession, revokeAllUserSessions } from '../services/session.js'
import { requireStepUp } from '../middleware/stepUp.js'
import { requireJson } from '../middleware/requireJson.js'
import { AUTH_JSON_MAX_BYTES } from '../middleware/requestBodyLimits.js'
import { AppError } from '../middleware/errorHandler.js'
import { prisma } from '../lib/prisma.js'
import { UserRole } from '../types/user.js'

export const authRouter = Router();
const authJson = requireJson({ maxBytes: AUTH_JSON_MAX_BYTES });

const userIdOnlyLoginSchema = z.object({
  userId: z.string().uuid('userId must be a valid UUID'),
})

const userRoleUpdateSchema = z.object({
  role: z.nativeEnum(UserRole),
})

const userIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
})

const logoutSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken must be a non-empty string.').max(4096, 'refreshToken is too long.').optional(),
})

const webauthnAssertSchema = z.object({
  nonce: z.string().uuid('nonce must be a valid UUID'),
  credentialId: z
    .string()
    .min(16, 'credentialId is too short.')
    .max(1024, 'credentialId is too long.')
    .regex(/^[A-Za-z0-9_-]+$/, 'credentialId contains invalid characters.'),
  publicKey: z
    .string()
    .min(1, 'publicKey is required.')
    .max(8192, 'publicKey is too long.'),
})

/**
 * The userId-only login path is a development/testing helper that impersonates
 * a user by id without credentials. It must never be reachable in production,
 * where authentication must always be credential-based.
 */
const isMockLoginAllowed = (): boolean => {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  return nodeEnv !== 'production'
}

const authUserSelect = {
  id: true,
  role: true,
  lastLoginAt: true,
} as const

const formatAuthUser = (user: { id: string; role: string; lastLoginAt: Date | null }) => ({
  id: user.id,
  role: user.role as UserRole,
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
})

// ------------- Endpoints -------------

authRouter.post('/register', authJson, async (req, res, next) => {
    const result = registerSchema.safeParse(req.body)
    if (!result.success) {
        return next(AppError.validation('Validation failed', result.error.format()))
    }

    try {
        const user = await AuthService.register(result.data)
        res.status(201).json(user)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Registration failed'
        return next(AppError.badRequest(message))
    }
})

authRouter.post('/login', authJson, async (req, res, next) => {
    // Support mock login if only userId is provided (from audit-logs feature branch)
    if (req.body.userId && !req.body.email && !req.body.password) {
        if (!isMockLoginAllowed()) {
            return next(AppError.forbidden('Mock login is disabled outside development environments'))
        }

        const result = userIdOnlyLoginSchema.safeParse(req.body)
        if (!result.success) {
            return next(AppError.validation('Validation failed', result.error.format()))
        }

        const user = await prisma.user.findUnique({
          where: { id: result.data.userId },
          select: authUserSelect,
        })
        if (!user) {
          return next(AppError.notFound('User not found'))
        }

        const updatedUser = await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
          select: authUserSelect,
        })

        const auditLog = await createAuditLog({
          actor_user_id: updatedUser.id,
          action: "auth.login",
          target_type: "user",
          target_id: updatedUser.id,
          metadata: {
            userAgent: req.header("user-agent") ?? "unknown",
            ip: req.ip,
          },
        });

        res.status(200).json({
          user: formatAuthUser(updatedUser),
          token: `mock-token-${updatedUser.id}`,
          auditLogId: auditLog.id,
        });
        return;
    }

    // Real login flow
    const result = loginSchema.safeParse(req.body)
    if (!result.success) {
        return next(AppError.validation('Validation failed', result.error.format()))
    }

    try {
        const data = await AuthService.login(result.data)
        res.json(data)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid credentials'
        return next(AppError.unauthorized(message))
    }
})

authRouter.post('/refresh', authJson, async (req, res, next) => {
    const result = refreshSchema.safeParse(req.body)
    if (!result.success) {
        return next(AppError.validation('Validation failed', result.error.format()))
    }

    try {
        const data = await AuthService.refresh(result.data.refreshToken)
        res.json(data)
    } catch (error) {
        return next(AppError.unauthorized(error instanceof Error ? error.message : 'Invalid refresh token'))
    }
})

authRouter.post(
  "/logout",
  authJson,
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    // Schema validation keeps hostile/oversized payloads from reaching the
    // token-hashing path or polluting audit metadata.
    const bodyResult = logoutSchema.safeParse(req.body ?? {})
    if (!bodyResult.success) {
      return next(AppError.validation('Validation failed', bodyResult.error.format()))
    }

    const { refreshToken } = bodyResult.data;
    if (refreshToken) {
      try {
        await AuthService.logout(refreshToken);
      } catch (error) {
        console.error("Failed to logout refresh token:", error);
      }
    }

    // 2. Database access token session revocation
    const jti = req.user?.jti;
    if (jti) {
      await revokeSession(jti);
    }

    res.json({ message: "Successfully logged out" });
  },
);

authRouter.post('/logout-all', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user?.userId
  if (!userId) {
    return next(AppError.unauthorized('Unauthorized'))
  }

  await revokeAllUserSessions(userId);
  res.json({ message: "Successfully logged out from all devices" });
});

authRouter.post('/webauthn/challenge', authenticate, async (req, res, next) => {
  if (!req.user?.userId) {
    return next(AppError.unauthorized('Unauthorized'))
  }

  const challenge = await AuthService.issueStepUpChallenge(req.user.userId)
  res.status(200).json(challenge)
})

authRouter.post('/webauthn/assert', authJson, authenticate, async (req, res, next) => {
  if (!req.user?.userId) {
    return next(AppError.unauthorized('Unauthorized'))
  }

  // Strict boundary validation: nonce must be a UUID, credential material must
  // be bounded and well-formed so oversized or malformed assertions are
  // rejected before they reach the credential store.
  const bodyResult = webauthnAssertSchema.safeParse(req.body)
  if (!bodyResult.success) {
    return next(AppError.validation('Validation failed', bodyResult.error.format()))
  }

  const { nonce, credentialId, publicKey } = bodyResult.data

  const recorded = await AuthService.recordStepUpAssertion(nonce, req.user.userId)
  if (!recorded) {
    return next(AppError.unauthorized('Invalid or expired step-up assertion'))
  }

  await AuthService.registerWebAuthnCredential(req.user.userId, credentialId, publicKey)
  res.status(200).json({ success: true })
})

authRouter.post('/users/:id/role', requireJson, authenticate, requireStepUp(), async (req, res, next) => {
  if (!req.user) {
    return next(AppError.unauthorized('Unauthorized'))
  }
  if (req.user.role !== UserRole.ADMIN) {
    return next(AppError.forbidden('Forbidden: Only admin users can change roles'))
  }

  const paramsResult = userIdParamSchema.safeParse(req.params)
  if (!paramsResult.success) {
    return next(AppError.validation('Validation failed', paramsResult.error.format()))
  }

  if (req.user.userId === paramsResult.data.id) {
    return next(AppError.badRequest('Cannot change your own role'))
  }

  const bodyResult = userRoleUpdateSchema.safeParse(req.body)
  if (!bodyResult.success) {
    return next(AppError.validation('Validation failed', bodyResult.error.format()))
  }

  const user = await prisma.user.findUnique({
    where: { id: paramsResult.data.id },
    select: authUserSelect,
  })
  if (!user) {
    return next(AppError.notFound('User not found'))
  }

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: { role: bodyResult.data.role },
    select: authUserSelect,
  })

  const auditLog = await createAuditLog({
    actor_user_id: req.user.userId,
    action: "auth.role_changed",
    target_type: "user",
    target_id: user.id,
    metadata: {
      previousRole: user.role,
      newRole: updatedUser.role,
    },
  });

  res.status(200).json({
    user: formatAuthUser(updatedUser),
    auditLogId: auditLog.id,
  });
});