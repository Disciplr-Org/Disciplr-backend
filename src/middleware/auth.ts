import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { recordSession, validateSession } from "../services/session.js";
import { UserRole } from "../types/user.js";
import { getJwtSecret, verifyAccessToken } from "../lib/auth-utils.js";
import { config } from "../config/index.js";

import { JWTPayload } from "../types/auth.js";

export type Role = "user" | "verifier" | "admin";

// Use JWTPayload from types/auth.ts as source of truth, adding jti for sessions
export type JwtPayload = JWTPayload & { jti?: string };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfProtection(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    // Only treat bearer tokens as CSRF-safe when they are verifiable JWTs.
    // This avoids trusting unsigned or mock "user:<id>" bearer tokens used by
    // legacy/dev routers (see requireUserAuth) which are not resistant to CSRF.
    try {
      try {
        verifyAccessToken(token)
        next()
        return
      } catch (_) {
        // fallback to legacy secret
        jwt.verify(token, getJwtSecret())
        next()
        return
      }
    } catch {
      // Token was not verifiable -> fall through to normal CSRF checks
    }
  }

  const origin = req.headers.origin as string | undefined;
  const referer = req.headers.referer as string | undefined;

  if (!origin && !referer) {
    next();
    return;
  }

  const allowedOrigins = config.corsOrigins;

  if (origin) {
    if (allowedOrigins === "*") {
      next();
      return;
    }
    if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
      next();
      return;
    }
  }

  if (!origin && referer) {
    try {
      const refererUrl = new URL(referer);
      const refererOrigin = `${refererUrl.protocol}//${refererUrl.host}`;
      if (allowedOrigins === "*") {
        next();
        return;
      }
      if (
        Array.isArray(allowedOrigins) &&
        allowedOrigins.includes(refererOrigin)
      ) {
        next();
        return;
      }
    } catch {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  res.status(403).json({ error: "Forbidden" });
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res
      .status(401)
      .json({
        error: "Unauthorized: Missing or malformed Authorization header",
      });
    return;
  }

  const token = authHeader.slice(7);

  try {
    // First try verifyAccessToken from lib/auth-utils.ts (which uses JWT_ACCESS_SECRET)
    let payload: JwtPayload;
    try {
      payload = verifyAccessToken(token) as JwtPayload;
    } catch {
      // Fallback to legacy JWT_SECRET for backward compatibility
      payload = jwt.verify(token, getJwtSecret()) as JwtPayload;
    }

    // Reject tokens with iat too far in the future (beyond clock tolerance)
    const iat = (payload as any).iat as number | undefined;
    if (iat && iat > Math.floor(Date.now() / 1000) + 30) {
      res.status(401).json({ error: "Unauthorized: Invalid token" });
      return;
    }

    if (payload.jti) {
      const isValid = await validateSession(payload.jti);

      if (!isValid) {
        res
          .status(401)
          .json({ error: "Unauthorized: Session revoked or expired" });
        return;
      }
    }

    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: "Unauthorized: Token expired" });
    } else {
      res.status(401).json({ error: "Unauthorized: Invalid token" });
    }
  }
}

export async function signToken(
  payload: Omit<JwtPayload, "jti">,
  expiresIn = "1h",
): Promise<string> {
  const jti = randomUUID();
  const fullPayload = { ...payload, jti };

  // Derive the session expiry from the same `expiresIn` value passed to jwt.sign.
  const parseExpiresInToMs = (val: string | number): number => {
    if (typeof val === 'number') return val * 1000
    // Accept formats like '30s', '15m', '1h', '2d' or a numeric string of seconds
    const m = /^([0-9]+)(s|m|h|d)$/.exec(val)
    if (m) {
      const n = Number(m[1])
      switch (m[2]) {
        case 's':
          return n * 1000
        case 'm':
          return n * 60 * 1000
        case 'h':
          return n * 60 * 60 * 1000
        case 'd':
          return n * 24 * 60 * 60 * 1000
      }
    }
    if (/^[0-9]+$/.test(String(val))) return Number(val) * 1000
    // Fallback to 1 hour if we cannot parse
    return 60 * 60 * 1000
  }

  const durationMs = parseExpiresInToMs(expiresIn)
  const expiresAt = new Date(Date.now() + durationMs)

  await recordSession(payload.userId, jti, expiresAt)

  return jwt.sign(fullPayload, getJwtSecret(), { expiresIn } as jwt.SignOptions)
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

export function getAuthenticatedUserId(req: Request): string | null {
  const candidates = [
    (req as any).user?.userId,
    (req as any).user?.sub,
    (req as any).authUser?.userId,
    (req as any).authUser?.sub,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return null;
}

export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized: Authentication required" });
    return;
  }
  // Block impersonation tokens from accessing admin endpoints
  if (req.user.impersonator) {
    res
      .status(403)
      .json({
        error: "Forbidden: Impersonation tokens cannot access admin endpoints",
      });
    return;
  }
  if (req.user.role !== "ADMIN") {
    res.status(403).json({ error: "Forbidden: Admin role required" });
    return;
  }
  next();
}

export function authorize(allowedRoles: UserRole[]) {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }

    if (!allowedRoles.includes(req.user.role as UserRole)) {
      res.status(403).json({
        error: `Forbidden: requires role ${allowedRoles.join(" or ")}, got '${req.user.role}'`,
      });
      return;
    }

    next();
  };
}

/** Generate a time-limited, HMAC-signed download token */
const DOWNLOAD_SECRET = process.env.DOWNLOAD_SECRET;

if (!DOWNLOAD_SECRET) {
  throw new Error(
    "DOWNLOAD_SECRET environment variable is required. Set it to a strong, random secret to secure export download tokens."
  );
}

const DOWNLOAD_SECRET_TYPED = DOWNLOAD_SECRET as string;

export function signDownloadToken(
  jobId: string,
  userId: string,
  ttlSeconds = 3600,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${jobId}:${userId}:${exp}`;
  const sig = crypto
    .createHmac("sha256", DOWNLOAD_SECRET_TYPED)
    .update(payload)
    .digest("hex");
  return Buffer.from(JSON.stringify({ jobId, userId, exp, sig })).toString(
    "base64url",
  );
}

export function verifyDownloadToken(
  token: string,
): { jobId: string; userId: string } | null {
  try {
    const { jobId, userId, exp, sig } = JSON.parse(
      Buffer.from(token, "base64url").toString(),
    ) as { jobId: string; userId: string; exp: number; sig: string };

    if (Date.now() / 1000 > exp) return null;

    const expected = crypto
      .createHmac("sha256", DOWNLOAD_SECRET_TYPED)
      .update(`${jobId}:${userId}:${exp}`)
      .digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
      return null;

    return { jobId, userId };
  } catch {
    return null;
  }
}
/**
 * @deprecated Use standard `authenticate` instead. Legacy mock auth for early dev. Tracking removal in #454
 */
export const requireUserAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const headerUserId = req.header("x-user-id")?.trim();
  let bearerUserId = null;
  const authHeader = req.header("authorization");
  if (authHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (match) {
      const token = match[1].trim();
      bearerUserId = token.startsWith("user:") ? token.slice(5) : token;
    }
  }
  const userId = headerUserId || bearerUserId;

  if (!userId) {
    res.status(401).json({
      error:
        "Authentication required. Provide x-user-id header or Authorization: Bearer user:<user-id>.",
    });
    return;
  }

  // @ts-ignore - Preserving legacy property assignment
  req.authUser = { userId };
  next();
};
