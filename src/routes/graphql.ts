import { Router } from 'express'
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLList,
  GraphQLFloat,
  GraphQLInt,
  GraphQLBoolean,
  GraphQLError,
} from 'graphql'
import { createHandler } from 'graphql-http/lib/use/express'
import depthLimit from 'graphql-depth-limit'
import DataLoader from 'dataloader'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { getVaultById, listVaults } from '../services/vaultStore.js'
import { getAnalyticsByPeriod } from '../services/analytics.service.js'
import { listVerifications, VerificationRecord } from '../services/verifiers.js'
import { authenticate } from '../middleware/auth.js'

export const GRAPHQL_MAX_DEPTH = 5

interface GqlContext {
  user: { userId: string; role?: string } | undefined
  orgId: string
  loaders: ReturnType<typeof createLoaders>
}

// Throws a GraphQL-layer Forbidden error if the caller's org doesn't match
function assertOrgScope(context: GqlContext, resourceOrgId: string | null | undefined): void {
  if (!resourceOrgId || resourceOrgId !== context.orgId) {
    throw new GraphQLError('Forbidden: resource does not belong to your organization', {
      extensions: { code: 'FORBIDDEN' },
    })
  }
}

// --- DataLoaders ---
// Batch-fetch verifications by targetId (org-scoped: only load IDs from within the org).
const createLoaders = (orgVaultIds: Set<string>) => ({
  verificationsLoader: new DataLoader<string, VerificationRecord[]>(async (targetIds) => {
    const allVerifications = await listVerifications()
    const grouped = new Map<string, VerificationRecord[]>()
    targetIds.forEach(id => grouped.set(id, []))
    for (const v of allVerifications) {
      // Only surface verifications whose targetId is a vault/milestone in this org
      if (grouped.has(v.targetId) && orgVaultIds.has(v.targetId)) {
        grouped.get(v.targetId)!.push(v)
      }
    }
    return targetIds.map(id => grouped.get(id) ?? [])
  }),
})

// --- Types ---

const ValidationType = new GraphQLObjectType({
  name: 'Validation',
  fields: {
    id: { type: GraphQLString },
    verifierUserId: { type: GraphQLString },
    targetId: { type: GraphQLString },
    result: { type: GraphQLString },
    evidenceHash: { type: GraphQLString },
    disputed: { type: GraphQLBoolean },
    timestamp: { type: GraphQLString },
  },
})

const MilestoneType = new GraphQLObjectType({
  name: 'Milestone',
  fields: () => ({
    id: { type: GraphQLString },
    vaultId: { type: GraphQLString },
    title: { type: GraphQLString },
    description: { type: GraphQLString },
    dueDate: { type: GraphQLString },
    amount: { type: GraphQLString },
    sortOrder: { type: GraphQLInt },
    verifierUserId: { type: GraphQLString },
    createdAt: { type: GraphQLString },
    validations: {
      type: new GraphQLList(ValidationType),
      resolve: (milestone, _args, context: GqlContext) =>
        context.loaders.verificationsLoader.load(milestone.id),
    },
  }),
})

const AnalyticsType = new GraphQLObjectType({
  name: 'Analytics',
  fields: {
    totalVaults: { type: GraphQLInt },
    activeVaults: { type: GraphQLInt },
    completedVaults: { type: GraphQLInt },
    failedVaults: { type: GraphQLInt },
    totalLockedCapital: { type: GraphQLString },
    activeCapital: { type: GraphQLString },
    successRate: { type: GraphQLFloat },
    lastUpdated: { type: GraphQLString },
  },
})

const VaultType = new GraphQLObjectType({
  name: 'Vault',
  fields: () => ({
    id: { type: GraphQLString },
    amount: { type: GraphQLString },
    startDate: { type: GraphQLString },
    endDate: { type: GraphQLString },
    verifier: { type: GraphQLString },
    successDestination: { type: GraphQLString },
    failureDestination: { type: GraphQLString },
    creator: { type: GraphQLString },
    status: { type: GraphQLString },
    createdAt: { type: GraphQLString },
    milestones: { type: new GraphQLList(MilestoneType) },
    validations: {
      type: new GraphQLList(ValidationType),
      resolve: (vault, _args, context: GqlContext) =>
        context.loaders.verificationsLoader.load(vault.id),
    },
    analytics: {
      type: AnalyticsType,
      resolve: async (_vault, _args, _context: GqlContext) => getAnalyticsByPeriod('30d'),
    },
  }),
})

// --- Queries ---

const RootQuery = new GraphQLObjectType({
  name: 'Query',
  fields: {
    vault: {
      type: VaultType,
      args: { id: { type: GraphQLString } },
      resolve: async (_root, args, context: GqlContext) => {
        const vault = await getVaultById(args.id)
        if (!vault) return null
        assertOrgScope(context, vault.orgId)
        return vault
      },
    },
    vaults: {
      type: new GraphQLList(VaultType),
      args: {
        filter: { type: GraphQLString },
        cursor: { type: GraphQLString },
      },
      resolve: async (_root, _args, context: GqlContext) => {
        const all = await listVaults()
        return all.filter(v => v.orgId === context.orgId)
      },
    },
  },
})

const schema = new GraphQLSchema({ query: RootQuery })

// --- Router ---

export const graphqlRouter = Router()

graphqlRouter.use(
  authenticate,
  requireOrgAccess('admin', 'member', 'viewer'),
  createHandler({
    schema,
    context: async (req) => {
      const raw = (req as any).raw
      const orgId: string = raw?.params?.orgId ?? raw?.orgId ?? ''

      if (!orgId) {
        throw new GraphQLError('Unauthorized: orgId missing from request', {
          extensions: { code: 'UNAUTHORIZED' },
        })
      }

      // Pre-fetch org vaults to seed DataLoader scope (once per request)
      const allVaults = await listVaults()
      const orgVaultIds = new Set(
        allVaults.filter(v => v.orgId === orgId).map(v => v.id),
      )

      return {
        user: raw?.user,
        orgId,
        loaders: createLoaders(orgVaultIds),
      } satisfies GqlContext
    },
    validationRules: [depthLimit(GRAPHQL_MAX_DEPTH)],
  }),
)
