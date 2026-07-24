import jwt from 'jsonwebtoken';
import { describe, expect, it, beforeEach } from '@jest/globals';
import { initEnv, _resetEnvForTesting, getEnv } from '../config/env.js';
import { generateAccessToken, verifyAccessToken } from '../lib/auth-utils.js';

const MINIMAL_ENV = {
  NODE_ENV: 'test' as const,
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'access-secret-test-0123456789',
  JWT_REFRESH_SECRET: 'refresh-secret-test-0123456789',
  JWT_ISSUER: 'disciplr',
  JWT_AUDIENCE: 'disciplr-api',
};

describe('JWT access token aud/iss validation', () => {
  beforeEach(() => {
    _resetEnvForTesting();
    initEnv(MINIMAL_ENV as any);
  });

  it('accepts a valid access token with configured issuer and audience', () => {
    const env = getEnv();
    const token = generateAccessToken({ userId: 'user-1', role: 'USER', jti: 'jti-1' }, env);
    const payload = verifyAccessToken(token, env);

    expect(payload.userId).toBe('user-1');
    expect(payload.role).toBe('USER');
    expect((payload as any).jti).toBe('jti-1');
  });

  it('rejects a token with the wrong audience', () => {
    const env = getEnv();
    const token = jwt.sign(
      { sub: 'user-2', userId: 'user-2', role: 'USER', jti: 'jti-2' },
      env.JWT_ACCESS_SECRET,
      { issuer: env.JWT_ISSUER, audience: 'other-service', expiresIn: '15m' },
    );

    expect(() => verifyAccessToken(token, env)).toThrow(/audience invalid/i);
  });

  it('rejects a token with the wrong issuer', () => {
    const env = getEnv();
    const token = jwt.sign(
      { sub: 'user-3', userId: 'user-3', role: 'USER', jti: 'jti-3' },
      env.JWT_ACCESS_SECRET,
      { issuer: 'other-issuer', audience: env.JWT_AUDIENCE, expiresIn: '15m' },
    );

    expect(() => verifyAccessToken(token, env)).toThrow(/issuer invalid/i);
  });

  it('rejects a token missing required issuer and audience claims', () => {
    const env = getEnv();
    const token = jwt.sign(
      { sub: 'user-4', userId: 'user-4', role: 'USER', jti: 'jti-4' },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '15m' },
    );

    expect(() => verifyAccessToken(token, env)).toThrow(/issuer invalid/i);
  });

  it('accepts a token signed with a rotated active kid and valid aud/iss', () => {
    const env = initEnv({
      ...MINIMAL_ENV,
      JWT_KEYS: JSON.stringify([
        { kid: 'current', secret: 'current-secret-0123456789' },
        { kid: 'previous', secret: 'previous-secret-0123456789' },
      ]),
    } as any).env;

    const currentKey = getEnv().JWT_KEYS as any;
    const token = jwt.sign(
      { sub: 'user-5', userId: 'user-5', role: 'USER', jti: 'jti-5' },
      'previous-secret-0123456789',
      {
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        expiresIn: '15m',
        header: { kid: 'previous' },
      },
    );

    const payload = verifyAccessToken(token, env);
    expect(payload.userId).toBe('user-5');
    expect(payload.role).toBe('USER');
  });
});
