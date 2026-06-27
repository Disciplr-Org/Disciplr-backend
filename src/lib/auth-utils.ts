import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { Env, getEnv, getJwtKeys, JwtKey } from '../config/env.js';

// --------------- Secrets & Keys ---------------

const DEFAULT_ACCESS_SECRET = 'fallback-access-secret';
const DEFAULT_REFRESH_SECRET = 'fallback-refresh-secret';
const DEFAULT_JWT_ISSUER = 'disciplr';
const DEFAULT_JWT_AUDIENCE = 'disciplr-api';

export const JWT_ISSUER = DEFAULT_JWT_ISSUER;
export const JWT_AUDIENCE = DEFAULT_JWT_AUDIENCE;

const MIN_SECRET_LENGTH = 32;

type AccessTokenPayloadInput = {
  userId: string;
  role: string;
  jti?: string;
  email?: string;
  isEnterprise?: boolean;
  enterpriseId?: string;
  expiresIn?: string;
};

interface JwtRuntimeConfig {
  keys: JwtKey[];
  accessSecret: string;
  refreshSecret: string;
  issuer: string;
  audience: string;
  accessExpiresIn: string;
  refreshExpiresIn: string;
}

function parseJwtKeysFromProcessEnv(): JwtKey[] {
  if (!process.env.JWT_KEYS) return [];
  const parsed = JSON.parse(process.env.JWT_KEYS);
  if (!Array.isArray(parsed)) {
    throw new Error('JWT_KEYS must be an array');
  }
  return parsed.map((item: any) => ({
    kid: item.kid,
    secret: item.secret,
    retiredAt: item.retiredAt ? new Date(item.retiredAt) : undefined,
  }));
}

function resolveJwtRuntimeConfig(env?: Env): JwtRuntimeConfig {
  let resolvedEnv: Env | undefined;
  try {
    resolvedEnv = env || getEnv();
  } catch {
    resolvedEnv = undefined;
  }

  const keys = resolvedEnv ? getJwtKeys(resolvedEnv) : parseJwtKeysFromProcessEnv();

  return {
    keys,
    accessSecret:
      resolvedEnv?.JWT_ACCESS_SECRET ??
      process.env.JWT_ACCESS_SECRET ??
      process.env.JWT_SECRET ??
      DEFAULT_ACCESS_SECRET,
    refreshSecret:
      resolvedEnv?.JWT_REFRESH_SECRET ??
      process.env.JWT_REFRESH_SECRET ??
      DEFAULT_REFRESH_SECRET,
    issuer: resolvedEnv?.JWT_ISSUER ?? process.env.JWT_ISSUER ?? DEFAULT_JWT_ISSUER,
    audience: resolvedEnv?.JWT_AUDIENCE ?? process.env.JWT_AUDIENCE ?? DEFAULT_JWT_AUDIENCE,
    accessExpiresIn:
      resolvedEnv?.JWT_ACCESS_EXPIRES_IN ?? process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    refreshExpiresIn:
      resolvedEnv?.JWT_REFRESH_EXPIRES_IN ?? process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  };
}

/** Validate that JWT secrets meet minimum length requirements. */
export function validateJwtSecrets(): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const problems: string[] = [];
  const { accessSecret, refreshSecret } = resolveJwtRuntimeConfig();

  if (accessSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_ACCESS_SECRET is ${accessSecret.length} chars (minimum ${MIN_SECRET_LENGTH})`);
  }
  if (refreshSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_REFRESH_SECRET is ${refreshSecret.length} chars (minimum ${MIN_SECRET_LENGTH})`);
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
export const generateAccessToken = (payload: AccessTokenPayloadInput, env?: Env): string => {
  const config = resolveJwtRuntimeConfig(env);
  const keys = config.keys;
  const currentKey = getCurrentKey(keys);
  const fullPayload: Record<string, unknown> = {
    sub: payload.userId,
    role: payload.role,
    userId: payload.userId,
    ...(payload.email && { email: payload.email }),
    ...(payload.jti && { jti: payload.jti }),
    ...(payload.isEnterprise !== undefined && { isEnterprise: payload.isEnterprise }),
    ...(payload.enterpriseId && { enterpriseId: payload.enterpriseId }),
  };

  if (!currentKey) {
    // Fallback to single secret for legacy setups
    return jwt.sign(fullPayload, config.accessSecret, {
      expiresIn: (payload.expiresIn ?? config.accessExpiresIn) as any,
      issuer: config.issuer,
      audience: config.audience,
    });
  }

  return jwt.sign(fullPayload, currentKey.secret, {
    expiresIn: (payload.expiresIn ?? config.accessExpiresIn) as any,
    issuer: config.issuer,
    audience: config.audience,
    header: { alg: 'HS256', kid: currentKey.kid },
  });
};

export const generateRefreshToken = (payload: { userId: string }, env?: Env): string => {
  const config = resolveJwtRuntimeConfig(env);
  const keys = config.keys;
  const currentKey = getCurrentKey(keys);
  if (!currentKey) {
    return jwt.sign(payload, config.refreshSecret, {
      expiresIn: config.refreshExpiresIn as any,
      issuer: config.issuer,
      audience: config.audience,
    });
  }
  return jwt.sign(payload, currentKey.secret, {
    expiresIn: config.refreshExpiresIn as any,
    issuer: config.issuer,
    audience: config.audience,
    header: { alg: 'HS256', kid: currentKey.kid },
  });
};

// --------------- JWT Verification ---------------
export const verifyAccessToken = (token: string, env?: Env) => {
  // Try to read kid from header first
  const decodedHeader = jwt.decode(token, { complete: true }) as any;
  const kid = decodedHeader?.header?.kid;
  const config = resolveJwtRuntimeConfig(env);
  const keys = config.keys;
  if (kid) {
    const key = findKeyByKid(keys, kid);
    return jwt.verify(token, key.secret, {
      clockTolerance: 30,
      issuer: config.issuer,
      audience: config.audience,
    }) as { userId: string; role: string; jti?: string; sub?: string };
  }
  // Fallback to legacy secret
  return jwt.verify(token, config.accessSecret, {
    clockTolerance: 30,
    issuer: config.issuer,
    audience: config.audience,
  }) as { userId: string; role: string; jti?: string; sub?: string };
};

export const verifyRefreshToken = (token: string, env?: Env) => {
  const decodedHeader = jwt.decode(token, { complete: true }) as any;
  const kid = decodedHeader?.header?.kid;
  const config = resolveJwtRuntimeConfig(env);
  const keys = config.keys;
  if (kid) {
    const key = findKeyByKid(keys, kid);
    return jwt.verify(token, key.secret, {
      clockTolerance: 30,
      issuer: config.issuer,
      audience: config.audience,
    }) as { userId: string };
  }
  return jwt.verify(token, config.refreshSecret, {
    clockTolerance: 30,
    issuer: config.issuer,
    audience: config.audience,
  }) as { userId: string };
};
