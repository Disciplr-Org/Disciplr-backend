import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

export const healthService = {
  async checkDatabase(): Promise<{ status: string; error?: string }> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'up' };
    } catch (error: any) {
      return { status: 'down', error: error.message };
    }
  },

  async checkHorizon(): Promise<{ status: string; error?: string }> {
    try {
      const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
      await axios.get(`${horizonUrl}/`, { timeout: 5000 });
      return { status: 'up' };
    } catch (error: any) {
      return { status: 'down', error: error.message };
    }
  }
};
