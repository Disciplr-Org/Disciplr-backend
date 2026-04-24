import { PrismaClient } from '@prisma/client';

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/disciplr_test';

// Global test setup
beforeAll(async () => {
  // You can add global test setup here
});

afterAll(async () => {
  // You can add global test cleanup here
});
