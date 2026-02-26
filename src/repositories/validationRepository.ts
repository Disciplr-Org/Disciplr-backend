import { Knex } from 'knex';
import { db } from '../db/connection.js';
import { CreateValidationEventDto, ValidationEvent } from '../types/validation.js';

export class ValidationRepository {
    private readonly tableName = 'validations';
    private readonly knex: Knex;

    constructor(knexInstance: Knex = db) {
        this.knex = knexInstance;
    }

    /**
     * Adds a new validation record to the database.
     */
    async addValidation(data: CreateValidationEventDto): Promise<ValidationEvent> {
        const [result] = await this.knex(this.tableName)
            .insert({
                ...data,
                metadata: data.metadata ? JSON.stringify(data.metadata) : null,
            })
            .returning('*');
        return result;
    }

    /**
     * Queries validation records by vault.
     */
    async getValidationsByVault(vaultId: string): Promise<ValidationEvent[]> {
        return this.knex(this.tableName).where({ vault_id: vaultId }).orderBy('created_at', 'desc');
    }

    /**
     * Queries validation records by milestone.
     */
    async getValidationsByMilestone(milestoneId: string): Promise<ValidationEvent[]> {
        return this.knex(this.tableName).where({ milestone_id: milestoneId }).orderBy('created_at', 'desc');
    }
}
