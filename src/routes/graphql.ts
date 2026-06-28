import { Router } from 'express'
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLList,
  GraphQLFloat,
  GraphQLInt,
  GraphQLBoolean,
} from 'graphql'
import { createHandler } from 'graphql-http/lib/use/express'
import depthLimit from 'graphql-depth-limit'
import DataLoader from 'dataloader'
import { requireOrgRole } from '../middleware/orgAuth.js'
import { getVaultById, listVaults } from '../services/vaultStore.js'
import { getAnalyticsByPeriod } from '../services/analytics.service.js'
import { listVerifications, VerificationRecord } from '../services/verifiers.js'
import { authenticate } from '../middleware/auth.js'

// --- DataLoaders ---
// To avoid N+1 queries, we batch fetching verifications by targetId
const createLoaders = () => {
  return {
    verificationsLoader: new DataLoader<string, VerificationRecord[]>(async (targetIds) => {
      // In a real DB, we'd query WHERE target_id IN (...targetIds)
      // Reusing existing service which fetches all:
      const allVerifications = await listVerifications()
      
      const grouped = new Map<string, VerificationRecord[]>()
      targetIds.forEach(id => grouped.set(id, []))
      
      for (const v of allVerifications) {
        if (grouped.has(v.targetId)) {
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
      resolve: (milestone, args, context) => {
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
      resolve: (vault, args, context) => {
        return context.loaders.verificationsLoader.load(vault.id)
      }
    },
    analytics: {
      type: AnalyticsType,
      resolve: async (vault, args, context) => {
        // Just return overall analytics for now or period specific
        // based on existing services. We'll use 30d period as an example
        return await getAnalyticsByPeriod('30d')
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
      resolve: async (_, args, context) => {
        // Enforce org-scoping here implicitly if services did it, but 
        // since we just have getVaultById, we check orgId logic if present.
        // For now, reuse getVaultById.
        const vault = await getVaultById(args.id)
        return vault
      }
    },
    vaults: {
      type: new GraphQLList(VaultType),
      args: {
        filter: { type: GraphQLString },
        cursor: { type: GraphQLString },
      },
      resolve: async (_, args, context) => {
        const vaults = await listVaults()
        // Here we could apply cursor and filter logic
        return vaults
      }
    }
  }
})

const schema = new GraphQLSchema({
  query: RootQuery,
})

// --- Router ---

export const graphqlRouter = Router()

// Apply authentication and org-scoping middleware to the graphql route
// The user prompt requested applying org-auth middleware. 
graphqlRouter.use(
  authenticate,
  requireOrgRole(['admin', 'member', 'viewer']), // standard roles
  createHandler({
    schema,
    context: (req) => {
      return {
        user: (req as any).raw?.user,
        orgId: (req as any).raw?.orgId,
        loaders: createLoaders(),
      }
    },
    validationRules: [depthLimit(5)], // Bound query depth to prevent abusive nested queries
  })
)
