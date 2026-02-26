import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'fallback-access-secret'
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'fallback-refresh-secret'

export const hashPassword = async (password: string): Promise<string> => {
    return bcrypt.hash(password, 10)
}

export const comparePassword = async (password: string, hash: string): Promise<boolean> => {
    return bcrypt.compare(password, hash)
}

export const generateAccessToken = (payload: { userId: string; role: string }): string => {
    return jwt.sign(payload, ACCESS_SECRET, {
        expiresIn: (process.env.JWT_ACCESS_EXPIRES_IN || '15m') as any,
    })
}

export const generateRefreshToken = (payload: { userId: string }): string => {
    return jwt.sign(payload, REFRESH_SECRET, {
        expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as any,
    })
}

export const verifyAccessToken = (token: string) => {
    return jwt.verify(token, ACCESS_SECRET) as { userId: string; role: string }
}

export const verifyRefreshToken = (token: string) => {
    return jwt.verify(token, REFRESH_SECRET) as { userId: string }
}
