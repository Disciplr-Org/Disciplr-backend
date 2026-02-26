import swaggerJsdoc from 'swagger-jsdoc'
import { SwaggerDefinition } from 'swagger-jsdoc'

const swaggerDefinition: SwaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Disciplr API',
    version: '1.0.0',
    description: 'API documentation for Disciplr backend - A financial discipline and vault management system',
    contact: {
      name: 'Disciplr Team',
      email: 'support@disciplr.com'
    }
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Development server'
    },
    {
      url: 'https://api.disciplr.com',
      description: 'Production server'
    }
  ],
  components: {
    schemas: {
      Vault: {
        type: 'object',
        required: ['creator', 'amount', 'endTimestamp', 'successDestination', 'failureDestination'],
        properties: {
          id: {
            type: 'string',
            description: 'Unique identifier for the vault',
            example: 'vault-1640592000000-abc1234'
          },
          creator: {
            type: 'string',
            description: 'Creator of the vault',
            example: 'user123'
          },
          amount: {
            type: 'string',
            description: 'Amount locked in the vault',
            example: '1000.00'
          },
          startTimestamp: {
            type: 'string',
            format: 'date-time',
            description: 'When the vault was created'
          },
          endTimestamp: {
            type: 'string',
            format: 'date-time',
            description: 'When the vault matures'
          },
          successDestination: {
            type: 'string',
            description: 'Destination address on successful completion',
            example: '0x1234567890123456789012345678901234567890'
          },
          failureDestination: {
            type: 'string',
            description: 'Destination address on failure',
            example: '0x0987654321098765432109876543210987654321'
          },
          status: {
            type: 'string',
            enum: ['active', 'completed', 'failed', 'cancelled'],
            description: 'Current status of the vault'
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
            description: 'Creation timestamp'
          }
        }
      },
      CreateVaultRequest: {
        type: 'object',
        required: ['creator', 'amount', 'endTimestamp', 'successDestination', 'failureDestination'],
        properties: {
          creator: {
            type: 'string',
            description: 'Creator of the vault',
            example: 'user123'
          },
          amount: {
            type: 'string',
            description: 'Amount to lock in the vault',
            example: '1000.00'
          },
          endTimestamp: {
            type: 'string',
            format: 'date-time',
            description: 'When the vault should mature'
          },
          successDestination: {
            type: 'string',
            description: 'Destination for successful completion'
          },
          failureDestination: {
            type: 'string',
            description: 'Destination for failed completion'
          }
        }
      },
      ApiKey: {
        type: 'object',
        required: ['label', 'scopes'],
        properties: {
          id: {
            type: 'string',
            description: 'Unique identifier for the API key'
          },
          label: {
            type: 'string',
            description: 'Human-readable label for the API key',
            example: 'Production API Key'
          },
          scopes: {
            type: 'array',
            items: {
              type: 'string'
            },
            description: 'Array of permission scopes',
            example: ['read:vaults', 'write:vaults']
          },
          orgId: {
            type: 'string',
            description: 'Organization ID (optional)',
            example: 'org123'
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
            description: 'When the API key was created'
          },
          lastUsedAt: {
            type: 'string',
            format: 'date-time',
            description: 'When the API key was last used'
          }
        }
      },
      CreateApiKeyRequest: {
        type: 'object',
        required: ['label', 'scopes'],
        properties: {
          label: {
            type: 'string',
            description: 'Human-readable label for the API key'
          },
          scopes: {
            type: 'array',
            items: {
              type: 'string'
            },
            description: 'Array of permission scopes'
          },
          orgId: {
            type: 'string',
            description: 'Organization ID (optional)'
          }
        }
      },
      AnalyticsMetric: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Unique identifier for the metric'
          },
          vaultId: {
            type: 'string',
            description: 'Associated vault ID'
          },
          metric: {
            type: 'string',
            description: 'Type of metric',
            example: 'daily_views'
          },
          value: {
            type: 'number',
            description: 'Metric value',
            example: 42
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            description: 'When the metric was recorded'
          },
          period: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description: 'Time period for the metric'
          }
        }
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            example: 'ok'
          },
          service: {
            type: 'string',
            example: 'disciplr-backend'
          },
          timestamp: {
            type: 'string',
            format: 'date-time'
          }
        }
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            description: 'Error message',
            example: 'Vault not found'
          }
        }
      },
      PaginatedResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: {
              type: 'object'
            },
            description: 'Array of results'
          },
          pagination: {
            type: 'object',
            properties: {
              page: {
                type: 'integer',
                description: 'Current page number'
              },
              limit: {
                type: 'integer',
                description: 'Items per page'
              },
              total: {
                type: 'integer',
                description: 'Total number of items'
              },
              totalPages: {
                type: 'integer',
                description: 'Total number of pages'
              }
            }
          }
        }
      }
    },
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key'
      }
    }
  },
  security: [
    {
      bearerAuth: []
    },
    {
      apiKeyAuth: []
    }
  ]
}

const swaggerOptions = {
  definition: swaggerDefinition,
  apis: [
    './src/routes/*.ts',
    './src/app.ts'
  ]
}

export const swaggerSpec = swaggerJsdoc(swaggerOptions)
