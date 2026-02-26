export type ValidationAction = 'validated' | 'failed' | 'cancelled' | 'extended';

export interface ValidationEvent {
    id: string;
    vault_id: string;
    milestone_id: string | null;
    validator_user_id: string;
    action: ValidationAction;
    metadata?: Record<string, any> | null;
    tx_hash?: string | null;
    created_at?: Date | string;
}

export interface CreateValidationEventDto {
    id: string;
    vault_id: string;
    milestone_id?: string | null;
    validator_user_id: string;
    action: ValidationAction;
    metadata?: Record<string, any> | null;
    tx_hash?: string | null;
}
