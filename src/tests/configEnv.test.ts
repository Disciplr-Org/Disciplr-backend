import { initEnv, getEnv, _resetEnvForTesting } from '../config/env.js';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

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
});
