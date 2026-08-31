// Mock PrismaClient for Jest tests
export class PrismaClient {
  user = {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => data.data,
    update: async (data: any) => data.data,
    updateMany: async () => ({ count: 0 }),
    delete: async () => ({}),
    count: async () => 0,
  }
  refreshToken = {
    create: async (data: any) => data.data,
    findUnique: async () => null,
    update: async (data: any) => data.data,
    updateMany: async () => ({ count: 0 }),
  }
  $extends = () => this
  $queryRaw = async () => [{ '?column?': 1 }]
  $connect = async () => {}
  $disconnect = async () => {}
  organization = {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => data.data,
  }
  membership = {
    findFirst: async () => null,
    findMany: async () => [],
    create: async (data: any) => data.data,
  }
  team = {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => data.data,
  }
  orgVaultSearch = {
    findUnique: async () => null,
    findMany: async () => [],
    create: async (data: any) => data.data,
  }
}
