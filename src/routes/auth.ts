import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthService } from '../services/auth.service.js'
import { registerSchema, loginSchema, refreshSchema } from '../lib/validation.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { authenticate } from '../middleware/auth.js'
import { revokeSession, revokeAllUserSessions } from '../services/session.js'
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

const formatAuthUser = (user: { id: string; role: UserRole; lastLoginAt: Date | null }) => ({
  id: user.id,
  role: user.role,
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
    } catch (error: any) {
        return next(AppError.badRequest(error.message))
    }
})

authRouter.post('/login', authJson, async (req, res, next) => {
    // Support mock login if only userId is provided (from audit-logs feature branch)
    if (req.body.userId && !req.body.email && !req.body.password) {
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
    // 1. AuthService refresh token logout
    const { refreshToken } = req.body;
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

authRouter.post('/users/:id/role', requireJson, authenticate, async (req, res, next) => {
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
