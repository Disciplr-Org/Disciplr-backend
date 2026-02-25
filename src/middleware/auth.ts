import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { recordSession, validateSession } from '../services/session.js'

export type Role = 'user' | 'verifier' | 'admin'

export interface JwtPayload {
     sub: string
     role: Role
     jti: string
     email?: string
}

declare global {
     namespace Express {
          interface Request {
               user?: JwtPayload
          }
     }
}

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
     const authHeader = req.headers.authorization

     if (!authHeader || !authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Missing or malformed Authorization header' })
          return
     }

     const token = authHeader.slice(7)

     try {
          const payload = jwt.verify(token, JWT_SECRET) as JwtPayload
          
          const isValid = await validateSession(payload.jti)
          
          if (!isValid) {
               res.status(401).json({ error: 'Session revoked or expired' })
               return
          }

          req.user = payload
          next()
     } catch (err) {
          if (err instanceof jwt.TokenExpiredError) {
               res.status(401).json({ error: 'Token expired' })
          } else {
               res.status(401).json({ error: 'Invalid token' })
          }
     }
}

export async function signToken(payload: Omit<JwtPayload, 'jti'>, expiresIn = '1h'): Promise<string> {
     const jti = randomUUID()
     const fullPayload = { ...payload, jti }
     
     // Calculate expiration date
     // Default matches 1h (1 hour)
     const durationMs = 60 * 60 * 1000 
     const expiresAt = new Date(Date.now() + durationMs)
     
     await recordSession(payload.sub, jti, expiresAt)
     
     return jwt.sign(fullPayload, JWT_SECRET, { expiresIn } as jwt.SignOptions)
}