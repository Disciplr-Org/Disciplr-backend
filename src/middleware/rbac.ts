import { Request, Response, NextFunction } from 'express'
import { UserRole } from '../types/user.js'

type RBACOptions = {
  allow: UserRole[];
};

const logRBACDenied = (req: Request, reason: string) => {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "security.rbac_denied",
      service: "disciplr-backend",
      userId: req.user?.userId ?? "unknown",
      role: req.user?.role ?? "unknown",
      path: req.originalUrl,
      method: req.method,
      reason,
      timestamp: new Date().toISOString(),
    }),
  );
};

export const enforceRBAC = (options: RBACOptions) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Deny by default
    if (!req.user) {
      logRBACDenied(req, "missing_user");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!options.allow.includes(req.user.role)) {
      logRBACDenied(req, "insufficient_role");
      res.status(403).json({
        error: "Forbidden",
        message: `Requires role: ${options.allow.join(", ")}`,
      });
      return;
    }

    next();
  };
};

// Convenience
export const requireAdmin = enforceRBAC({
  allow: [UserRole.ADMIN],
});
