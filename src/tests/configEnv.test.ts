import { initEnv, getEnv, _resetEnvForTesting, validateEnv } from '../config/env.js';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
};

describe('Environment Loader', () => {
  beforeEach(() => {
    _resetEnvForTesting();
  });

  it('should initialize and return env variables', () => {
    const customEnv = {
      NODE_ENV: 'test',
      PORT: '5000',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    };
    initEnv(customEnv as any);
    const env = getEnv();
    expect(env.PORT).toBe(5000);
    expect(env.NODE_ENV).toBe('test');
  });

  it('should throw if getEnv is called before initEnv', () => {
    expect(() => getEnv()).toThrow('Environment not validated yet — call initEnv() first');
  });

  describe('NOTIFICATION_PROVIDER', () => {
    it('defaults to "console" when not set', () => {
      const { env } = validateEnv({ ...BASE_ENV });
      expect(env.NOTIFICATION_PROVIDER).toBe('console');
    });

    it('accepts "email" as a valid value', () => {
      const { env } = validateEnv({ ...BASE_ENV, NOTIFICATION_PROVIDER: 'email' });
      expect(env.NOTIFICATION_PROVIDER).toBe('email');
    });

    it('accepts "console" as a valid value', () => {
      const { env } = validateEnv({ ...BASE_ENV, NOTIFICATION_PROVIDER: 'console' });
      expect(env.NOTIFICATION_PROVIDER).toBe('console');
    });

    it('rejects an invalid value with a validation error', () => {
      expect(() =>
        validateEnv({ ...BASE_ENV, NOTIFICATION_PROVIDER: 'smtp' }),
      ).toThrow(/NOTIFICATION_PROVIDER/);
    });
  });

  describe('DOWNLOAD_SECRET', () => {
    it('requires DOWNLOAD_SECRET to be set (security regression test)', () => {
      expect(() =>
        validateEnv({ ...BASE_ENV }),
      ).toThrow(/DOWNLOAD_SECRET/);
    });

    it('accepts a valid DOWNLOAD_SECRET value', () => {
      const { env } = validateEnv({ ...BASE_ENV, DOWNLOAD_SECRET: 'secure-secret-key-16-chars' });
      expect(env.DOWNLOAD_SECRET).toBe('secure-secret-key-16-chars');
    });

    it('rejects DOWNLOAD_SECRET shorter than 16 characters', () => {
      expect(() =>
        validateEnv({ ...BASE_ENV, DOWNLOAD_SECRET: 'short' }),
      ).toThrow(/must be at least 16 characters/);
    });
  });
});
