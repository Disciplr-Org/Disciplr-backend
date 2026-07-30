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
import { getVaultById, listVaultsByOrg } from '../services/vaultStore.js'
import { getAnalyticsByPeriod } from '../services/analytics.service.js'
import { listVerifications, VerificationRecord } from '../services/verifiers.js'
import { authenticate } from '../middleware/auth.js'
import { encodeCursor } from '../utils/pagination.js'

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
    // Scope the DB fetch to only the targetIds requested in this batch that
    // also belong to the current org — avoids a full-table scan.
    const scopedIds = targetIds.filter((id) => orgVaultIds.has(id))
    const verifications = scopedIds.length > 0
      ? await listVerifications(scopedIds)
      : []
    const grouped = new Map<string, VerificationRecord[]>()
    targetIds.forEach(id => grouped.set(id, []))
    for (const v of verifications) {
      if (grouped.has(v.targetId)) {
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

const VaultEdgeType = new GraphQLObjectType({
  name: 'VaultEdge',
  fields: {
    node: { type: VaultType },
    cursor: { type: GraphQLString },
  },
})

const PageInfoType = new GraphQLObjectType({
  name: 'PageInfo',
  fields: {
    hasNextPage: { type: GraphQLBoolean },
    endCursor: { type: GraphQLString },
  },
})

const VaultConnectionType = new GraphQLObjectType({
  name: 'VaultConnection',
  fields: {
    edges: { type: new GraphQLList(VaultEdgeType) },
    pageInfo: { type: PageInfoType },
  },
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
      type: VaultConnectionType,
      args: {
        cursor: { type: GraphQLString },
        limit: { type: GraphQLInt },
      },
      resolve: async (_root, args, context: GqlContext) => {
        const page = await listVaultsByOrg(
          context.orgId,
          args.limit ?? 20,
          args.cursor ?? undefined,
        )
        return {
          edges: page.vaults.map((v) => ({
            node: v,
            cursor: encodeCursor(new Date(v.createdAt), v.id),
          })),
          pageInfo: {
            hasNextPage: page.hasNextPage,
            endCursor: page.nextCursor,
          },
        }
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

      // Fetch the org's vault IDs (and their milestone IDs) to seed DataLoader
      // scope — org-scoped, so no full-table scan. We collect all pages to
      // ensure the verificationsLoader is correctly scoped even for large orgs.
      const orgVaultIds = new Set<string>()
      let pageCursor: string | undefined
      do {
        const page = await listVaultsByOrg(orgId, 100, pageCursor)
        for (const v of page.vaults) {
          orgVaultIds.add(v.id)
          // Also register milestone IDs so the DataLoader can surface
          // verifications whose targetId is a milestone in this org.
          for (const m of v.milestones) orgVaultIds.add(m.id)
        }
        pageCursor = page.nextCursor ?? undefined
      } while (pageCursor)

      return {
        user: raw?.user,
        orgId,
        loaders: createLoaders(orgVaultIds),
      } satisfies GqlContext
    },
    validationRules: [depthLimit(GRAPHQL_MAX_DEPTH)],
  }),
)
