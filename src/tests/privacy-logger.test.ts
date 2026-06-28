/* global describe, it, expect, beforeEach, afterEach, Buffer */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { jest } from '@jest/globals'
import fc from 'fast-check'
import { Request, Response, NextFunction } from 'express'
import {
    privacyLogger,
    redact,
    maskIp,
    shouldRedact,
    REDACTION_MARKER,
    SENSITIVE_KEYS,
} from '../middleware/privacy-logger.js'
import * as loggerModule from '../middleware/logger.js'

const PROPERTY_RUNS = { numRuns: 100 }
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')
const BASE64URL_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')

const safeKeyArb = fc
    .array(fc.constantFrom(...KEY_CHARS), { minLength: 1, maxLength: 12 })
    .map(chars => chars.join(''))
    .filter(key => !SENSITIVE_KEYS.has(key.toLowerCase()))

const safeStringArb = fc
    .string({ maxLength: 40 })
    .filter(value => !EMAIL_PATTERN.test(value) && !JWT_PATTERN.test(value))

const safePrimitiveArb = fc.oneof(
    safeStringArb,
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
)

const safeJsonArb: fc.Arbitrary<unknown> = fc.letrec(tie => ({
    value: fc.oneof(
        safePrimitiveArb,
        fc.array(tie('value'), { maxLength: 3 }),
        fc.dictionary(safeKeyArb, tie('value'), { maxKeys: 4 }),
    ),
})).value

const safeObjectArb = fc.dictionary(safeKeyArb, safeJsonArb, { maxKeys: 4 })

const jwtArb = fc
    .tuple(
        fc.array(fc.constantFrom(...BASE64URL_CHARS), { minLength: 1, maxLength: 16 }),
        fc.array(fc.constantFrom(...BASE64URL_CHARS), { minLength: 1, maxLength: 16 }),
        fc.array(fc.constantFrom(...BASE64URL_CHARS), { minLength: 1, maxLength: 16 }),
    )
    .map(parts => parts.map(chars => chars.join('')).join('.'))

const ipv4Arb = fc
    .tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
    )
    .map(parts => parts.join('.'))

