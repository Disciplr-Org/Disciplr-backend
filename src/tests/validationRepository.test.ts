import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ValidationRepository } from '../repositories/validationRepository.js';
import { Knex } from 'knex';

describe('ValidationRepository', () => {
    let repository: ValidationRepository;
    let mKnex: any;

    beforeEach(() => {
        // Create a fluent mock interface for Knex query builder
        mKnex = {
            insert: jest.fn().mockReturnThis(),
            returning: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            // The terminal method must resolve the promise with data
            then: jest.fn().mockImplementation(function (callback: any) {
                return Promise.resolve([]).then(callback);
            })
        };

        // Create a fake knex function that returns the query builder mock
        const fakeKnex = jest.fn(() => mKnex) as unknown as Knex;

        // Inject the mocked knex instance into the repository
        repository = new ValidationRepository(fakeKnex);
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('addValidation', () => {
        it('should add a validation record', async () => {
            const newRecord = {
                id: 'val_123',
                vault_id: 'vault_123',
                milestone_id: 'milestone_123',
                validator_user_id: 'user_1',
                action: 'validated' as const,
                metadata: { reason: 'looks good' },
            };

            const returnedRecord = { ...newRecord, created_at: new Date() };

            // For insert/returning, the "returning" method isn't terminal, the await triggers `.then()`
            // We want then() to resolve with our mock data
            mKnex.then.mockImplementation((callback: any) => {
                return Promise.resolve([returnedRecord]).then(callback);
            });

            const result = await repository.addValidation(newRecord);

            // Access the original fakeKnex to verify table selection
            const fakeKnex = repository['knex'] as any;
            expect(fakeKnex).toHaveBeenCalledWith('validations');
            expect(mKnex.insert).toHaveBeenCalledWith(expect.objectContaining({
                id: 'val_123',
                vault_id: 'vault_123',
                metadata: JSON.stringify({ reason: 'looks good' })
            }));
            expect(mKnex.returning).toHaveBeenCalledWith('*');
            expect(result).toEqual(returnedRecord);
        });
    });

    describe('getValidationsByVault', () => {
        it('should query validations by vault', async () => {
            const mockRecords = [{ id: 'val_1', vault_id: 'vault_123' }];

            // OrderBy triggers the promise resolution
            mKnex.then.mockImplementation((callback: any) => {
                return Promise.resolve(mockRecords).then(callback);
            });

            const result = await repository.getValidationsByVault('vault_123');

            const fakeKnex = repository['knex'] as any;
            expect(fakeKnex).toHaveBeenCalledWith('validations');
            expect(mKnex.where).toHaveBeenCalledWith({ vault_id: 'vault_123' });
            expect(mKnex.orderBy).toHaveBeenCalledWith('created_at', 'desc');
            expect(result).toEqual(mockRecords);
        });
    });

    describe('getValidationsByMilestone', () => {
        it('should query validations by milestone', async () => {
            const mockRecords = [{ id: 'val_2', milestone_id: 'mile_123' }];

            mKnex.then.mockImplementation((callback: any) => {
                return Promise.resolve(mockRecords).then(callback);
            });

            const result = await repository.getValidationsByMilestone('mile_123');

            const fakeKnex = repository['knex'] as any;
            expect(fakeKnex).toHaveBeenCalledWith('validations');
            expect(mKnex.where).toHaveBeenCalledWith({ milestone_id: 'mile_123' });
            expect(mKnex.orderBy).toHaveBeenCalledWith('created_at', 'desc');
            expect(result).toEqual(mockRecords);
        });
    });
});
