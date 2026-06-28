import { Request, Response, NextFunction } from 'express'
import { requireUserAuth } from '../middleware/auth.js'
import { jest, describe, it, expect } from '@jest/globals'

describe('Auth Middleware Consolidation', () => {
    it('requireUserAuth sets authUser from x-user-id header', () => {
        const req = { header: (name: string) => name === 'x-user-id' ? 'legacy-123' : undefined } as any
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
        const next = jest.fn()
        
        requireUserAuth(req, res, next)
        
        expect(req.authUser.userId).toBe('legacy-123')
        expect(next).toHaveBeenCalled()
    })

    it('requireUserAuth rejects missing auth', () => {
        const req = { header: () => undefined } as any
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
        const next = jest.fn()
        
        requireUserAuth(req, res, next)
        
        expect(res.status).toHaveBeenCalledWith(401)
        expect(next).not.toHaveBeenCalled()
    })
})
