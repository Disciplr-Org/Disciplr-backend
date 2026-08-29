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

const PRISMA_RECORD_NOT_FOUND = 'P2025'

const isRecordNotFound = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === PRISMA_RECORD_NOT_FOUND

// ------------- Endpoints -------------

authRouter.post('/register', authJson, async (req, res, next) => {
    const result = registerSchema.safeParse(req.body)
    if (!result.success) {
        return next(AppError.validation('Validation failed', result.error.format()))
    }

    try {
        const user = await AuthService.register(result.data)
        res.status(201).json(user)
    } catch (error: any) {
        return next(AppError.badRequest(error.message))
    }
})

authRouter.post('/login', authJson, async (req, res, next) => {
    if (req.body.userId && !req.body.email && !req.body.password) {
        const result = userIdOnlyLoginSchema.safeParse(req.body)
        if (!result.success) {
            return next(AppError.validation('Validation failed', result.error.format()))
        }

        let updatedUser
        try {
          updatedUser = await prisma.user.update({
            where: { id: result.data.userId },
            data: { lastLoginAt: new Date() },
            select: authUserSelect,
          })
        } catch (error: unknown) {
          if (isRecordNotFound(error)) {
            return next(AppError.notFound('User not found'))
          }
          throw error
        }

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

    const result = loginSchema.safeParse(req.body)
    if (!result.success) {
        return next(AppError.validation('Validation failed', result.error.format()))
    }

    try {
        const data = await AuthService.login(result.data)
        res.json(data)
    } catch (error: any) {
        return next(AppError.unauthorized(error.message))
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
    } catch (error: any) {
        return next(AppError.unauthorized(error.message))
    }
})

authRouter.post(
  "/logout",
  authJson,
  authenticate,
  async (req: Request, res: Response) => {
    const { refreshToken } = req.body;
    if (refreshToken) {
      try {
        await AuthService.logout(refreshToken);
      } catch (error) {
        console.error("Failed to logout refresh token:", error);
      }
    }

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

authRouter.post('/webauthn/assert', authenticate, async (req, res, next) => {
  const { nonce, credentialId, publicKey } = req.body as { nonce?: string; credentialId?: string; publicKey?: string }
  if (!req.user?.userId || !nonce || !credentialId || !publicKey) {
    return next(AppError.badRequest('Missing WebAuthn assertion data'))
  }

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

  const bodyResult = userRoleUpdateSchema.safeParse(req.body)
  if (!bodyResult.success) {
    return next(AppError.validation('Validation failed', bodyResult.error.format()))
  }

  const targetUserId = paramsResult.data.id
  const nextRole = bodyResult.data.role

  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { id: targetUserId },
      select: authUserSelect,
    })
    if (!existing) {
      return { kind: 'not_found' as const }
    }

    if (existing.role === nextRole) {
      return { kind: 'noop' as const, user: existing }
    }

    const updateResult = await tx.user.updateMany({
      where: { id: targetUserId, role: existing.role },
      data: { role: nextRole },
    })
    if (updateResult.count === 0) {
      return { kind: 'conflict' as const }
    }

    const updated = await tx.user.findUnique({
      where: { id: targetUserId },
      select: authUserSelect,
    })
    if (!updated) {
      return { kind: 'not_found' as const }
    }

    return { kind: 'updated' as const, previousRole: existing.role, user: updated }
  })

  if (outcome.kind === 'not_found') {
    return next(AppError.notFound('User not found'))
  }

  if (outcome.kind === 'conflict') {
    return next(
      AppError.badRequest(
        'Role was modified concurrently; please re-read the current role and retry',
      ),
    )
  }

  if (outcome.kind === 'noop') {
    res.status(200).json({
      user: formatAuthUser(outcome.user),
      auditLogId: null,
      idempotent: true,
    })
    return
  }

  const auditLog = await createAuditLog({
    actor_user_id: req.user.userId,
    action: "auth.role_changed",
    target_type: "user",
    target_id: targetUserId,
    metadata: {
      previousRole: outcome.previousRole,
      newRole: outcome.user.role,
    },
  });

  res.status(200).json({
    user: formatAuthUser(outcome.user),
    auditLogId: auditLog.id,
  });
});
