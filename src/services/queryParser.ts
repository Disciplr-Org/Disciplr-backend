import { Knex } from 'knex'

const PROTECTED_QUERY_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObject(item))
  }

  if (!isPlainObject(value)) {
    return value
  }

  const sanitized: Record<string, unknown> = Object.create(null)

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase()
    if (PROTECTED_QUERY_KEYS.has(normalizedKey)) {
      continue
    }

    sanitized[key] = sanitizeObject(nestedValue)
  }

  return sanitized
}

function isValidField(column: string, allowedColumns: string[]): boolean {
  return typeof column === 'string' && allowedColumns.includes(column)
}

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
 * from untrusted user input. It prevents SQL injection and prototype pollution by 
 * sanitizing input, whitelisting column names, and using Knex's parameter binding.
 */
export class QueryParser {
  private allowedColumns: string[];
  private defaultLimit: number;
  private maxLimit: number;
  private logger?: QueryParserConfig['logger'];
  private metricsHook?: QueryParserConfig['metricsHook'];

  constructor(config: QueryParserConfig) {
    this.allowedColumns = config.allowedColumns;
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
    
    // 0. Sanitize the entire query object to prevent prototype pollution
    const safeQuery = sanitizeObject(query) as Record<string, any>;
    
    // 1. Parse filters
    if (safeQuery?.filter && typeof safeQuery.filter === 'object') {
      for (const [column, filterValue] of Object.entries(safeQuery.filter)) {
        if (!isValidField(column, this.allowedColumns)) {
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
    let limit = parseInt(safeQuery?.limit as string, 10) || this.defaultLimit;
    if (limit > this.maxLimit) limit = this.maxLimit;
    if (limit < 0) limit = this.defaultLimit;
    const offset = Math.max(0, parseInt(safeQuery?.offset as string, 10) || 0);

    // 3. Parse Sorting
    const sorts: SortCondition[] = [];
    const sortInputs = Array.isArray(safeQuery?.sort) ? safeQuery.sort : [safeQuery?.sort].filter(Boolean);

    for (const sortInput of sortInputs) {
      if (typeof sortInput !== 'string') continue;
      
      const [col, direction] = sortInput.split(':');
      if (isValidField(col, this.allowedColumns)) {
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