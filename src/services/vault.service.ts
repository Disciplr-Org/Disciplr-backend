import { prisma } from '../lib/prisma.js'
import { VaultStatus, UserRole } from '../types/domain.js'

export interface VaultFilters {
    status?: VaultStatus
    minAmount?: string
    maxAmount?: string
    startDate?: string
    endDate?: string
}

export interface PaginationParams {
    page?: number
    limit?: number
}

export class VaultService {
    static async listVaults(filters: VaultFilters, pagination: PaginationParams, userId: string, role: UserRole) {
        const page = pagination.page || 1
        const limit = pagination.limit || 10
        const skip = (page - 1) * limit

        const where: any = {}

        // Access control: Users see only their own, Admins see all
        if (role !== UserRole.ADMIN) {
            where.creatorId = userId
        }

        if (filters.status) {
            where.status = filters.status
        }

        if (filters.minAmount || filters.maxAmount) {
            where.amount = {}
            if (filters.minAmount) where.amount.gte = filters.minAmount
            if (filters.maxAmount) where.amount.lte = filters.maxAmount
        }

        if (filters.startDate || filters.endDate) {
            where.createdAt = {}
            if (filters.startDate) where.createdAt.gte = new Date(filters.startDate)
            if (filters.endDate) where.createdAt.lte = new Date(filters.endDate)
        }

        const [vaults, total] = await Promise.all([
            prisma.vault.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
            }),
            prisma.vault.count({ where }),
        ])

        return {
            vaults,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        }
    }

    static async getVaultDetails(id: string, userId: string, role: UserRole) {
        const vault = await prisma.vault.findUnique({
            where: { id },
            include: {
                creator: {
                    select: { id: true, email: true },
                },
            },
        })

        if (!vault) {
            throw new Error('Vault not found')
        }

        // Access control
        if (role !== UserRole.ADMIN && vault.creatorId !== userId) {
            throw new Error('Forbidden: You do not have access to this vault')
        }

        return vault
    }
}
