import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPgPool } from "../db/pool.js";
import type {
  CreateVaultInput,
  PersistedMilestone,
  PersistedVault,
} from "../types/vaults.js";

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

const memoryVaults: PersistedVault[] = [];
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
      createdAt: now,
    }),
  );

  if (!client) {
    const vault: PersistedVault = {
      id: vaultId,
      amount: input.amount,
      startDate: input.startDate,
      endDate: input.endDate,
      verifier: input.verifier,
      successDestination: input.destinations.success,
      failureDestination: input.destinations.failure,
      creator: input.creator ?? null,
      status: "draft",
      createdAt: now,
      milestones,
    };
    memoryVaults.push(vault);
    memoryVaultRevisions.set(vault.id, 0);
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
    }>(
      `INSERT INTO vaults
        (id, amount, start_date, end_date, verifier, success_destination, failure_destination, creator, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
        RETURNING id, amount::text, start_date, end_date, verifier, success_destination, failure_destination, creator, status, created_at`,
      [
        vaultId,
        input.amount,
        input.startDate,
        input.endDate,
        input.verifier,
        input.destinations.success,
        input.destinations.failure,
        input.creator ?? null,
      ],
    );

    for (const milestone of milestones) {
      await client.query(
        `INSERT INTO milestones
          (id, vault_id, title, description, due_date, amount, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          milestone.id,
          milestone.vaultId,
          milestone.title,
          milestone.description,
          milestone.dueDate,
          milestone.amount,
          milestone.sortOrder,
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
  }>(
    "SELECT id, amount::text, start_date, end_date, verifier, success_destination, failure_destination, creator, status, created_at FROM vaults ORDER BY created_at DESC",
  );

  const milestoneRows = await pool.query<{
    id: string;
    vault_id: string;
    title: string;
    description: string | null;
    due_date: string;
    amount: string;
    sort_order: number;
    created_at: string;
  }>(
    "SELECT id, vault_id, title, description, due_date, amount::text, sort_order, created_at FROM milestones ORDER BY sort_order ASC",
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
  }> = vaultRows.rows;

  return rows.map((row) => ({
    ...mapVaultRow(row),
    milestones: milestonesByVault.get(row.id) ?? [],
  }));
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
    return updatedVault;
  }

  const executor = customClient ?? pool;
  // Use PostgreSQL xmin as a revision token for optimistic locking (no schema change required).
  const query = `
    UPDATE vaults
    SET ${setParts.join(", ")}
    WHERE id = $1 AND xmin::text = $2
    RETURNING id, amount::text, start_date, end_date, verifier, success_destination, failure_destination, creator, status, created_at
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
    created_at: string;
  }>(
    "SELECT id, vault_id, title, description, due_date, amount::text, sort_order, created_at FROM milestones WHERE vault_id = $1 ORDER BY sort_order ASC",
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
      createdAt: milestone.created_at,
    }),
  );

  return {
    ...mapVaultRow(result.rows[0]),
    milestones,
  };
};

export const getVaultById = async (
  id: string,
): Promise<PersistedVault | null> => {
  const allVaults = await listVaults();
  return allVaults.find((vault) => vault.id === id) ?? null;
};

export const resetVaultStore = (): void => {
  memoryVaults.length = 0;
  memoryVaultRevisions.clear();
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

    if (vault.status === "cancelled") {
      return { error: "already_cancelled", currentStatus: "cancelled" };
    }
    if (vault.status !== "draft" && vault.status !== "active") {
      return { error: "not_cancellable", currentStatus: vault.status };
    }

    const previousStatus = vault.status;
    vault.status = "cancelled";
    const currentRevision = memoryVaultRevisions.get(id) ?? 0;
    memoryVaultRevisions.set(id, currentRevision + 1);
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
    return { vault: vault!, previousStatus: vaultStatus };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
