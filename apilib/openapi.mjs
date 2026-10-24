const err = {
  description: 'Error',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      example: { error: 'Validation failed', details: ['amount must be a positive number'] },
    },
  },
}

const unavailable = {
  description: 'Database unavailable; retry later',
  headers: { 'Retry-After': { description: 'Seconds before retrying', schema: { type: 'integer', example: 1 } } },
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { error: 'Database unavailable' } } },
}

const onchainResult = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/OnchainResult' } } },
})

export const OPENAPI = {
  openapi: '3.0.3',
  info: {
    title: 'Disciplr API',
    version: '0.1.0',
    description: 'Commitment vaults on Stellar: lock funds against milestones; a verifier validates progress; funds release on success or redirect on failure.',
  },
  servers: [{ url: '/api' }],
  paths: {
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Process liveness (independent of the database)',
        responses: {
          200: {
            description: 'Process is up',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Health' },
                example: {
                  status: 'ok',
                  service: 'disciplr-api',
                  time: '2026-04-20T12:00:00.000Z',
                },
              },
            },
          },
        },
      },
    },
    '/ready': {
      get: {
        operationId: 'getReady',
        summary: 'Readiness: active store and latest applied migration; database probe bounded to 2 seconds',
        responses: {
          200: {
            description: 'Ready',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Ready' },
                example: { status: 'ok', store: 'postgres', migration: '20261019000000_add_onchain_status.cjs' },
              },
            },
          },
          503: unavailable,
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApiSpec',
        summary: 'OpenAPI 3.0 specification document',
        responses: {
          200: {
            description: 'OpenAPI specification JSON',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
    '/cron/expire-vaults': {
      get: {
        operationId: 'expireOverdueVaults',
        summary: 'Protected cron endpoint to fail overdue active vaults and pending milestones',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' }, description: 'Batch size limit' },
          { name: 'now', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Simulated current timestamp' },
        ],
        responses: {
          200: {
            description: 'Batch expiry execution summary',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CronExpiryResult' },
                example: { processed: 2, remaining: 0 },
              },
            },
          },
          401: err,
          503: err,
        },
      },
    },
    '/vaults': {
      get: {
        operationId: 'listVaults',
        summary: 'List vaults with cursor pagination',
        parameters: [
          { name: 'creator', in: 'query', schema: { $ref: '#/components/schemas/StellarAddress' }, description: 'Filter by creator Stellar address' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'completed', 'failed'] }, description: 'Filter by vault status' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, description: 'Page size (1-100, default 25)' },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque pagination cursor from previous response' },
        ],
        responses: {
          200: {
            description: 'List of commitment vaults',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VaultList' },
                example: {
                  data: [
                    {
                      id: 'vault-demo-001',
                      name: 'Launch the MVP',
                      creator: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                      amount: '2500',
                      status: 'active',
                      startDate: '2026-03-31T12:00:00.000Z',
                      endDate: '2026-05-30T12:00:00.000Z',
                      verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
                      successDestination: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                      failureDestination: 'GCAJ2QOEXTR7AB5PJXSAO2HEISE2VEIUIX7CP3F3MOYVX7GMADB7KX22',
                      createdAt: '2026-03-31T12:00:00.000Z',
                      updatedAt: '2026-03-31T12:00:00.000Z',
                      milestones: [
                        {
                          id: 'vault-demo-001-m1',
                          title: 'Ship MVP',
                          amount: '1000',
                          dueDate: '2026-04-30T12:00:00.000Z',
                          status: 'completed',
                        },
                      ],
                    },
                  ],
                  count: 1,
                },
              },
            },
          },
          503: unavailable,
        },
      },
      post: {
        operationId: 'createVault',
        summary: 'Create a vault',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateVaultRequest' },
              example: {
                name: 'Launch the MVP',
                creator: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
                amount: 2500,
                startDate: '2026-04-01T00:00:00.000Z',
                endDate: '2026-05-01T00:00:00.000Z',
                successDestination: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                failureDestination: 'GCAJ2QOEXTR7AB5PJXSAO2HEISE2VEIUIX7CP3F3MOYVX7GMADB7KX22',
                milestones: [
                  {
                    title: 'Ship MVP',
                    amount: 1000,
                    dueDate: '2026-04-15T00:00:00.000Z',
                  },
                  {
                    title: 'Public Launch',
                    amount: 1500,
                    dueDate: '2026-05-01T00:00:00.000Z',
                  },
                ],
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Vault created successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VaultEnvelope' },
                example: {
                  data: {
                    id: 'vault-a1b2c3d4e5f6',
                    name: 'Launch the MVP',
                    creator: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                    amount: '2500',
                    status: 'active',
                    startDate: '2026-04-01T00:00:00.000Z',
                    endDate: '2026-05-01T00:00:00.000Z',
                    verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
                    successDestination: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                    failureDestination: 'GCAJ2QOEXTR7AB5PJXSAO2HEISE2VEIUIX7CP3F3MOYVX7GMADB7KX22',
                    createdAt: '2026-04-01T00:00:00.000Z',
                    updatedAt: '2026-04-01T00:00:00.000Z',
                    milestones: [
                      {
                        id: 'vault-a1b2c3d4e5f6-m1',
                        title: 'Ship MVP',
                        amount: '1000',
                        dueDate: '2026-04-15T00:00:00.000Z',
                        status: 'pending',
                      },
                    ],
                  },
                },
              },
            },
          },
          400: err,
          503: unavailable,
        },
      },
    },
    '/vaults/{id}': {
      get: {
        operationId: 'getVaultById',
        summary: 'Get a vault with its activity',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Unique vault ID' },
        ],
        responses: {
          200: {
            description: 'Vault detail including activity history',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VaultWithActivityEnvelope' },
                example: {
                  data: {
                    id: 'vault-demo-001',
                    name: 'Launch the MVP',
                    creator: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                    amount: '2500',
                    status: 'active',
                    startDate: '2026-03-31T12:00:00.000Z',
                    endDate: '2026-05-30T12:00:00.000Z',
                    verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
                    successDestination: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                    failureDestination: 'GCAJ2QOEXTR7AB5PJXSAO2HEISE2VEIUIX7CP3F3MOYVX7GMADB7KX22',
                    createdAt: '2026-03-31T12:00:00.000Z',
                    updatedAt: '2026-03-31T12:00:00.000Z',
                    milestones: [
                      {
                        id: 'vault-demo-001-m1',
                        title: 'Ship MVP',
                        amount: '1000',
                        dueDate: '2026-04-30T12:00:00.000Z',
                        status: 'completed',
                      },
                    ],
                    activity: [
                      {
                        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
                        type: 'create',
                        vaultId: 'vault-demo-001',
                        amount: '2500',
                        status: 'confirmed',
                        hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
                        memo: 'Vault created',
                        createdAt: '2026-03-31T12:00:00.000Z',
                      },
                    ],
                  },
                },
              },
            },
          },
          404: err,
          503: unavailable,
        },
      },
    },
    '/vaults/{id}/milestones/{mid}/validate': {
      post: {
        operationId: 'validateMilestone',
        summary: 'Verifier validates a milestone (body: {verifier})',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Unique vault ID' },
          { name: 'mid', in: 'path', required: true, schema: { type: 'string' }, description: 'Milestone ID' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VerifierActionRequest' },
              example: {
                verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Updated vault state after milestone validation',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VaultEnvelope' },
                example: {
                  data: {
                    id: 'vault-demo-001',
                    name: 'Launch the MVP',
                    creator: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                    amount: '2500',
                    status: 'active',
                    startDate: '2026-03-31T12:00:00.000Z',
                    endDate: '2026-05-30T12:00:00.000Z',
                    verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
                    successDestination: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                    failureDestination: 'GCAJ2QOEXTR7AB5PJXSAO2HEISE2VEIUIX7CP3F3MOYVX7GMADB7KX22',
                    createdAt: '2026-03-31T12:00:00.000Z',
                    updatedAt: '2026-04-01T12:00:00.000Z',
                    milestones: [
                      {
                        id: 'vault-demo-001-m1',
                        title: 'Ship MVP',
                        amount: '1000',
                        dueDate: '2026-04-30T12:00:00.000Z',
                        status: 'completed',
                      },
                    ],
                  },
                },
              },
            },
          },
          400: err,
          403: err,
          404: err,
          409: err,
          503: unavailable,
        },
      },
    },
    '/vaults/{id}/milestones/{mid}/evidence': {
      post: {
        operationId: 'submitMilestoneEvidence',
        summary: 'Creator submits evidence for a milestone: URL + SHA-256 hash + optional note',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Unique vault ID' },
          { name: 'mid', in: 'path', required: true, schema: { type: 'string' }, description: 'Milestone ID' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SubmitEvidenceRequest' },
              example: {
                submitter: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                url: 'https://example.com/proof.pdf',
                sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
                note: 'MVP deployed to production',
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Evidence submitted successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EvidenceEnvelope' },
                example: {
                  data: {
                    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                    url: 'https://example.com/proof.pdf',
                    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
                    note: 'MVP deployed to production',
                    submittedBy: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                    verified: false,
                    createdAt: '2026-04-15T12:00:00.000Z',
                  },
                },
              },
            },
          },
          400: err,
          403: err,
          404: err,
          409: err,
          503: unavailable,
        },
      },
    },
    '/vaults/{id}/fail': {
      post: {
        operationId: 'failVault',
        summary: 'Verifier fails a vault; funds redirect (body: {verifier})',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Unique vault ID' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VerifierActionRequest' },
              example: {
                verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Updated vault state after failure declaration',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VaultEnvelope' },
                example: {
                  data: {
                    id: 'vault-demo-001',
                    name: 'Launch the MVP',
                    creator: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                    amount: '2500',
                    status: 'failed',
                    startDate: '2026-03-31T12:00:00.000Z',
                    endDate: '2026-05-30T12:00:00.000Z',
                    verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
                    successDestination: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
                    failureDestination: 'GCAJ2QOEXTR7AB5PJXSAO2HEISE2VEIUIX7CP3F3MOYVX7GMADB7KX22',
                    createdAt: '2026-03-31T12:00:00.000Z',
                    updatedAt: '2026-04-01T12:00:00.000Z',
                    milestones: [
                      {
                        id: 'vault-demo-001-m1',
                        title: 'Ship MVP',
                        amount: '1000',
                        dueDate: '2026-04-30T12:00:00.000Z',
                        status: 'failed',
                      },
                    ],
                  },
                },
              },
            },
          },
          400: err,
          403: err,
          404: err,
          409: err,
          503: unavailable,
        },
      },
    },
    '/vaults/{id}/onchain/stake': {
      post: {
        operationId: 'buildOnchainStake',
        summary: 'Build the unsigned stake XDR for the creator to sign (requires SOROBAN_ENABLED=1 and a confirmed create_vault)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Unique vault ID' },
        ],
        responses: {
          200: onchainResult('Vault and {onChain: {xdr, networkPassphrase, operation}}'),
          400: err,
          404: err,
          409: err,
          503: unavailable,
        },
      },
    },
    '/vaults/{id}/onchain/submit': {
      post: {
        operationId: 'submitOnchainTransaction',
        summary: 'Submit the creator-signed create_vault or stake XDR; verified against the stored vault, relayed, and recorded with the real hash and ledger. Idempotent by tx hash. 202 = still pending, 422 = failed on-chain',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Unique vault ID' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signedXdr'],
                properties: { signedXdr: { type: 'string' }, networkPassphrase: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: onchainResult('Confirmed'),
          202: onchainResult('Pending'),
          400: err,
          404: err,
          409: err,
          422: onchainResult('Failed on-chain'),
          503: unavailable,
        },
      },
    },
    '/transactions': {
      get: {
        operationId: 'listTransactions',
        summary: 'Activity feed with cursor pagination',
        parameters: [
          { name: 'vaultId', in: 'query', schema: { type: 'string' }, description: 'Filter activity by vault ID' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, description: 'Page size (1-100, default 25)' },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque pagination cursor from previous response' },
        ],
        responses: {
          200: {
            description: 'Activity history list',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ActivityList' },
                example: {
                  data: [
                    {
                      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
                      type: 'create',
                      vaultId: 'vault-demo-001',
                      amount: '2500',
                      status: 'confirmed',
                      hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
                      memo: 'Vault created',
                      createdAt: '2026-03-31T12:00:00.000Z',
                    },
                  ],
                  count: 1,
                },
              },
            },
          },
          503: unavailable,
        },
      },
    },
    '/stats': {
      get: {
        operationId: 'getStats',
        summary: 'Aggregate statistics',
        parameters: [
          { name: 'creator', in: 'query', schema: { $ref: '#/components/schemas/StellarAddress' }, description: 'Filter stats by creator Stellar address' },
          { name: 'verifier', in: 'query', schema: { $ref: '#/components/schemas/StellarAddress' }, description: 'Filter stats by verifier Stellar address' },
        ],
        responses: {
          200: {
            description: 'Aggregate platform statistics',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/StatsEnvelope' },
                example: {
                  data: {
                    totalVaults: 3,
                    active: 1,
                    completed: 1,
                    failed: 1,
                    totalLocked: '2500',
                    totalReleased: '800',
                    totalRedirected: '1200',
                    successRate: 50,
                  },
                },
              },
            },
          },
          503: unavailable,
        },
      },
    },
  },
  components: {
    schemas: {
      StellarAddress: {
        type: 'string',
        pattern: '^G[A-Z2-7]{55}$',
        description: 'Stellar public key (56 characters starting with G)',
        example: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
      },
      Amount: {
        type: 'string',
        pattern: '^\\d+(\\.\\d{1,7})?$',
        description: 'Monetary amount represented as an exact 7-decimal numeric string',
        example: '1000',
      },
      Error: {
        type: 'object',
        required: ['error'],
        additionalProperties: true,
        properties: {
          error: {
            type: 'string',
            description: 'Error message',
            example: 'Vault not found',
          },
          details: {
            type: 'array',
            items: { type: 'string' },
            description: 'Detailed validation error messages',
            example: ['amount must be a positive number'],
          },
        },
      },
      Health: {
        type: 'object',
        required: ['status', 'service', 'time'],
        additionalProperties: false,
        properties: {
          status: { type: 'string', example: 'ok' },
          service: { type: 'string', example: 'disciplr-api' },
          time: { type: 'string', format: 'date-time', example: '2026-04-20T12:00:00.000Z' },
        },
      },
      Ready: {
        type: 'object',
        required: ['status', 'store', 'migration'],
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok'], example: 'ok' },
          store: { type: 'string', enum: ['postgres', 'memory'], example: 'postgres' },
          migration: { type: 'string', nullable: true, description: 'Latest applied Knex migration; null for memory or an unmigrated database' },
        },
      },
      Milestone: {
        type: 'object',
        required: ['id', 'title', 'amount', 'dueDate', 'status'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', example: 'vault-demo-001-m1' },
          title: { type: 'string', example: 'Ship MVP' },
          amount: { $ref: '#/components/schemas/Amount' },
          dueDate: { type: 'string', format: 'date-time', example: '2026-04-30T12:00:00.000Z' },
          status: { type: 'string', enum: ['pending', 'completed', 'failed'], example: 'pending' },
          evidence: {
            type: 'array',
            items: { $ref: '#/components/schemas/Evidence' },
            description: 'Evidence submissions for this milestone (max 10, most recent first)',
          },
          latestEvidenceHash: { type: 'string', nullable: true, example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', description: 'SHA-256 hash of the most recent evidence submission' },
        },
      },
      Evidence: {
        type: 'object',
        required: ['id', 'url', 'sha256', 'submittedBy', 'verified', 'createdAt'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
          url: { type: 'string', format: 'uri', example: 'https://example.com/proof.pdf' },
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$', example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
          note: { type: 'string', nullable: true, example: 'MVP deployed to production' },
          submittedBy: { $ref: '#/components/schemas/StellarAddress' },
          verified: { type: 'boolean', example: false },
          createdAt: { type: 'string', format: 'date-time', example: '2026-04-15T12:00:00.000Z' },
        },
      },
      Vault: {
        type: 'object',
        required: [
          'id',
          'name',
          'creator',
          'amount',
          'status',
          'startDate',
          'endDate',
          'verifier',
          'successDestination',
          'failureDestination',
          'createdAt',
          'updatedAt',
          'milestones',
        ],
        additionalProperties: false,
        properties: {
          id: { type: 'string', example: 'vault-demo-001' },
          name: { type: 'string', example: 'Launch the MVP' },
          creator: { $ref: '#/components/schemas/StellarAddress' },
          amount: { $ref: '#/components/schemas/Amount' },
          status: { type: 'string', enum: ['draft', 'active', 'completed', 'failed'], example: 'active' },
          onchainStatus: { type: 'string', nullable: true, description: 'On-chain progress when SOROBAN_ENABLED=1: pending_onchain, created or active; null for simulated vaults', example: null },
          startDate: { type: 'string', format: 'date-time', example: '2026-03-31T12:00:00.000Z' },
          endDate: { type: 'string', format: 'date-time', example: '2026-05-30T12:00:00.000Z' },
          verifier: { $ref: '#/components/schemas/StellarAddress' },
          successDestination: { $ref: '#/components/schemas/StellarAddress' },
          failureDestination: { $ref: '#/components/schemas/StellarAddress' },
          createdAt: { type: 'string', format: 'date-time', example: '2026-03-31T12:00:00.000Z' },
          updatedAt: { type: 'string', format: 'date-time', example: '2026-03-31T12:00:00.000Z' },
          milestones: {
            type: 'array',
            items: { $ref: '#/components/schemas/Milestone' },
          },
        },
      },
      Activity: {
        type: 'object',
        required: ['id', 'type', 'vaultId', 'amount', 'status', 'hash', 'memo', 'createdAt'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
          type: { type: 'string', enum: ['create', 'validate', 'release', 'redirect', 'stake', 'evidence'], example: 'create' },
          vaultId: { type: 'string', example: 'vault-demo-001' },
          amount: { $ref: '#/components/schemas/Amount' },
          status: { type: 'string', enum: ['pending', 'confirmed', 'failed', 'simulated'], example: 'confirmed' },
          ledger: { type: 'integer', nullable: true, description: 'Ledger the on-chain transaction landed in', example: 4242 },
          hash: { type: 'string', example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
          memo: { type: 'string', nullable: true, example: 'Vault created' },
          createdAt: { type: 'string', format: 'date-time', example: '2026-03-31T12:00:00.000Z' },
        },
      },
      VaultWithActivity: {
        type: 'object',
        required: [
          'id',
          'name',
          'creator',
          'amount',
          'status',
          'startDate',
          'endDate',
          'verifier',
          'successDestination',
          'failureDestination',
          'createdAt',
          'updatedAt',
          'milestones',
          'activity',
        ],
        additionalProperties: false,
        properties: {
          id: { type: 'string', example: 'vault-demo-001' },
          name: { type: 'string', example: 'Launch the MVP' },
          creator: { $ref: '#/components/schemas/StellarAddress' },
          amount: { $ref: '#/components/schemas/Amount' },
          status: { type: 'string', enum: ['draft', 'active', 'completed', 'failed'], example: 'active' },
          onchainStatus: { type: 'string', nullable: true, description: 'On-chain progress when SOROBAN_ENABLED=1: pending_onchain, created or active; null for simulated vaults', example: null },
          startDate: { type: 'string', format: 'date-time', example: '2026-03-31T12:00:00.000Z' },
          endDate: { type: 'string', format: 'date-time', example: '2026-05-30T12:00:00.000Z' },
          verifier: { $ref: '#/components/schemas/StellarAddress' },
          successDestination: { $ref: '#/components/schemas/StellarAddress' },
          failureDestination: { $ref: '#/components/schemas/StellarAddress' },
          createdAt: { type: 'string', format: 'date-time', example: '2026-03-31T12:00:00.000Z' },
          updatedAt: { type: 'string', format: 'date-time', example: '2026-03-31T12:00:00.000Z' },
          milestones: {
            type: 'array',
            items: { $ref: '#/components/schemas/Milestone' },
          },
          activity: {
            type: 'array',
            items: { $ref: '#/components/schemas/Activity' },
          },
        },
      },
      Stats: {
        type: 'object',
        required: [
          'totalVaults',
          'active',
          'completed',
          'failed',
          'totalLocked',
          'totalReleased',
          'totalRedirected',
          'successRate',
        ],
        additionalProperties: false,
        properties: {
          totalVaults: { type: 'integer', example: 3 },
          active: { type: 'integer', example: 1 },
          completed: { type: 'integer', example: 1 },
          failed: { type: 'integer', example: 1 },
          totalLocked: { $ref: '#/components/schemas/Amount', example: '2500' },
          totalReleased: { $ref: '#/components/schemas/Amount', example: '800' },
          totalRedirected: { $ref: '#/components/schemas/Amount', example: '1200' },
          successRate: { type: 'number', nullable: true, example: 50 },
        },
      },
      VaultEnvelope: {
        type: 'object',
        required: ['data'],
        additionalProperties: false,
        properties: {
          data: { $ref: '#/components/schemas/Vault' },
        },
      },
      VaultWithActivityEnvelope: {
        type: 'object',
        required: ['data'],
        additionalProperties: false,
        properties: {
          data: { $ref: '#/components/schemas/VaultWithActivity' },
        },
      },
      VaultList: {
        type: 'object',
        required: ['data', 'count', 'page'],
        additionalProperties: false,
        properties: {
          data: {
            type: 'array',
            items: { $ref: '#/components/schemas/Vault' },
          },
          count: { type: 'integer', example: 1, description: 'Number of items in this page' },
          page: { $ref: '#/components/schemas/PageInfo' },
        },
      },
      ActivityList: {
        type: 'object',
        required: ['data', 'count', 'page'],
        additionalProperties: false,
        properties: {
          data: {
            type: 'array',
            items: { $ref: '#/components/schemas/Activity' },
          },
          count: { type: 'integer', example: 1, description: 'Number of items in this page' },
          page: { $ref: '#/components/schemas/PageInfo' },
        },
      },
      PageInfo: {
        type: 'object',
        required: ['limit', 'nextCursor'],
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', example: 25, description: 'Page size limit' },
          nextCursor: { type: 'string', nullable: true, example: 'eyJjcmVhdGVkQXQiOiIyMDI2LTA0LTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6InZhdWx0LTAwMSJ9', description: 'Opaque cursor for the next page; null if this is the last page' },
        },
      },
      StatsEnvelope: {
        type: 'object',
        required: ['data'],
        additionalProperties: false,
        properties: {
          data: { $ref: '#/components/schemas/Stats' },
        },
      },
      CronExpiryResult: {
        type: 'object',
        required: ['processed', 'remaining'],
        additionalProperties: false,
        properties: {
          processed: { type: 'integer', example: 2 },
          remaining: { type: 'integer', example: 0 },
        },
      },
      CreateMilestoneRequest: {
        type: 'object',
        required: ['title', 'amount'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', example: 'Ship MVP' },
          amount: {
            oneOf: [
              { type: 'string', pattern: '^\\d+(\\.\\d{1,7})?$' },
              { type: 'number' },
            ],
            example: '1000',
          },
          dueDate: { type: 'string', format: 'date-time', example: '2026-04-15T00:00:00.000Z' },
        },
      },
      CreateVaultRequest: {
        type: 'object',
        required: ['creator', 'verifier', 'amount', 'endDate', 'milestones'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', example: 'Launch the MVP' },
          creator: { $ref: '#/components/schemas/StellarAddress' },
          verifier: { $ref: '#/components/schemas/StellarAddress' },
          amount: {
            oneOf: [
              { type: 'string', pattern: '^\\d+(\\.\\d{1,7})?$' },
              { type: 'number' },
            ],
            example: '2500',
          },
          startDate: { type: 'string', format: 'date-time', example: '2026-04-01T00:00:00.000Z' },
          endDate: { type: 'string', format: 'date-time', example: '2026-05-01T00:00:00.000Z' },
          successDestination: { $ref: '#/components/schemas/StellarAddress' },
          failureDestination: { $ref: '#/components/schemas/StellarAddress' },
          milestones: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { $ref: '#/components/schemas/CreateMilestoneRequest' },
          },
        },
      },
      OnchainResult: {
        type: 'object',
        additionalProperties: true,
        properties: {
          data: { $ref: '#/components/schemas/Vault' },
          activity: { $ref: '#/components/schemas/Activity' },
          onChain: {
            type: 'object',
            properties: { xdr: { type: 'string' }, networkPassphrase: { type: 'string' }, operation: { type: 'string' } },
          },
          error: { type: 'string' },
        },
      },
      VerifierActionRequest: {
        type: 'object',
        required: ['verifier'],
        additionalProperties: false,
        properties: {
          verifier: { $ref: '#/components/schemas/StellarAddress' },
        },
      },
      SubmitEvidenceRequest: {
        type: 'object',
        required: ['submitter', 'url', 'sha256'],
        additionalProperties: false,
        properties: {
          submitter: { $ref: '#/components/schemas/StellarAddress' },
          url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048, example: 'https://example.com/proof.pdf' },
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$', example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
          note: { type: 'string', maxLength: 1000, example: 'MVP deployed to production' },
        },
      },
      EvidenceEnvelope: {
        type: 'object',
        required: ['data'],
        additionalProperties: false,
        properties: {
          data: { $ref: '#/components/schemas/Evidence' },
        },
      },
    },
  },
}
