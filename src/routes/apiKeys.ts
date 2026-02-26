import { Router } from 'express'
import { requireUserAuth } from '../middleware/userAuth.js'
import { createApiKey, listApiKeysForUser, revokeApiKey } from '../services/apiKeys.js'

export const apiKeysRouter = Router()

apiKeysRouter.use(requireUserAuth)

/**
 * @swagger
 * /api/api-keys:
 *   get:
 *     summary: Get user's API keys
 *     description: Retrieve all API keys belonging to the authenticated user
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: API keys retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 apiKeys:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ApiKey'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
apiKeysRouter.get('/', (req, res) => {
  const userId = req.authUser!.userId
  const apiKeys = listApiKeysForUser(userId).map(({ keyHash: _keyHash, ...publicRecord }) => publicRecord)

  res.json({ apiKeys })
})

/**
 * @swagger
 * /api/api-keys:
 *   post:
 *     summary: Create a new API key
 *     description: Create a new API key for the authenticated user
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateApiKeyRequest'
 *     responses:
 *       201:
 *         description: API key created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 apiKey:
 *                   type: string
 *                   description: The newly created API key (only shown once)
 *                 apiKeyMeta:
 *                   $ref: '#/components/schemas/ApiKey'
 *       400:
 *         description: Bad request - invalid input
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
apiKeysRouter.post('/', (req, res) => {
  const userId = req.authUser!.userId
  const { label, scopes, orgId } = req.body as {
    label?: string
    scopes?: unknown
    orgId?: string
  }

  if (!label?.trim()) {
    res.status(400).json({ error: 'label is required.' })
    return
  }

  if (!Array.isArray(scopes)) {
    res.status(400).json({ error: 'scopes must be an array of scope strings.' })
    return
  }

  const normalizedScopes = scopes
    .map((scope) => (typeof scope === 'string' ? scope.trim() : ''))
    .filter(Boolean)

  const { apiKey, record } = createApiKey({
    userId,
    orgId: orgId?.trim() || undefined,
    label: label.trim(),
    scopes: normalizedScopes,
  })

  const { keyHash: _keyHash, ...publicRecord } = record
  res.status(201).json({
    apiKey,
    apiKeyMeta: publicRecord,
  })
})

/**
 * @swagger
 * /api/api-keys/{id}/revoke:
 *   post:
 *     summary: Revoke an API key
 *     description: Revoke an existing API key by its ID
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: API key ID to revoke
 *     responses:
 *       200:
 *         description: API key revoked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 apiKeyMeta:
 *                   $ref: '#/components/schemas/ApiKey'
 *       404:
 *         description: API key not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
apiKeysRouter.post('/:id/revoke', (req, res) => {
  const userId = req.authUser!.userId
  const record = revokeApiKey(req.params.id, userId)

  if (!record) {
    res.status(404).json({ error: 'API key not found.' })
    return
  }

  const { keyHash: _keyHash, ...publicRecord } = record
  res.json({ apiKeyMeta: publicRecord })
})
