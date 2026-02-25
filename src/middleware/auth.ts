import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

export type Role = 'user' | 'verifier' | 'admin'

export interface JwtPayload {
     sub: string
     role: Role
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

export function authenticate(req: Request, res: Response, next: NextFunction): void {
     const authHeader = req.headers.authorization

     if (!authHeader || !authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Missing or malformed Authorization header' })
          return
     }

     const token = authHeader.slice(7)

     try {
          const payload = jwt.verify(token, JWT_SECRET) as JwtPayload
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

export function signToken(payload: JwtPayload, expiresIn = '1h'): string {
     return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions)
}