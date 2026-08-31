import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined
}

const basePrisma = globalForPrisma.prisma ?? new PrismaClient()

export const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        let prismaStorageModule;
        try {
          prismaStorageModule = await import('./prismaScope.js');
        } catch {
          // Fallback if imported from another context
        }
        
        const store = prismaStorageModule?.prismaStorage.getStore();
        const orgId = store?.orgId;

        if (orgId) {
          let orgFieldName: string | null = null;
          if (model === 'Vault' || model === 'Team' || model === 'Membership') {
            orgFieldName = 'organizationId';
          } else if (model === 'AnalyticsReport' || model === 'AnalyticsReportQuota' || model === 'OrgVaultSearch') {
            orgFieldName = 'orgId';
          } else if (model === 'Organization') {
            orgFieldName = 'id';
          }

          if (orgFieldName) {
            // 1. Enforce on where clauses (for findUnique, findFirst, findMany, update, updateMany, delete, deleteMany)
            if (args.where) {
              const currentFilter = args.where[orgFieldName];
              if (currentFilter !== undefined) {
                if (currentFilter !== orgId) {
                  throw new Error(`Cross-organization data exposure prevented: query on ${model} requested ${orgFieldName} ${currentFilter} but active orgId is ${orgId}`);
                }
              } else {
                args.where[orgFieldName] = orgId;
              }
            } else if (operation !== 'create' && operation !== 'createMany') {
              args.where = { [orgFieldName]: orgId };
            }

            // 2. Enforce on data/create fields (for create, update, upsert)
            if (args.data) {
              if (Array.isArray(args.data)) {
                for (const item of args.data) {
                  if (item[orgFieldName] !== undefined && item[orgFieldName] !== orgId) {
                    throw new Error(`Cross-organization data exposure prevented: write on ${model} requested ${orgFieldName} ${item[orgFieldName]} but active orgId is ${orgId}`);
                  }
                  item[orgFieldName] = orgId;
                }
              } else {
                if (args.data[orgFieldName] !== undefined && args.data[orgFieldName] !== orgId) {
                  throw new Error(`Cross-organization data exposure prevented: write on ${model} requested ${orgFieldName} ${args.data[orgFieldName]} but active orgId is ${orgId}`);
                }
                args.data[orgFieldName] = orgId;
              }
            }

            // 3. Enforce on upsert fields
            if (args.create) {
              if (args.create[orgFieldName] !== undefined && args.create[orgFieldName] !== orgId) {
                throw new Error(`Cross-organization data exposure prevented: upsert create on ${model} requested ${orgFieldName} ${args.create[orgFieldName]} but active orgId is ${orgId}`);
              }
              args.create[orgFieldName] = orgId;
            }
            if (args.update) {
              if (args.update[orgFieldName] !== undefined && args.update[orgFieldName] !== orgId) {
                throw new Error(`Cross-organization data exposure prevented: upsert update on ${model} requested ${orgFieldName} ${args.update[orgFieldName]} but active orgId is ${orgId}`);
              }
              args.update[orgFieldName] = orgId;
            }
          }
        }

        return query(args)
      }
    }
  }
}) as unknown as PrismaClient

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = basePrisma

