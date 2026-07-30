import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPgPool } from "../db/pool.js";
import type {
  CreateVaultInput,
  PersistedMilestone,
  PersistedVault,
} from "../types/vaults.js";
import { VaultStatus } from "../types/vault.js";
import { getOrSet, getOrLoad, invalidate, invalidatePrefix } from "../lib/cache.js";
import { encodeCursor, decodeCursor } from "../utils/pagination.js";

type UpdateableVaultField =
  | "amount"
  | "startDate"
  | "endDate"
  | "verifier"
  | "successDestination"
  | "failureDestination"
  | "creator"
  | "status";

type VaultUpdatePayload = Partial<Pick<PersistedVault, UpdateableVaultField>>;

const vaultFieldToColumn: Record<UpdateableVaultField, string> = {
  amount: "amount",
  startDate: "start_date",
  endDate: "end_date",
  verifier: "verifier",
  successDestination: "success_destination",
  failureDestination: "failure_destination",
  creator: "creator",
  status: "status",
};

class HttpStatusError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = this.constructor.name;
  }
}

class ConflictError extends HttpStatusError {
  constructor(message = "Vault update conflict") {
    super(message, 409);
  }
}

class BadRequestError extends HttpStatusError {
  constructor(message: string) {
    super(message, 400);
  }
}

const logVersionConflict = (id: string, revision: string, context: string) => {
  console.warn({
    event: "vault.optimistic_lock_conflict",
    vaultId: id,
    attemptedRevision: revision,
    context,
  });
};

let memoryVaults: PersistedVault[] = [];
const memoryVaultRevisions = new Map<string, number>();

const mapVaultRow = (row: {
  id: string;
  amount: string;
  start_date: string;
  end_date: string;
  verifier: string;
  success_destination: string;
  failure_destination: string;
  creator: string | null;
  status: PersistedVault["status"];
  created_at: string;
  late_check_in_window_secs?: number | null;
  organization_id?: string | null;
}): Omit<PersistedVault, "milestones"> => ({
  id: row.id,
  amount: row.amount,
  startDate: row.start_date,
  endDate: row.end_date,
  verifier: row.verifier,
  successDestination: row.success_destination,
  failureDestination: row.failure_destination,
  creator: row.creator,
  status: row.status,
  createdAt: row.created_at,
  lateCheckInWindowSecs: row.late_check_in_window_secs ?? 0,
  orgId: row.organization_id ?? undefined,
});

