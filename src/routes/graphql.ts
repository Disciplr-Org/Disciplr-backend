import { Router } from 'express'
import { createRequire } from 'node:module'
import type * as GraphQL from 'graphql'
import { createHandler } from 'graphql-http/lib/use/express'
import depthLimit from 'graphql-depth-limit'
import DataLoader from 'dataloader'
import { requireOrgRole } from '../middleware/orgAuth.js'
import { getVaultById, listVaults } from '../services/vaultStore.js'
import { listVerifications, VerificationRecord } from '../services/verifiers.js'
import { authenticate } from '../middleware/auth.js'

const require = createRequire(import.meta.url)
const {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLList,
  GraphQLFloat,
  GraphQLInt,
  GraphQLBoolean,
} = require('graphql') as typeof GraphQL

type OrgScopedRecord = {
  orgId?: string | null
  organizationId?: string | null
  organization_id?: string | null
}

type GraphQLContext = {
  user?: unknown
  orgId: string
  loaders: GraphQLLoaders
}

type GraphQLLoaders = {
  verificationsLoader: DataLoader<string, VerificationRecord[]>
}

const getRecordOrgId = (record: OrgScopedRecord | null | undefined): string | null =>
  record?.orgId ?? record?.organizationId ?? record?.organization_id ?? null

const isInRequestOrg = (record: OrgScopedRecord | null | undefined, orgId: string): boolean =>
  getRecordOrgId(record) === orgId

const isAllowedOrgTaggedRecord = (record: OrgScopedRecord | null | undefined, orgId: string): boolean => {
  const recordOrgId = getRecordOrgId(record)
  return recordOrgId === null || recordOrgId === orgId
}

const listVaultsForOrg = async (orgId: string) => {
  const vaults = await listVaults()
  return vaults.filter((vault) => isInRequestOrg(vault as OrgScopedRecord, orgId))
}

const collectVaultTargetIds = (vaults: Array<{ id?: string; milestones?: Array<{ id?: string }> }>) => {
  const targetIds = new Set<string>()
  for (const vault of vaults) {
    if (vault.id) targetIds.add(vault.id)
    for (const milestone of vault.milestones ?? []) {
      if (milestone.id) targetIds.add(milestone.id)
    }
  }
  return targetIds
}

const summarizeVaults = (vaults: Array<{ amount?: string | null; status?: string | null }>) => {
  const activeVaults = vaults.filter((vault) => vault.status === 'active').length
  const completedVaults = vaults.filter((vault) => vault.status === 'completed').length
  const failedVaults = vaults.filter((vault) => vault.status === 'failed').length
  const totalLockedCapital = vaults.reduce((sum, vault) => sum + Number.parseFloat(vault.amount ?? '0'), 0)
  const activeCapital = vaults
    .filter((vault) => vault.status === 'active')
    .reduce((sum, vault) => sum + Number.parseFloat(vault.amount ?? '0'), 0)
  const resolvedVaults = completedVaults + failedVaults

  return {
    totalVaults: vaults.length,
    activeVaults,
    completedVaults,
    failedVaults,
    totalLockedCapital: String(totalLockedCapital),
    activeCapital: String(activeCapital),
    successRate: resolvedVaults > 0 ? completedVaults / resolvedVaults : 0,
    lastUpdated: new Date().toISOString(),
  }
}

const resolveRawRequest = (req: unknown): any => (req as any).raw ?? req

const resolveContextOrgId = (req: unknown): string => {
  const raw = resolveRawRequest(req)
  const orgId = raw?.orgId ?? raw?.params?.orgId
  if (!orgId) {
    throw new Error('GraphQL organization context missing')
  }
  return orgId
}

// --- DataLoaders ---
// To avoid N+1 queries, we batch fetching verifications by targetId
const createLoaders = (orgId: string): GraphQLLoaders => {
  return {
    verificationsLoader: new DataLoader<string, VerificationRecord[]>(async (targetIds) => {
      // In a real DB, we'd query WHERE target_id IN (...targetIds)
      // Reusing existing service which fetches all:
      const [allVerifications, orgVaults] = await Promise.all([listVerifications(), listVaultsForOrg(orgId)])
      const allowedTargetIds = collectVaultTargetIds(orgVaults)
      
      const grouped = new Map<string, VerificationRecord[]>()
      targetIds.forEach(id => grouped.set(id, []))
      
      for (const v of allVerifications) {
        if (
          grouped.has(v.targetId) &&
          allowedTargetIds.has(v.targetId) &&
          isAllowedOrgTaggedRecord(v as OrgScopedRecord, orgId)
        ) {
          grouped.get(v.targetId)!.push(v)
        }
      }
      
      return targetIds.map(id => grouped.get(id) || [])
    })
  }
}

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
  }
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
      resolve: (milestone, args, context: GraphQLContext) => {
        return context.loaders.verificationsLoader.load(milestone.id)
      }
    }
  })
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
  }
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
      resolve: (vault, args, context: GraphQLContext) => {
        return context.loaders.verificationsLoader.load(vault.id)
      }
    },
    analytics: {
      type: AnalyticsType,
      resolve: async (_vault, _args, context: GraphQLContext) => {
        return summarizeVaults(await listVaultsForOrg(context.orgId))
      }
    }
  })
})

// --- Queries ---

const RootQuery = new GraphQLObjectType({
  name: 'Query',
  fields: {
    vault: {
      type: VaultType,
      args: { id: { type: GraphQLString } },
      resolve: async (_, args, context: GraphQLContext) => {
        const vault = await getVaultById(args.id)
        return isInRequestOrg(vault as OrgScopedRecord | null, context.orgId) ? vault : null
      }
    },
    vaults: {
      type: new GraphQLList(VaultType),
      args: {
        filter: { type: GraphQLString },
        cursor: { type: GraphQLString },
      },
      resolve: async (_, args, context: GraphQLContext) => {
        return listVaultsForOrg(context.orgId)
      }
    }
  }
})

const schema = new GraphQLSchema({
  query: RootQuery,
})

// --- Router ---

export const graphqlRouter = Router({ mergeParams: true })

// Apply authentication and org-scoping middleware to the graphql route
graphqlRouter.use(
  authenticate,
  requireOrgRole(['owner', 'admin', 'member']),
  createHandler({
    schema,
    context: (req) => {
      const raw = resolveRawRequest(req)
      const orgId = resolveContextOrgId(req)
      return {
        user: raw?.user,
        orgId,
        loaders: createLoaders(orgId),
      }
    },
    validationRules: [depthLimit(5)], // Bound query depth to prevent abusive nested queries
  })
)
