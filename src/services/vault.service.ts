import { Pool } from 'pg'
import { Vault, CreateVaultDTO, VaultStatus as TypeVaultStatus } from '../types/vault.js'
import pool from '../db/index.js'
import { prisma } from '../lib/prisma.js'
import { VaultStatus, UserRole } from '@prisma/client'

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
  /**
   * Creates a new vault record in the database using raw SQL (for Soroban integration).
   */
  static async createVault(data: CreateVaultDTO): Promise<Vault> {
    const query = `
      INSERT INTO vaults (
        contract_id, creator_address, amount, milestone_hash, 
        verifier_address, success_destination, failure_destination, deadline
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
      RETURNING *;
    `;
    
    const values = [
      data.contractId, data.creatorAddress, data.amount, data.milestoneHash,
      data.verifierAddress, data.successDestination, data.failureDestination, data.deadline
    ];

    try {
      const result = await (pool as any).query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error('Error creating vault:', error);
      throw new Error('Database error during vault creation');
    }
  }

  /**
   * Retrieves a vault by its internal UUID.
   */
  static async getVaultById(id: string): Promise<Vault | null> {
    const query = `SELECT * FROM vaults WHERE id = $1;`;
    
    try {
      const result = await (pool as any).query(query, [id]);
      return result.rows.length ? result.rows[0] : null;
    } catch (error) {
      console.error(`Error fetching vault with id ${id}:`, error);
      throw new Error('Database error during fetch');
    }
  }

  /**
   * Retrieves all vaults created by a specific Stellar address.
   */
  static async getVaultsByUser(creatorAddress: string): Promise<Vault[]> {
    const query = `SELECT * FROM vaults WHERE creator_address = $1 ORDER BY created_at DESC;`;
    
    try {
      const result = await (pool as any).query(query, [creatorAddress]);
      return result.rows;
    } catch (error) {
      console.error(`Error fetching vaults for user ${creatorAddress}:`, error);
      throw new Error('Database error during fetch');
    }
  }

  /**
   * Updates the status of an existing vault.
   */
  static async updateVaultStatus(id: string, status: TypeVaultStatus): Promise<Vault | null> {
    const query = `
      UPDATE vaults 
      SET status = $1, updated_at = NOW() 
      WHERE id = $2 
      RETURNING *;
    `;
    
    try {
      const result = await (pool as any).query(query, [status, id]);
      return result.rows.length ? result.rows[0] : null;
    } catch (error) {
      console.error(`Error updating vault status for id ${id}:`, error);
      throw new Error('Database error during status update');
    }
  }

  /**
   * List vaults using Prisma (for the regular API).
   */
  static async listVaults(filters: VaultFilters, pagination: PaginationParams, userId: string, role: UserRole) {
        const page = pagination.page || 1
        const limit = pagination.limit || 10
        const skip = (page - 1) * limit

        const where: any = {}

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

        if (role !== UserRole.ADMIN && vault.creatorId !== userId) {
            throw new Error('Forbidden: You do not have access to this vault')
        }

        return vault
    }
}