const ipv6Arb = fc
    .array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 })
    .map(groups => groups.map(group => group.toString(16).padStart(4, '0')).join(':'))

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value))
}

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

    describe('Property-based privacy invariants', () => {
        it('redacts every sensitive key at arbitrary nesting depths', () => {
            // Feature: privacy-logger, Property 1: sensitive keys are redacted at every depth.
            fc.assert(
                fc.property(
                    fc.constantFrom(...Array.from(SENSITIVE_KEYS)),
                    safePrimitiveArb,
                    fc.integer({ min: 0, max: 5 }),
                    (sensitiveKey, sensitiveValue, depth) => {
                        const wrappers = Array.from({ length: depth }, (_, index) => `level${index}`)
                        let input: Record<string, unknown> = { [sensitiveKey]: sensitiveValue }

                        for (const wrapper of [...wrappers].reverse()) {
                            input = { [wrapper]: input }
                        }

                        let output: any = redact(input)
                        for (const wrapper of wrappers) {
                            output = output[wrapper]
                        }

                        expect(output[sensitiveKey]).toBe(REDACTION_MARKER)
                    },
                ),
                PROPERTY_RUNS,
            )
        })

        it('preserves safe objects without sensitive keys or PII-pattern values', () => {
            // Feature: privacy-logger, Property 2: safe values are preserved deep-equal.
            fc.assert(
                fc.property(safeObjectArb, safeObject => {
                    expect(redact(safeObject)).toEqual(safeObject)
                }),
                PROPERTY_RUNS,
            )
        })

        it('does not mutate its input object', () => {
            // Feature: privacy-logger, Property 3: redact is immutable.
            fc.assert(
                fc.property(safeObjectArb, safeObject => {
                    const before = cloneJson(safeObject)
                    redact(safeObject)
                    expect(safeObject).toEqual(before)
                }),
                PROPERTY_RUNS,
            )
        })

        it('redacts email-shaped string values regardless of key name', () => {
            // Feature: privacy-logger, Property 4: email-pattern values are redacted.
            fc.assert(
                fc.property(safeKeyArb, fc.emailAddress(), (key, email) => {
                    expect(redact({ [key]: email })).toEqual({ [key]: REDACTION_MARKER })
                }),
                PROPERTY_RUNS,
            )
        })

        it('redacts JWT-shaped string values regardless of key name', () => {
            // Feature: privacy-logger, Property 5: JWT-pattern values are redacted.
            fc.assert(
                fc.property(safeKeyArb, jwtArb, (key, jwt) => {
                    expect(redact({ [key]: jwt })).toEqual({ [key]: REDACTION_MARKER })
                }),
                PROPERTY_RUNS,
            )
        })

        it('redacts array elements recursively into a new array', () => {
            // Feature: privacy-logger, Property 6: array elements are recursively redacted.
            fc.assert(
                fc.property(
                    fc.array(
                        fc.record({
                            safeKey: safeKeyArb,
                            sensitiveKey: fc.constantFrom(...Array.from(SENSITIVE_KEYS)),
                            value: safePrimitiveArb,
                        }),
                        { minLength: 1, maxLength: 8 },
                    ),
                    entries => {
                        const input = entries.map(entry => ({
                            [entry.safeKey]: 'safe-value',
                            nested: { [entry.sensitiveKey]: entry.value },
                        }))

                        const output = redact(input)

                        expect(output).not.toBe(input)
                        output.forEach((item: any, index: number) => {
                            expect(item).not.toBe(input[index])
                            expect(item.nested[entries[index].sensitiveKey]).toBe(REDACTION_MARKER)
                        })
                    },
                ),
                PROPERTY_RUNS,
            )
        })

        it('emits only the documented structured log keys', () => {
            // Feature: privacy-logger, Property 7: emitted log line has the required key set only.
            fc.assert(
                fc.property(
                    fc.constantFrom('GET', 'POST', 'PUT', 'PATCH', 'DELETE'),
                    fc.webPath(),
                    safeObjectArb,
                    safeObjectArb,
                    (method, url, body, headers) => {
                        const mockLogger = {
                            debug: jest.fn(),
                            info: jest.fn(),
                            warn: jest.fn(),
                            error: jest.fn(),
                        }
                        const next = jest.fn()
                        const childSpy = jest
                            .spyOn(loggerModule.logger, 'child')
                            .mockReturnValue(mockLogger as any)

                        try {
                            privacyLogger(
                                {
                                    ip: '203.0.113.42',
                                    method,
                                    url,
                                    body,
                                    headers,
                                    socket: {} as any,
                                } as Request,
                                {} as Response,
                                next,
                            )

                            const logObject = mockLogger.debug.mock.calls[0][0]
                            expect(Object.keys(logObject).sort()).toEqual(['event', 'ip', 'request', 'timestamp'])
                            expect(Object.keys(logObject.ip).sort()).toEqual(['masked', 'original'])
                            expect(Object.keys(logObject.request).sort()).toEqual([
                                'body',
                                'headers',
                                'method',
                                'url',
                            ])
                            expect(next).toHaveBeenCalledTimes(1)
                        } finally {
                            childSpy.mockRestore()
                        }
                    },
                ),
                PROPERTY_RUNS,
            )
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

        it('masks arbitrary IPv4 and IPv6 values into stable shapes', () => {
            // Feature: privacy-logger, Property 8: IP masking keeps only the allowed prefix.
            fc.assert(
                fc.property(ipv4Arb, ip => {
                    expect(maskIp(ip)).toMatch(/^\d+\.\d+\.x\.x$/)
                }),
                PROPERTY_RUNS,
            )

            fc.assert(
                fc.property(ipv6Arb, ip => {
                    const masked = maskIp(ip)
                    const maskedGroups = masked.split(':')

                    expect(maskedGroups).toHaveLength(8)
                    expect(maskedGroups.slice(0, 3)).toEqual(ip.split(':').slice(0, 3))
                    expect(maskedGroups.slice(3)).toEqual(['xxxx', 'xxxx', 'xxxx', 'xxxx', 'xxxx'])
                }),
                PROPERTY_RUNS,
            )

            expect(maskIp('2001:db8::1')).toBe('2001:db8:0:xxxx:xxxx:xxxx:xxxx:xxxx')
        })
    })

    describe('Express Middleware integration with Pino', () => {
        let req: Partial<Request>
        let res: Partial<Response>
        let next: NextFunction
        let mockLogger: any

        beforeEach(() => {
            jest.clearAllMocks()

            mockLogger = {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            }

            req = {
                ip: '192.168.0.1',
                method: 'POST',
                url: '/api/test',
                body: { email: 'user@example.com', name: 'Bob' },
                headers: { 
                    authorization: 'Bearer 1234', 
                    'user-agent': 'jest',
                    'x-correlation-id': 'test-corr-id'
                },
                socket: {} as any
            }
            res = {}
            next = jest.fn()

            jest.spyOn(loggerModule.logger, 'child').mockReturnValue(mockLogger as any)
        })

        afterEach(() => {
            jest.restoreAllMocks()
        })

        it('should call privacyLogger and invoke next', () => {
            privacyLogger(req as Request, res as Response, next)
            expect(next).toHaveBeenCalled()
        })

        it('should emit structured JSON log event through pino', () => {
            privacyLogger(req as Request, res as Response, next)
            
            expect(mockLogger.debug).toHaveBeenCalled()
            const callArgs = mockLogger.debug.mock.calls[0]
            
            // First argument should be the structured log object
            const logObject = callArgs[0]
            expect(logObject.event).toBe('privacy.request_logged')
            expect(logObject.ip.original).toBe('192.168.0.1')
            expect(logObject.ip.masked).toBe('192.168.x.x')
            expect(logObject.request.method).toBe('POST')
            expect(logObject.request.url).toBe('/api/test')
        })

        it('should redact sensitive fields in structured log output', () => {
            privacyLogger(req as Request, res as Response, next)
            
            const logObject = mockLogger.debug.mock.calls[0][0]
            
            // Body should have redacted email
            expect(logObject.request.body.email).toBe('***REDACTED***')
            expect(logObject.request.body.name).toBe('Bob')
            
            // Headers should have redacted authorization
            expect(logObject.request.headers.authorization).toBe('***REDACTED***')
            expect(logObject.request.headers['user-agent']).toBe('jest')
        })

        it('should emit human-readable message as second argument', () => {
            privacyLogger(req as Request, res as Response, next)
            
            const callArgs = mockLogger.debug.mock.calls[0]
            const message = callArgs[1]
            
            expect(message).toContain('Privacy-logged')
            expect(message).toContain('POST')
            expect(message).toContain('/api/test')
        })

        it('should handle correlation IDs from request headers', () => {
            privacyLogger(req as Request, res as Response, next)
            
            expect((req as any).correlationId).toBe('test-corr-id')
        })

        it('should ensure regression against PII leakage in structured logs', () => {
            req.body = { 
                apiKey: 'super_secret_key_123', 
                nested: { token: 'hidden_token', user_email: 'safe@test.com' } 
            }
            req.headers = { 'x-api-key': 'header_secret_key' }
            
            privacyLogger(req as Request, res as Response, next)
            
            const logObject = mockLogger.debug.mock.calls[0][0]
            const logString = JSON.stringify(logObject)
            
            // Regression test: absolutely no sensitive strings should be present
            expect(logString).not.toMatch(/super_secret_key_123/)
            expect(logString).not.toMatch(/hidden_token/)
            expect(logString).not.toMatch(/header_secret_key/)
            expect(logString).toContain('***REDACTED***')
        })

        it('should attach correlation ID and logger to request for downstream handlers', () => {
            privacyLogger(req as Request, res as Response, next)
            
            expect((req as any).correlationId).toBe('test-corr-id')
            expect((req as any).logger).toBeDefined()
        })
    })

    describe('Structured JSON output format', () => {
        let req: Partial<Request>
        let res: Partial<Response>
        let next: NextFunction
        let mockLogger: any

        beforeEach(() => {
            jest.clearAllMocks()

            mockLogger = {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            }

            req = {
                ip: '10.0.0.5',
                method: 'DELETE',
                url: '/api/vaults/123',
                body: {},
                headers: { 'user-id': '456' },
                socket: {} as any
            }
            res = {}
            next = jest.fn()

            jest.spyOn(loggerModule.logger, 'child').mockReturnValue(mockLogger as any)
        })

        it('should emit complete and valid JSON structure', () => {
            privacyLogger(req as Request, res as Response, next)
            
            const logObject = mockLogger.debug.mock.calls[0][0]
            
            // Verify all required fields are present
            expect(logObject).toHaveProperty('event')
            expect(logObject).toHaveProperty('ip')
            expect(logObject).toHaveProperty('request')
            expect(logObject).toHaveProperty('timestamp')
            
            // Verify nested structures
            expect(logObject.ip).toHaveProperty('original')
            expect(logObject.ip).toHaveProperty('masked')
            expect(logObject.request).toHaveProperty('method')
            expect(logObject.request).toHaveProperty('url')
            expect(logObject.request).toHaveProperty('headers')
            expect(logObject.request).toHaveProperty('body')
            
            // Verify JSON serializability
            expect(() => JSON.stringify(logObject)).not.toThrow()
        })
    })
})
