import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { Env, getEnv, getJwtKeys, JwtKey } from '../config/env.js';

// --------------- Secrets & Keys ---------------

// Backward‑compatible single‑secret constants (fallback for legacy env vars)
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'fallback-access-secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'fallback-refresh-secret';

export const JWT_ISSUER = 'disciplr';
export const JWT_AUDIENCE = 'disciplr-api';

const MIN_SECRET_LENGTH = 32;

/** Validate that JWT secrets meet minimum length requirements. */
export function validateJwtSecrets(): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const problems: string[] = [];

  if (ACCESS_SECRET.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_ACCESS_SECRET is ${ACCESS_SECRET.length} chars (minimum ${MIN_SECRET_LENGTH})`);
  }
  if (REFRESH_SECRET.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_REFRESH_SECRET is ${REFRESH_SECRET.length} chars (minimum ${MIN_SECRET_LENGTH})`);
  }

  if (problems.length > 0) {
    const msg = `JWT secret validation failed:\n  • ${problems.join('\n  • ')}`;
    if (isProduction) {
      throw new Error(msg);
    } else {
      console.warn(`⚠️  ${msg}`);
    }
  }
}

// --------------- Password Hashing ---------------
export const hashPassword = async (password: string): Promise<string> => {
  return bcrypt.hash(password, 12);
};

export const comparePassword = async (password: string, hash: string): Promise<boolean> => {
  return bcrypt.compare(password, hash);
};

// --------------- Refresh Token Hashing ---------------
/** Hash a refresh token using SHA‑256. */
export const hashToken = (token: string): string => {
  return createHash('sha256').update(token).digest('hex');
};

/** Helper to pick the signing key.
 *  The current key is the one without a `retiredAt` value.
 *  If multiple active keys exist, the first one is used.
 */
function getCurrentKey(keys: JwtKey[]): JwtKey | undefined {
  return keys.find((k) => !k.retiredAt);
}

/** Find a key by its kid.
 *  Throws if the key is unknown or retired.
 */
function findKeyByKid(keys: JwtKey[], kid: string): JwtKey {
  const key = keys.find((k) => k.kid === kid);
  if (!key) {
    throw new Error(`Unknown JWT kid: ${kid}`);
  }
  if (key.retiredAt && new Date() > key.retiredAt) {
    throw new Error(`JWT key ${kid} has been retired`);
  }
  return key;
}

// --------------- JWT Generation ---------------
export const generateAccessToken = (payload: { userId: string; role: string; jti?: string }, env?: Env): string => {
  let keys: JwtKey[] = [];
  try {
    const resolvedEnv = env || getEnv();
    if (resolvedEnv) {
      keys = getJwtKeys(resolvedEnv);
    }
  } catch (e) {
    // ignore
  }
  const currentKey = getCurrentKey(keys);
  if (!currentKey) {
    // Fallback to single secret for legacy setups
    return jwt.sign({
      sub: payload.userId,
      role: payload.role,
      userId: payload.userId,
      ...(payload.jti && { jti: payload.jti }),
    }, ACCESS_SECRET, {
      expiresIn: (process.env.JWT_ACCESS_EXPIRES_IN || '15m') as any,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }

  const fullPayload: Record<string, unknown> = {
    sub: payload.userId,
    role: payload.role,
    userId: payload.userId,
    ...(payload.jti && { jti: payload.jti }),
  };
  return jwt.sign(fullPayload, currentKey.secret, {
    expiresIn: (process.env.JWT_ACCESS_EXPIRES_IN || '15m') as any,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    header: { kid: currentKey.kid },
  });
};

export const generateRefreshToken = (payload: { userId: string }, env?: Env): string => {
  let keys: JwtKey[] = [];
  try {
    const resolvedEnv = env || getEnv();
    if (resolvedEnv) {
      keys = getJwtKeys(resolvedEnv);
    }
  } catch (e) {
    // ignore
  }
  const currentKey = getCurrentKey(keys);
  if (!currentKey) {
    return jwt.sign(payload, REFRESH_SECRET, {
      expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as any,
    });
  }
  return jwt.sign(payload, currentKey.secret, {
    expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as any,
    header: { kid: currentKey.kid },
  });
};

// --------------- JWT Verification ---------------
export const verifyAccessToken = (token: string, env?: Env) => {
  // Try to read kid from header first
  const decodedHeader = jwt.decode(token, { complete: true }) as any;
  const kid = decodedHeader?.header?.kid;
  let keys: JwtKey[] = [];
  try {
    const resolvedEnv = env || getEnv();
    if (resolvedEnv) {
      keys = getJwtKeys(resolvedEnv);
    }
  } catch (e) {
    // ignore
  }
  if (kid) {
    const key = findKeyByKid(keys, kid);
    return jwt.verify(token, key.secret, {
      clockTolerance: 30,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as { userId: string; role: string; jti?: string; sub?: string };
  }
  // Fallback to legacy secret
  return jwt.verify(token, ACCESS_SECRET, {
    clockTolerance: 30,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  }) as { userId: string; role: string; jti?: string; sub?: string };
};

export const verifyRefreshToken = (token: string, env?: Env) => {
  const decodedHeader = jwt.decode(token, { complete: true }) as any;
  const kid = decodedHeader?.header?.kid;
  let keys: JwtKey[] = [];
  try {
    const resolvedEnv = env || getEnv();
    if (resolvedEnv) {
      keys = getJwtKeys(resolvedEnv);
    }
  } catch (e) {
    // ignore
  }
  if (kid) {
    const key = findKeyByKid(keys, kid);
    return jwt.verify(token, key.secret, { clockTolerance: 30 }) as { userId: string };
  }
  return jwt.verify(token, REFRESH_SECRET, { clockTolerance: 30 }) as { userId: string };
};
