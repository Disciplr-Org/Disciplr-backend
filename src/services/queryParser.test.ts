import { QueryParser } from './queryParser';
import { Knex } from 'knex';

describe('QueryParser', () => {
  const allowedColumns = ['id', 'status', 'amount', 'created_at'];
  const mockLogger = { warn: jest.fn() };
  const mockMetrics = jest.fn();
  const parser = new QueryParser({ 
    allowedColumns, 
    maxLimit: 50, 
    defaultLimit: 10,
    logger: mockLogger,
    metricsHook: mockMetrics
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should parse equality filters', () => {
    const query = { filter: { status: 'active' } };
    const result = parser.parse(query);
    expect(result.conditions).toEqual([{ column: 'status', operator: '=', value: 'active' }]);
  });

  test('should parse complex operators', () => {
    const query = { filter: { amount: { gt: '100', lt: '500' } } };
    const result = parser.parse(query);
    expect(result.conditions).toEqual(expect.arrayContaining([
      { column: 'amount', operator: '>', value: '100' },
      { column: 'amount', operator: '<', value: '500' }
    ]));
  });

  test('should ignore restricted columns and log violation without PII', () => {
    const query = { filter: { password_hash: '123456', status: 'active' } };
    const result = parser.parse(query);
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0].column).toBe('status');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      { column: 'password_hash' }
    );
    // Verify value '123456' is not in the logs
    expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ value: '123456' }));
  });

  test('should handle pagination limits and offsets', () => {
    const query = { limit: '100', offset: '25' };
    const result = parser.parse(query);
    expect(result.limit).toBe(50); // Capped at maxLimit
    expect(result.offset).toBe(25);
  });

  test('should parse valid single sorting', () => {
    const query = { sort: 'created_at:desc' };
    const result = parser.parse(query);
    expect(result.sorts).toEqual([{ column: 'created_at', order: 'desc' }]);
  });

  test('should parse multi-column sorting', () => {
    const query = { sort: ['status:asc', 'created_at:desc'] };
    const result = parser.parse(query);
    expect(result.sorts).toEqual([
      { column: 'status', order: 'asc' },
      { column: 'created_at', order: 'desc' }
    ]);
  });

  test('should handle malicious input strings in filter values safely', () => {
    const sqlInjection = "'; DROP TABLE users; --";
    const query = { filter: { status: sqlInjection } };
    const result = parser.parse(query);
    expect(result.conditions[0].value).toBe(sqlInjection);
    // Result is safe because Knex uses parameterized queries for these values.
  });

  test('should sanitize nested objects to null to prevent crash', () => {
    const query = { filter: { status: { eq: { some: 'object' } } } };
    const result = parser.parse(query);
    expect(result.conditions[0].value).toBeNull();
  });

  test('should handle IN operator with arrays', () => {
    const query = { filter: { status: { in: ['active', 'pending'] } } };
    const result = parser.parse(query);
    expect(result.conditions).toEqual([
      { column: 'status', operator: 'IN', value: ['active', 'pending'] }
    ]);
  });

  describe('applyToKnex', () => {
    const mockBuilder = {
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
    } as unknown as Knex.QueryBuilder;

    test('should apply all parsed components to knex builder', () => {
      const parsed = {
        conditions: [
          { column: 'status', operator: '=', value: 'active' },
          { column: 'amount', operator: 'IN', value: [10, 20] }
        ],
        limit: 10,
        offset: 0,
        sorts: [{ column: 'created_at', order: 'desc' as const }]
      };

      parser.applyToKnex(mockBuilder, parsed);

      expect(mockBuilder.where).toHaveBeenCalledWith('status', '=', 'active');
      expect(mockBuilder.whereIn).toHaveBeenCalledWith('amount', [10, 20]);
      expect(mockBuilder.orderBy).toHaveBeenCalledWith('created_at', 'desc');
      expect(mockBuilder.limit).toHaveBeenCalledWith(10);
    });
  });
});