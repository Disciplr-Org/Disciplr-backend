import { jest } from '@jest/globals';
import { redact, shouldRedact, shouldAllow, maskIp, REDACTED, privacyLogger } from './privacy-logger';
import { Request, Response } from 'express';

describe('privacy-logger', () => {
  describe('shouldRedact', () => {
    it('identifies sensitive keys', () => {
      expect(shouldRedact('password')).toBe(true);
      expect(shouldRedact('token')).toBe(true);
      expect(shouldRedact('authorization')).toBe(true);
      expect(shouldRedact('not_sensitive')).toBe(false);
    });
  });

  describe('shouldAllow', () => {
    it('identifies allowed keys', () => {
      expect(shouldAllow('id')).toBe(true);
      expect(shouldAllow('status')).toBe(true);
      expect(shouldAllow('not_allowed')).toBe(false);
    });
  });

  describe('redact', () => {
    it('redacts sensitive fields', () => {
      const input = { password: 'secret', other: 'data' };
      const output = redact(input);
      expect(output).toEqual({ password: REDACTED, other: 'data' });
    });

    it('redacts emails and JWTs from string values', () => {
      const input = { email: 'test@example.com', jwt: 'header.payload.signature', normal: 'text' };
      const output = redact(input);
      expect(output).toEqual({ email: REDACTED, jwt: REDACTED, normal: 'text' });
    });

    it('uses allowlist mode correctly', () => {
      const input = { id: '123', secret: 'abc', other: 'def' };
      const output = redact(input, new WeakSet(), true);
      expect(output).toEqual({ id: '123', secret: REDACTED, other: REDACTED });
    });
    
    it('handles cyclic references', () => {
      const input: any = { id: '123' };
      input.self = input;
      const output = redact(input, new WeakSet(), true);
      expect(output).toEqual({ id: '123', self: REDACTED });
    });
  });

  describe('maskIp', () => {
    it('masks IPv4', () => {
      expect(maskIp('192.168.1.1')).toBe('192.168.x.x');
    });

    it('masks IPv6', () => {
      expect(maskIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3:xxxx:xxxx:xxxx:xxxx:xxxx');
    });

    it('returns unknown for missing or invalid ip', () => {
      expect(maskIp('')).toBe('unknown');
      expect(maskIp('invalid')).toBe('unknown');
    });
  });

  describe('privacyLogger', () => {
    it('logs request on finish', () => {
      const req: Partial<Request> = {
        method: 'GET',
        url: '/test',
        ip: '127.0.0.1',
        headers: { 'user-agent': 'jest' },
      };
      
      const res: Partial<Response> = {
        statusCode: 200,
        on: jest.fn((event, cb) => {
          if (event === 'finish') (cb as Function)();
          return res as Response;
        }),
      };
      
      const next = jest.fn();
      
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      privacyLogger(req as Request, res as Response, next);
      
      expect(next).toHaveBeenCalled();
      expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
      
      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logOutput.event).toBe('http.request');
      expect(logOutput.method).toBe('GET');
      expect(logOutput.ip).toBe('127.0.x.x');
      expect(logOutput.headers['user-agent']).toBe('jest');
      
      consoleSpy.mockRestore();
    });

    it('handles serialization errors gracefully', () => {
      const req: Partial<Request> = {
        method: 'GET',
        url: '/test',
        headers: {},
      };
      const circular: any = {};
      circular.circular = circular;
      
      // Override redact so we can throw an error on purpose, since JSON.stringify is wrapped in try-catch
      // actually, let's just make the line circular, or mock Date.now to throw error
      const mockDate = jest.spyOn(Date.prototype, 'toISOString').mockImplementation(() => { throw new Error('fail'); });
      
      const res: Partial<Response> = {
        statusCode: 200,
        on: jest.fn((event, cb) => {
          if (event === 'finish') (cb as Function)();
          return res as Response;
        }),
      };
      const next = jest.fn();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      privacyLogger(req as Request, res as Response, next);
      
      const logOutput = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logOutput.event).toBe('privacy-logger.serialization-failure');
      expect(logOutput.level).toBe('error');
      
      consoleSpy.mockRestore();
      mockDate.mockRestore();
    });
  });
});
