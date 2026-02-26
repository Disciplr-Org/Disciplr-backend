import { prisma } from '../lib/prisma.js'
import { hashPassword, comparePassword, generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../lib/auth-utils.js'
import { RegisterInput, LoginInput } from '../lib/validation.js'
import { UserRole } from '@prisma/client'

export class AuthService {
    static async register(input: RegisterInput) {
        const existingUser = await prisma.user.findUnique({ where: { email: input.email } })
        if (existingUser) {
            throw new Error('User already exists')
        }

        const hashedPassword = await hashPassword(input.password)
        const user = await prisma.user.create({
            data: {
                email: input.email,
                passwordHash: hashedPassword,
                role: input.role || UserRole.USER,
            },
        })

        return { id: user.id, email: user.email, role: user.role }
    }

    static async login(input: LoginInput) {
        const user = await prisma.user.findUnique({ where: { email: input.email } })
        if (!user) {
            throw new Error('Invalid credentials')
        }

        const isValid = await comparePassword(input.password, user.passwordHash)
        if (!isValid) {
            throw new Error('Invalid credentials')
        }

        await prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
        })

        const accessToken = generateAccessToken({ userId: user.id, role: user.role })
        const refreshTokenValue = generateRefreshToken({ userId: user.id })

        // Store refresh token
        await prisma.refreshToken.create({
            data: {
                token: refreshTokenValue,
                userId: user.id,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            },
        })

        return {
            user: { id: user.id, email: user.email, role: user.role },
            accessToken,
            refreshToken: refreshTokenValue,
        }
    }

    static async refresh(token: string) {
        try {
            const payload = verifyRefreshToken(token)
            const storedToken = await prisma.refreshToken.findUnique({
                where: { token },
                include: { user: true },
            })

            if (!storedToken || storedToken.revokedAt || storedToken.expiresAt < new Date()) {
                throw new Error('Invalid or expired refresh token')
            }

            // Revoke old token and issue new ones (Rotation strategy)
            await prisma.refreshToken.update({
                where: { id: storedToken.id },
                data: { revokedAt: new Date() },
            })

            const newAccessToken = generateAccessToken({ userId: storedToken.user.id, role: storedToken.user.role })
            const newRefreshTokenValue = generateRefreshToken({ userId: storedToken.user.id })

            await prisma.refreshToken.create({
                data: {
                    token: newRefreshTokenValue,
                    userId: storedToken.user.id,
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                },
            })

            return {
                accessToken: newAccessToken,
                refreshToken: newRefreshTokenValue,
            }
        } catch (error) {
            throw new Error('Invalid refresh token')
        }
    }

    static async logout(token: string) {
        await prisma.refreshToken.updateMany({
            where: { token },
            data: { revokedAt: new Date() },
        })
    }
}
