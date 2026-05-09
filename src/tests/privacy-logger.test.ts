import { jest } from '@jest/globals'
import { Request, Response, NextFunction } from 'express'
import { privacyLogger, redact, maskIp, shouldRedact } from '../middleware/privacy-logger.js'

describe('Privacy Logger', () => {
    describe('Redaction Engine', () => {
        it('should redact sensitive fields at the top level', () => {
            const payload = {
                email: 'test@example.com',
                userId: '12345',
                token: 'super-secret-token'
            }
            const expected = {
                email: '***REDACTED***',
                userId: '12345',
                token: '***REDACTED***'
            }
            expect(redact(payload)).toEqual(expected)
        })

        it('should redact sensitive fields in nested objects', () => {
            const payload = {
                user: {
                    name: 'John Doe',
                    email: 'john@example.com',
                    auth: {
                        apiKey: 'test-api-key',
                        scopes: ['read']
                    }
                }
            }
            const expected = {
                user: {
                    name: 'John Doe',
                    email: '***REDACTED***',
                    auth: {
                        apiKey: '***REDACTED***',
                        scopes: ['read']
                    }
                }
            }
            expect(redact(payload)).toEqual(expected)
        })

        it('should redact sensitive fields within arrays', () => {
            const payload = {
                users: [
                    { id: '1', email: 'test1@example.com' },
                    { id: '2', email: 'test2@example.com' }
                ],
                tags: ['a', 'b']
            }
            const expected = {
                users: [
                    { id: '1', email: '***REDACTED***' },
                    { id: '2', email: '***REDACTED***' }
                ],
                tags: ['a', 'b']
            }
            expect(redact(payload)).toEqual(expected)
        })

        it('should handle nulls, undefined, and non-object values', () => {
            expect(redact(null)).toBeNull()
            expect(redact(undefined)).toBeUndefined()
            expect(redact('string')).toBe('string')
            expect(redact(123)).toBe(123)
        })
        
        it('should redact fields case-insensitively', () => {
            expect(redact({ EMAIL: 'test@test.com' })).toEqual({ EMAIL: '***REDACTED***' })
            expect(redact({ ApiKey: 'key' })).toEqual({ ApiKey: '***REDACTED***' })
        })
        
        it('should verify behavior of shouldRedact directly', () => {
            expect(shouldRedact('token')).toBe(true)
            expect(shouldRedact('userId')).toBe(false)
        })
        it('should handle Date, RegExp, and Buffer objects correctly', () => {
            const date = new Date('2025-01-01T00:00:00Z')
            const regex = /test/i
            const buffer = Buffer.from('test')

            const payload = {
                date,
                regex,
                buffer,
                email: 'test@example.com'
            }
            
            const expected = {
                date: date.toISOString(),
                regex: regex.toString(),
                buffer: '[Buffer]',
                email: '***REDACTED***'
            }
            expect(redact(payload)).toEqual(expected)
        })

        it('should handle circular references without stack overflow', () => {
            const payload: any = {
                email: 'test@example.com'
            }
            payload.self = payload
            
            const expected = {
                email: '***REDACTED***',
                self: '[Circular]'
            }
            expect(redact(payload)).toEqual(expected)
        })
    })

    describe('IP Masking', () => {
        it('should mask IPv4 address', () => {
            expect(maskIp('192.168.1.1')).toBe('192.168.x.x')
        })

        it('should handle unknown or malformed IPv4 gracefully', () => {
            expect(maskIp('192')).toBe('x.x.x.x')
        })

        it('should mask IPv6 address', () => {
            expect(maskIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3:xxxx:xxxx:xxxx:xxxx:xxxx')
        })
    })

    describe('Express Middleware integration', () => {
        let req: Partial<Request>
        let res: Partial<Response>
        let next: NextFunction

        beforeEach(() => {
            req = {
                ip: '192.168.0.1',
                method: 'POST',
                url: '/api/test',
                body: { email: 'user@example.com', name: 'Bob' },
                headers: { authorization: 'Bearer 1234', 'user-agent': 'jest' },
                socket: {} as any
            }
            res = {}
            next = jest.fn()
            jest.spyOn(console, 'log').mockImplementation(() => {})
        })

        afterEach(() => {
            jest.restoreAllMocks()
        })

        it('should redact body and headers before logging and call next()', () => {
            privacyLogger(req as Request, res as Response, next)
            expect(next).toHaveBeenCalled()
            
            // Cannot easily capture the strictly formatted console log without spying
            const logCalls = (console.log as jest.Mock).mock.calls
            expect(logCalls.length).toBe(1)
            const logMsg = logCalls[0][0]
            
            expect(logMsg).toContain('192.168.x.x')
            expect(logMsg).not.toContain('user@example.com')
            expect(logMsg).toContain('***REDACTED***')
            expect(logMsg).not.toContain('Bearer 1234')
            expect(logMsg).toContain('Bob')
            expect(logMsg).toContain('jest')
        })
        
        it('should ensure regression against PII leakage in logs', () => {
            req.body = { 
                apiKey: 'super_secret_key_123', 
                nested: { token: 'hidden_token', user_email: 'safe@test.com' } 
            }
            req.headers = { 'x-api-key': 'header_secret_key' }
            
            privacyLogger(req as Request, res as Response, next)
            
            const logCalls = (console.log as jest.Mock).mock.calls
            const logMsg = logCalls[0][0]
            
            // Regression test: absolutely no sensitive strings should be present
            expect(logMsg).not.toMatch(/super_secret_key_123/)
            expect(logMsg).not.toMatch(/hidden_token/)
            expect(logMsg).not.toMatch(/header_secret_key/)
            expect(logMsg).toContain('***REDACTED***')
        })
    })
})
