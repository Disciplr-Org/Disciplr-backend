import { Knex } from 'knex';

/**
 * Supported operators for filtering.
 */
export type Operator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'nin';

const OPERATOR_MAP: Record<Operator, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
  in: 'IN',
  nin: 'NOT IN',
};

export interface QueryCondition {
  column: string;
  operator: string;
  value: any;
}

export interface SortCondition {
  column: string;
  order: 'asc' | 'desc';
}

export interface ParsedQuery {
  conditions: QueryCondition[];
  limit: number;
  offset: number;
  sorts: SortCondition[];
}

export interface QueryParserConfig {
  /** List of columns that are safe to filter or sort by */
  allowedColumns: string[];
  /** Default number of items to return if limit is not specified */
  defaultLimit?: number;
  /** Maximum allowed limit to prevent resource exhaustion */
  maxLimit?: number;
  /** Optional logger for tracking violations */
  logger?: {
    warn: (message: string, context?: any) => void;
  };
  /** Optional metrics hook for observability */
  metricsHook?: (event: { event: string; column?: string; operator?: string }) => void;
}

/**
 * QueryParser handles the safe parsing of dynamic query filters, pagination, and sorting
 * from untrusted user input. It prevents SQL injection by whitelisting column names 
 * and using Knex's parameter binding for values.
 */
export class QueryParser {
  private allowedColumns: Set<string>;
  private defaultLimit: number;
  private maxLimit: number;
  private logger?: QueryParserConfig['logger'];
  private metricsHook?: QueryParserConfig['metricsHook'];

  constructor(config: QueryParserConfig) {
    this.allowedColumns = new Set(config.allowedColumns);
    this.defaultLimit = config.defaultLimit ?? 20;
    this.maxLimit = config.maxLimit ?? 100;
    this.logger = config.logger;
    this.metricsHook = config.metricsHook;
  }

  /**
   * Parses an Express query object (e.g., req.query) into a structured ParsedQuery.
   */
  parse(query: any): ParsedQuery {
    const conditions: QueryCondition[] = [];
    
    // 1. Parse filters
    if (query?.filter && typeof query.filter === 'object') {
      for (const [column, filterValue] of Object.entries(query.filter)) {
        if (!this.allowedColumns.has(column)) {
          this.logger?.warn('QueryParser: Restricted column access attempted', { column });
          this.metricsHook?.({ event: 'restricted_column_access', column });
          continue;
        }

        if (typeof filterValue === 'object' && filterValue !== null) {
          for (const [op, val] of Object.entries(filterValue)) {
            if (this.isOperator(op)) {
              conditions.push({
                column,
                operator: OPERATOR_MAP[op],
                value: this.sanitizeValue(val)
              });
            } else {
              this.logger?.warn('QueryParser: Invalid operator attempted', { column, op });
              this.metricsHook?.({ event: 'invalid_operator_attempt', column, operator: op });
            }
          }
        } else {
          conditions.push({
            column,
            operator: '=',
            value: this.sanitizeValue(filterValue)
          });
        }
      }
    }

    // 2. Parse Pagination
    let limit = parseInt(query?.limit as string, 10) || this.defaultLimit;
    if (limit > this.maxLimit) limit = this.maxLimit;
    if (limit < 0) limit = this.defaultLimit;
    const offset = Math.max(0, parseInt(query?.offset as string, 10) || 0);

    // 3. Parse Sorting
    const sorts: SortCondition[] = [];
    const sortInputs = Array.isArray(query?.sort) ? query.sort : [query?.sort].filter(Boolean);

    for (const sortInput of sortInputs) {
      if (typeof sortInput !== 'string') continue;
      
      const [col, direction] = sortInput.split(':');
      if (this.allowedColumns.has(col)) {
        sorts.push({
          column: col,
          order: direction?.toLowerCase() === 'desc' ? 'desc' : 'asc'
        });
      } else {
        this.logger?.warn('QueryParser: Restricted column sort attempted', { column: col });
        this.metricsHook?.({ event: 'restricted_sort_access', column: col });
      }
    }

    return { conditions, limit, offset, sorts };
  }

  /**
   * Helper to apply the parsed query directly to a Knex query builder.
   */
  applyToKnex(builder: Knex.QueryBuilder, parsed: ParsedQuery): Knex.QueryBuilder {
    for (const { column, operator, value } of parsed.conditions) {
      if (operator === 'IN') {
        builder.whereIn(column, Array.isArray(value) ? value : [value]);
      } else if (operator === 'NOT IN') {
        builder.whereNotIn(column, Array.isArray(value) ? value : [value]);
      } else {
        builder.where(column, operator, value);
      }
    }

    for (const sort of parsed.sorts) {
      builder.orderBy(sort.column, sort.order);
    }

    builder.limit(parsed.limit).offset(parsed.offset);

    return builder;
  }

  private isOperator(op: string): op is Operator {
    return Object.prototype.hasOwnProperty.call(OPERATOR_MAP, op);
  }

  private sanitizeValue(val: any): any {
    if (Array.isArray(val)) {
      return val.map(v => (typeof v === 'object' ? null : v));
    }
    return (typeof val === 'object' && val !== null) || typeof val === 'undefined' ? null : val;
  }
}