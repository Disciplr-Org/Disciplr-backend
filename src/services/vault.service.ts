import { Pool } from 'pg';
import { Vault, CreateVaultDTO, VaultStatus } from '../types/vault';

// Assuming you have a configured pg pool exported from your db setup
import pool from '../db/index'; 

export class VaultService {
  /**
   * Creates a new vault record in the database.
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
      const result = await pool.query(query, values);
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
      const result = await pool.query(query, [id]);
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
      const result = await pool.query(query, [creatorAddress]);
      return result.rows;
    } catch (error) {
      console.error(`Error fetching vaults for user ${creatorAddress}:`, error);
      throw new Error('Database error during fetch');
    }
  }

  /**
   * Updates the status of an existing vault.
   */
  static async updateVaultStatus(id: string, status: VaultStatus): Promise<Vault | null> {
    const query = `
      UPDATE vaults 
      SET status = $1, updated_at = NOW() 
      WHERE id = $2 
      RETURNING *;
    `;
    
    try {
      const result = await pool.query(query, [status, id]);
      return result.rows.length ? result.rows[0] : null;
    } catch (error) {
      console.error(`Error updating vault status for id ${id}:`, error);
      throw new Error('Database error during status update');
    }
  }
}