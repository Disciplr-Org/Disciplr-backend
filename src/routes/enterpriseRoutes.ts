import { Router, Request, Response } from 'express';
import { db } from '../db/knex';
import { toPublicVault, toPublicMilestone } from '../utils/mappers';
import { maskPii } from '../utils/privacy';
import gr from 'debug';

const debug = gr('disciplr:api:enterprise');
const router = Router();

/**
 * @route GET /api/v1/enterprise/vaults/:id
 * @desc Fetches a vault by ID with strict exposure audit applied.
 */
router.get('/vaults/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  
  try {
    const vault = await db('vaults').where({ id }).first();
    
    if (!vault) {
      return res.status(404).json({ error: 'Vault not found' });
    }

    // Audit Logging: Mask PII (creator address) in observability output
    debug('Fetching vault %s for creator %s', id, maskPii(vault.creator_address));

    // Exposure Audit: Map to public DTO to strip internal fields (e.g., created_at)
    const publicVault = toPublicVault(vault);
    
    return res.json(publicVault);
  } catch (error) {
    debug('Error fetching vault %s: %O', id, error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route GET /api/v1/enterprise/vaults/:id/milestones
 * @desc Fetches milestones for a vault with strict exposure audit.
 */
router.get('/vaults/:id/milestones', async (req: Request, res: Response) => {
  const { id } = req.params;
  
  try {
    const milestones = await db('milestones').where({ vault_id: id });
    
    debug('Fetching %d milestones for vault %s', milestones.length, id);

    const publicMilestones = milestones.map(toPublicMilestone);
    return res.json(publicMilestones);
  } catch (error) {
    debug('Error fetching milestones for vault %s: %O', id, error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;