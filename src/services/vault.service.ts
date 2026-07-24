import { Vault, CreateVaultDTO, VaultStatus } from '../types/vault.js';
import { pool } from '../db/index.js';

export class VaultService {
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
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error('Error creating vault:', error);
      throw new Error('Database error during vault creation');
    }
  }

  static async getVaultById(id: string): Promise<Vault | null> {
    try {
      const result = await pool.query('SELECT * FROM vaults WHERE id = $1', [id]);
      return result.rows[0] ?? null;
    } catch {
      return null;
    }
  }

  static async updateVaultStatus(id: string, status: VaultStatus | string): Promise<void> {
    try {
      await pool.query('UPDATE vaults SET status = $1 WHERE id = $2', [status, id]);
    } catch (error) {
      console.error('Error updating vault status:', error);
    }
  }

  static async getVaultsByUser(address: string): Promise<Vault[]> {
    try {
      const result = await pool.query(
        'SELECT * FROM vaults WHERE creator_address = $1',
        [address]
      );
      return result.rows;
    } catch {
      return [];
    }
  }
}