export const createVaultWithMilestones = async (
  input: CreateVaultInput,
  customClient?: PoolClient,
): Promise<{ vault: PersistedVault; clientUsed: PoolClient | null }> => {
  const pool = getPgPool();
  const client = customClient ?? (pool ? await pool.connect() : null);
  const releaseClient = Boolean(client && !customClient);

  const vaultId = randomUUID();
  const now = new Date().toISOString();
  const milestones: PersistedMilestone[] = input.milestones.map(
    (milestone, index) => ({
      id: randomUUID(),
      vaultId,
      title: milestone.title,
      description: milestone.description?.trim() || null,
      dueDate: milestone.dueDate,
      amount: milestone.amount,
      sortOrder: index,
      verifierUserId: input.verifier, // Assign the vault's verifier to each milestone
      createdAt: now,
    }),
  );

  const orgId = input.orgId;

  if (!client) {
    if (process.env.NODE_ENV !== "development") {
      console.warn(
        "CRITICAL WARNING: Postgres client is unavailable. Falling back to in-memory vault store. Data will NOT be persisted across restarts! This is unexpected outside of development."
      );
    }

    const vault: PersistedVault = {
      id: vaultId,
      amount: input.amount,
      startDate: input.startDate,
      endDate: input.endDate,
      verifier: input.verifier,
      successDestination: input.destinations.success,
      failureDestination: input.destinations.failure,
      creator: input.creator ?? null,
      status: VaultStatus.DRAFT,
      createdAt: now,
      milestones,
      lateCheckInWindowSecs: input.lateCheckInWindowSecs ?? 0,
      orgId,
    };
    memoryVaults.push(vault);
    memoryVaultRevisions.set(vault.id, 0);

    // Evict/Invalidate caches on successful write
    if (orgId) {
      await invalidatePrefix('vaults:', orgId);
      await invalidatePrefix('analytics:', orgId);
    }
    await invalidate('analytics:overall');

    return { vault, clientUsed: null };
  }

  try {
    if (!customClient) {
      await client.query("BEGIN");
    }

    const vaultResult = await client.query<{
      id: string;
      amount: string;
      start_date: string;
      end_date: string;
      verifier: string;
      success_destination: string;
      failure_destination: string;
      creator: string | null;
      status: PersistedVault["status"];
      created_at: string;
      late_check_in_window_secs: number | null;
      organization_id: string | null;
    }>(
      `INSERT INTO vaults
        (id, amount, start_date, end_date, verifier, success_destination, failure_destination, creator, status, late_check_in_window_secs, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10)
        RETURNING id, amount::text, start_date, end_date, verifier, success_destination, failure_destination, creator, status, created_at, late_check_in_window_secs, organization_id`,
      [
        vaultId,
        input.amount,
        input.startDate,
        input.endDate,
        input.verifier,
        input.destinations.success,
        input.destinations.failure,
        input.creator ?? null,
        input.lateCheckInWindowSecs ?? 0,
        orgId ?? null,
      ],
    );

    for (const milestone of milestones) {
      await client.query(
        `INSERT INTO milestones
          (id, vault_id, title, description, due_date, amount, sort_order, verifier_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          milestone.id,
          milestone.vaultId,
          milestone.title,
          milestone.description,
          milestone.dueDate,
          milestone.amount,
          milestone.sortOrder,
          milestone.verifierUserId,
        ],
      );
    }

    const vault: PersistedVault = {
      ...mapVaultRow(vaultResult.rows[0]),
      milestones,
    };

    if (!customClient) {
      await client.query("COMMIT");
    }

    // Evict/Invalidate caches on successful write
    const finalOrgId = vault.orgId;
    if (finalOrgId) {
      await invalidatePrefix('vaults:', finalOrgId);
      await invalidatePrefix('analytics:', finalOrgId);
    }
    await invalidate('analytics:overall');

    return { vault, clientUsed: client };
  } catch (error) {
    if (!customClient) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    if (releaseClient && client) {
      client.release();
    }
  }
};

export const listVaults = async (): Promise<PersistedVault[]> => {
  const pool = getPgPool();
  if (!pool) {
    return memoryVaults.map((vault) => ({
      ...vault,
      milestones: vault.milestones.map((milestone) => ({ ...milestone })),
    }));
  }

  const vaultRows = await pool.query<{
    id: string;
    amount: string;
    start_date: string;
    end_date: string;
    verifier: string;
    success_destination: string;
    failure_destination: string;
    creator: string | null;
    status: PersistedVault["status"];
    created_at: string;
    late_check_in_window_secs: number | null;
    organization_id: string | null;
  }>(
    "SELECT id, amount::text, start_date, end_date, verifier, success_destination, failure_destination, creator, status, created_at, late_check_in_window_secs, organization_id FROM vaults ORDER BY created_at DESC",
  );

  const milestoneRows = await pool.query<{
    id: string;
    vault_id: string;
    title: string;
    description: string | null;
    due_date: string;
    amount: string;
    sort_order: number;    verifier_user_id: string | null;    created_at: string;
  }>(
    "SELECT id, vault_id, title, description, due_date, amount::text, sort_order, verifier_user_id, created_at FROM milestones ORDER BY sort_order ASC",
  );

  const milestonesByVault = new Map<string, PersistedMilestone[]>();
  for (const milestone of milestoneRows.rows) {
    const mapped: PersistedMilestone = {
      id: milestone.id,
      vaultId: milestone.vault_id,
      title: milestone.title,
      description: milestone.description,
      dueDate: milestone.due_date,
      amount: milestone.amount,
      sortOrder: milestone.sort_order,
      verifierUserId: milestone.verifier_user_id,
      createdAt: milestone.created_at,
    };

    const existing = milestonesByVault.get(milestone.vault_id);
    if (existing) {
      existing.push(mapped);
    } else {
      milestonesByVault.set(milestone.vault_id, [mapped]);
    }
  }

  const rows: Array<{
    id: string;
    amount: string;
    start_date: string;
    end_date: string;
    verifier: string;
    success_destination: string;
    failure_destination: string;
    creator: string | null;
    status: PersistedVault["status"];
    created_at: string;
    late_check_in_window_secs: number | null;
  }> = vaultRows.rows;

  return rows.map((row) => ({
    ...mapVaultRow(row),
    milestones: milestonesByVault.get(row.id) ?? [],
  }));
};

export interface VaultPage {
  vaults: PersistedVault[];
  /** Opaque cursor to pass as `cursor` on the next call to get the next page. */
  nextCursor: string | null;
  hasNextPage: boolean;
}

/**
 * Fetches a page of vaults scoped to a single org.
 *
 * Uses keyset (cursor) pagination on (created_at DESC, id DESC) so it is
 * O(log n) on the index regardless of total vault count.
 *
 * @param orgId   - The organisation whose vaults to return.
 * @param limit   - Maximum number of vaults per page (default 20, max 100).
 * @param cursor  - Opaque cursor returned by the previous page; omit for the first page.
 */
export const listVaultsByOrg = async (
  orgId: string,
  limit = 20,
  cursor?: string,
): Promise<VaultPage> => {
  const safeLimit = Math.min(Math.max(1, limit), 100);

  const pool = getPgPool();
  if (!pool) {
    // In-memory fallback: filter, sort, then page.
    const orgVaults = memoryVaults
      .filter((v) => v.orgId === orgId)
      .sort((a, b) => {
        const timeDiff =
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
      });

    let startIdx = 0;
    if (cursor) {
      const { timestamp, id } = decodeCursor(cursor);
      startIdx = orgVaults.findIndex(
        (v) =>
          new Date(v.createdAt).getTime() < timestamp.getTime() ||
          (new Date(v.createdAt).getTime() === timestamp.getTime() &&
            v.id < id),
      );
      if (startIdx === -1) startIdx = orgVaults.length;
    }

    const page = orgVaults.slice(startIdx, startIdx + safeLimit + 1);
    const hasNextPage = page.length > safeLimit;
    const items = page.slice(0, safeLimit).map((v) => ({
      ...v,
      milestones: v.milestones.map((m) => ({ ...m })),
    }));

    const last = items[items.length - 1];
    const nextCursor =
      hasNextPage && last
        ? encodeCursor(new Date(last.createdAt), last.id)
        : null;

    return { vaults: items, nextCursor, hasNextPage };
  }

  // Keyset pagination: fetch one extra row to detect hasNextPage.
  let vaultRows: {
    id: string;
    amount: string;
    start_date: string;
    end_date: string;
    verifier: string;
    success_destination: string;
    failure_destination: string;
    creator: string | null;
    status: PersistedVault["status"];
    created_at: string;
    late_check_in_window_secs: number | null;
    organization_id: string | null;
  }[];

  if (cursor) {
    const { timestamp, id } = decodeCursor(cursor);
    const result = await pool.query<typeof vaultRows[number]>(
      `SELECT id, amount::text, start_date, end_date, verifier, success_destination,
              failure_destination, creator, status, created_at,
              late_check_in_window_secs, organization_id
       FROM   vaults
       WHERE  organization_id = $1
         AND  (created_at, id) < ($2, $3)
       ORDER  BY created_at DESC, id DESC
       LIMIT  $4`,
      [orgId, timestamp.toISOString(), id, safeLimit + 1],
    );
    vaultRows = result.rows;
  } else {
    const result = await pool.query<typeof vaultRows[number]>(
      `SELECT id, amount::text, start_date, end_date, verifier, success_destination,
              failure_destination, creator, status, created_at,
              late_check_in_window_secs, organization_id
       FROM   vaults
       WHERE  organization_id = $1
       ORDER  BY created_at DESC, id DESC
       LIMIT  $2`,
      [orgId, safeLimit + 1],
    );
    vaultRows = result.rows;
  }

  const hasNextPage = vaultRows.length > safeLimit;
  const pageRows = vaultRows.slice(0, safeLimit);

  // Fetch milestones only for the vaults on this page.
  const vaultIds = pageRows.map((r) => r.id);
  const milestonesByVault = new Map<string, PersistedMilestone[]>();

  if (vaultIds.length > 0) {
    const milestoneResult = await pool.query<{
      id: string;
      vault_id: string;
      title: string;
      description: string | null;
      due_date: string;
      amount: string;
      sort_order: number;
      verifier_user_id: string | null;
      created_at: string;
    }>(
      `SELECT id, vault_id, title, description, due_date, amount::text,
              sort_order, verifier_user_id, created_at
       FROM   milestones
       WHERE  vault_id = ANY($1)
       ORDER  BY sort_order ASC`,
      [vaultIds],
    );

    for (const m of milestoneResult.rows) {
      const mapped: PersistedMilestone = {
        id: m.id,
        vaultId: m.vault_id,
        title: m.title,
        description: m.description,
        dueDate: m.due_date,
        amount: m.amount,
        sortOrder: m.sort_order,
        verifierUserId: m.verifier_user_id,
        createdAt: m.created_at,
      };
      const existing = milestonesByVault.get(m.vault_id);
      if (existing) {
        existing.push(mapped);
      } else {
        milestonesByVault.set(m.vault_id, [mapped]);
      }
    }
  }

  const vaults: PersistedVault[] = pageRows.map((row) => ({
    ...mapVaultRow(row),
    milestones: milestonesByVault.get(row.id) ?? [],
  }));

  const last = vaults[vaults.length - 1];
  const nextCursor =
    hasNextPage && last
      ? encodeCursor(new Date(last.createdAt), last.id)
      : null;

  return { vaults, nextCursor, hasNextPage };
};

export const updateVaultById = async (
  id: string,
  revision: string,
  payload: VaultUpdatePayload,
  customClient?: PoolClient,
): Promise<PersistedVault> => {
  if (typeof revision !== "string" || revision.trim() === "") {
    throw new BadRequestError("revision is required");
  }

  const entries = (
    Object.entries(payload) as Array<
      [UpdateableVaultField, PersistedVault[UpdateableVaultField]]
    >
  ).filter(([, value]) => value !== undefined);

  if (entries.length === 0) {
    throw new BadRequestError("no vault fields provided for update");
  }

  const setParts: string[] = [];
  const values: unknown[] = [];
  entries.forEach(([field, value], index) => {
    setParts.push(`${vaultFieldToColumn[field]} = $${index + 3}`);
    values.push(value);
  });

  const pool = getPgPool();
  if (!pool) {
    const vaultIndex = memoryVaults.findIndex((vault) => vault.id === id);
    if (vaultIndex === -1) {
      logVersionConflict(id, revision, "memory.no_rows");
      throw new ConflictError();
    }

    const currentVault = memoryVaults[vaultIndex];
    const currentRevision = String(memoryVaultRevisions.get(id) ?? 0);
    if (currentRevision !== revision) {
      logVersionConflict(id, revision, "memory.version_mismatch");
      throw new ConflictError();
    }

    const updates = Object.fromEntries(entries) as Partial<
      Pick<PersistedVault, UpdateableVaultField>
    >;
    const updatedVault: PersistedVault = {
      ...currentVault,
      ...updates,
    };

    memoryVaults[vaultIndex] = updatedVault;
    memoryVaultRevisions.set(id, Number(currentRevision) + 1);

    // Evict/Invalidate cache
    const orgId = updatedVault.orgId;
    await invalidate(`vault:${id}`, orgId);
    await invalidate(`vault:${id}:org`);
    if (orgId) {
      await invalidatePrefix('vaults:', orgId);
      await invalidatePrefix('analytics:', orgId);
    }
    await invalidate('analytics:overall');

    return updatedVault;
  }

  const executor = customClient ?? pool;
  // Use PostgreSQL xmin as a revision token for optimistic locking (no schema change required).
  const query = `
    UPDATE vaults
    SET ${setParts.join(", ")}
    WHERE id = $1 AND xmin::text = $2
    RETURNING id, amount::text, start_date, end_date, verifier, success_destination, failure_destination, creator, status, created_at, late_check_in_window_secs, organization_id
  `;
  const result = await executor.query(query, [id, revision, ...values]);

  if (result.rows.length === 0) {
    logVersionConflict(id, revision, "db.no_rows");
    throw new ConflictError();
  }

  const milestoneRows = await executor.query<{
    id: string;
    vault_id: string;
    title: string;
    description: string | null;
    due_date: string;
    amount: string;
    sort_order: number;
    verifier_user_id: string | null;
    created_at: string;
  }>(
    "SELECT id, vault_id, title, description, due_date, amount::text, sort_order, verifier_user_id, created_at FROM milestones WHERE vault_id = $1 ORDER BY sort_order ASC",
    [id],
  );

  const milestones: PersistedMilestone[] = milestoneRows.rows.map(
    (milestone) => ({
      id: milestone.id,
      vaultId: milestone.vault_id,
      title: milestone.title,
      description: milestone.description,
      dueDate: milestone.due_date,
      amount: milestone.amount,
      sortOrder: milestone.sort_order,
      verifierUserId: milestone.verifier_user_id,
      createdAt: milestone.created_at,
    }),
  );

  const updatedVault = {
    ...mapVaultRow(result.rows[0]),
    milestones,
  };

  // Evict/Invalidate cache
  const orgId = updatedVault.orgId;
  await invalidate(`vault:${id}`, orgId);
  await invalidate(`vault:${id}:org`);
  if (orgId) {
    await invalidatePrefix('vaults:', orgId);
    await invalidatePrefix('analytics:', orgId);
  }
  await invalidate('analytics:overall');

  return updatedVault;
};

export const getVaultById = async (
  id: string,
): Promise<PersistedVault | null> => {
  // 1. Try to get orgId from cache mapping `vault:${id}:org`
  const orgId = await getOrLoad<string | null>(`vault:${id}:org`, 300, async () => {
    const allVaults = await listVaults();
    const vault = allVaults.find((v) => v.id === id) ?? null;
    return vault ? (vault.orgId || null) : null;
  });

  if (orgId) {
    return getOrLoad<PersistedVault | null>(`vault:${id}`, 300, async () => {
      const allVaults = await listVaults();
      return allVaults.find((v) => v.id === id) ?? null;
    }, orgId);
  } else {
    return getOrLoad<PersistedVault | null>(`vault:${id}`, 300, async () => {
      const allVaults = await listVaults();
      return allVaults.find((v) => v.id === id) ?? null;
    });
  }
};

export const resetVaultStore = (): void => {
  memoryVaults.length = 0;
  memoryVaultRevisions.clear();
};

/**
 * Sets the in-memory vault array for test purposes.
 * This allows tests to seed vault data without requiring a database.
 * @param newVaults - Array of vault objects to use for testing
 */
export const setTestVaults = (newVaults: PersistedVault[]): void => {
  memoryVaults.length = 0;
  memoryVaults.push(...newVaults);
  // Reset revisions for all test vaults
  newVaults.forEach(vault => {
    memoryVaultRevisions.set(vault.id, 0);
  });
};

export const getVaultRevisionById = async (
  id: string,
): Promise<string | null> => {
  const pool = getPgPool();
  if (!pool) {
    if (!memoryVaults.some((vault) => vault.id === id)) {
      return null;
    }
    return String(memoryVaultRevisions.get(id) ?? 0);
  }

  const result = await pool.query<{ revision: string }>(
    "SELECT xmin::text AS revision FROM vaults WHERE id = $1",
    [id],
  );
  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].revision;
};

/**
 * Computes a weak ETag for a vault based on its revision.
 * The ETag is derived from the optimistic-concurrency version column (PostgreSQL xmin or memory counter).
 * Weak ETags are used because vault representations may be transformed during transmission.
 *
 * @param id - Vault ID
 * @returns Weak ETag string in format W/"-<version>" or null if vault not found
 * @example
 *   getVaultETag('vault-123') // Returns: W/"-456789" (where 456789 is the xmin value)
 */
export const getVaultETag = async (id: string): Promise<string | null> => {
  const revision = await getVaultRevisionById(id);
  if (!revision) {
    return null;
  }
  // Import at function level to avoid circular dependencies
  const { computeWeakETag } = await import("../utils/etag.js");
  return computeWeakETag(revision);
};

export type CancelVaultResult =
  | {
      error: "not_found" | "already_cancelled" | "not_cancellable";
      currentStatus?: string;
    }
  | { vault: PersistedVault; previousStatus: string };

export const cancelVaultById = async (
  id: string,
): Promise<CancelVaultResult> => {
  const pool = getPgPool();
  if (!pool) {
    // In-memory fallback
    const idx = memoryVaults.findIndex((v) => v.id === id);
    if (idx === -1) return { error: "not_found" };
    const vault = memoryVaults[idx];

    if (vault.status === VaultStatus.CANCELLED) {
      return { error: "already_cancelled", currentStatus: VaultStatus.CANCELLED };
    }
    if (vault.status !== VaultStatus.DRAFT && vault.status !== VaultStatus.ACTIVE) {
      return { error: "not_cancellable", currentStatus: vault.status };
    }

    const previousStatus = vault.status;
    vault.status = VaultStatus.CANCELLED;
    const currentRevision = memoryVaultRevisions.get(id) ?? 0;
    memoryVaultRevisions.set(id, currentRevision + 1);

    const orgId = vault.orgId;
    await invalidate(`vault:${id}`, orgId);
    await invalidate(`vault:${id}:org`);
    if (orgId) {
      await invalidatePrefix('vaults:', orgId);
      await invalidatePrefix('analytics:', orgId);
    }
    await invalidate('analytics:overall');

    return { vault, previousStatus };
  }

  // Database path
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const vaultRes = await client.query<{ status: string }>(
      "SELECT status FROM vaults WHERE id = $1 FOR UPDATE",
      [id],
    );

    if (vaultRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return { error: "not_found" };
    }

    const vaultStatus = vaultRes.rows[0].status;
    if (vaultStatus === "cancelled") {
      await client.query("ROLLBACK");
      return { error: "already_cancelled", currentStatus: "cancelled" };
    }
    if (vaultStatus !== "draft" && vaultStatus !== "active") {
      await client.query("ROLLBACK");
      return { error: "not_cancellable", currentStatus: vaultStatus };
    }

    await client.query("UPDATE vaults SET status = 'cancelled' WHERE id = $1", [
      id,
    ]);
    await client.query("COMMIT");

    const vault = await getVaultById(id);
    if (vault) {
      const orgId = vault.orgId;
      await invalidate(`vault:${id}`, orgId);
      await invalidate(`vault:${id}:org`);
      if (orgId) {
        await invalidatePrefix('vaults:', orgId);
        await invalidatePrefix('analytics:', orgId);
      }
      await invalidate('analytics:overall');
    }

    return { vault: vault!, previousStatus: vaultStatus };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
