import { Router, Request, Response, NextFunction } from 'express'
import { AuthService } from '../services/auth.service.js'
import { registerSchema, loginSchema, refreshSchema } from '../lib/validation.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { authenticate } from '../middleware/auth.js'
import { revokeSession, revokeAllUserSessions } from '../services/session.js'
import { requireJson } from '../middleware/requireJson.js'
import { AppError } from '../middleware/errorHandler.js'

export const authRouter = Router();

// ------------- Mock Users & Audit Logs Setup -------------
type UserRole = "user" | "verifier" | "admin";

type MockUser = {
  id: string;
  role: UserRole;
  lastLoginAt: string | null;
};

const users: MockUser[] = [];
const supportedRoles: UserRole[] = ["user", "verifier", "admin"];

const getMockUserById = (userId: string): MockUser | undefined =>
  users.find((user) => user.id === userId);

const upsertMockUser = (userId: string): MockUser => {
  const existing = getMockUserById(userId);
  if (existing) {
    return existing;
  }

  const created: MockUser = {
    id: userId,
    role: "user",
    lastLoginAt: null,
  };
  users.push(created);
  return created;
};

// ------------- Endpoints -------------

authRouter.post('/register', requireJson, async (req, res, next) => {
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

authRouter.post('/login', requireJson, async (req, res, next) => {
    // Support mock login if only userId is provided (from audit-logs feature branch)
    if (req.body.userId && !req.body.email && !req.body.password) {
        const { userId } = req.body as { userId: string }

        const now = new Date().toISOString();
        const user = upsertMockUser(userId);
        user.lastLoginAt = now;

        const auditLog = await createAuditLog({
          actor_user_id: user.id,
          action: "auth.login",
          target_type: "user",
          target_id: user.id,
          metadata: {
            userAgent: req.header("user-agent") ?? "unknown",
            ip: req.ip,
          },
        });

        res.status(200).json({
          user,
          token: `mock-token-${user.id}`,
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

authRouter.post('/refresh', requireJson, async (req, res, next) => {
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

authRouter.post('/users/:id/role', async (req, res, next) => {
  const actorRole = req.header('x-user-role')
  const actorId = req.header('x-user-id')

  if (actorRole !== 'admin') {
    return next(AppError.forbidden('Only admin users can change roles'))
  }

  if (!actorId) {
    return next(AppError.badRequest('Missing x-user-id header'))
  }

  const { role } = req.body as { role?: string };
  if (!role || !supportedRoles.includes(role as UserRole)) {
    return next(AppError.validation('Invalid role. Supported roles: user, verifier, admin'))
  }

  const user = upsertMockUser(req.params.id);
  const previousRole = user.role;
  user.role = role as UserRole;

  const auditLog = await createAuditLog({
    actor_user_id: actorId,
    action: "auth.role_changed",
    target_type: "user",
    target_id: user.id,
    metadata: {
      previousRole,
      newRole: user.role,
    },
  });

  res.status(200).json({
    user,
    auditLogId: auditLog.id,
  });
});
