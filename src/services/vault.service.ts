import { Vault, CreateVaultDTO, VaultStatus } from '../types/vault.js';
import { pool, db } from '../db/index.js';

export interface TimelineItem {
  timestamp: string;
  data: Record<string, unknown>;
}

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

  static async getVaultTimeline(id: string): Promise<TimelineItem[]> {
    const [auditLogs, transactions] = await Promise.all([
      db('audit_logs')
        .where({ target_type: 'vault', target_id: id })
        .select('action', 'created_at', 'actor_user_id', 'metadata'),
      db('transactions')
        .where({ vault_id: id })
        .select('type', 'stellar_timestamp', 'tx_hash', 'amount', 'asset_code', 'from_account', 'to_account'),
    ]);

    const auditItems: TimelineItem[] = auditLogs.map((log) => ({
      timestamp: new Date(log.created_at).toISOString(),
      data: {
        action: log.action,
        actor_user_id: log.actor_user_id,
        ...(log.metadata && typeof log.metadata === 'object' ? (log.metadata as Record<string, unknown>) : {}),
      },
    }));

    const txItems: TimelineItem[] = transactions.map((tx) => ({
      timestamp: new Date(tx.stellar_timestamp).toISOString(),
      data: {
        type: tx.type,
        tx_hash: tx.tx_hash,
        amount: tx.amount,
        asset_code: tx.asset_code,
        from_account: tx.from_account,
        to_account: tx.to_account,
      },
    }));

    return [...auditItems, ...txItems].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }
}
