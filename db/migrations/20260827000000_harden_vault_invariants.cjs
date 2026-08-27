/**
 * Enforce the database invariants used by vault identity, lifecycle, verifier
 * assignment, milestone ordering, and transaction linkage.
 *
 * This migration deliberately performs a read-only preflight before adding any
 * strict object. Existing invalid data is reported with a remediation hint and
 * the migration stops before changing the schema. That makes a production
 * rollout observable and prevents a partially hardened database.
 *
 * Indexes are built concurrently because these tables are on request paths and
 * should not be blocked by a table-wide write lock during deployment.
 */

const MIGRATION = "harden_vault_invariants";

// CONCURRENTLY cannot run inside Knex's default transaction.
exports.config = { transaction: false };

async function constraintExists(knex, tableName, constraintName) {
  const { rows } = await knex.raw(
    `SELECT 1
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = ?
        AND c.conname = ?`,
    [tableName, constraintName],
  );
  return rows.length > 0;
}

async function indexExists(knex, indexName) {
  const { rows } = await knex.raw(
    `SELECT 1
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ?`,
    [indexName],
  );
  return rows.length > 0;
}

async function log(step, status, detail) {
  const entry = { migration: MIGRATION, step, status };
  if (detail) entry.detail = detail;
  // Do not include row values: identifiers and destinations can be sensitive.
  console.log(JSON.stringify(entry));
}

async function countRows(knex, sql) {
  const { rows } = await knex.raw(sql);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Find all known violations before any NOT VALID constraint or unique index is
 * created. The query shapes intentionally match the eventual constraints.
 */
async function assertCleanData(knex) {
  const checks = [
    {
      name: "empty vault identity",
      sql: `SELECT COUNT(*) AS count
              FROM vaults
             WHERE id IS NULL OR btrim(id) = ''`,
    },
    {
      name: "negative vault amount",
      sql: `SELECT COUNT(*) AS count
              FROM vaults
             WHERE amount < 0`,
    },
    {
      name: "invalid vault lifecycle dates",
      sql: `SELECT COUNT(*) AS count
              FROM vaults
             WHERE start_date > end_date`,
    },
    {
      name: "empty verifier assignment",
      sql: `SELECT COUNT(*) AS count
              FROM vaults
             WHERE verifier IS NULL OR btrim(verifier) = ''`,
    },
    {
      name: "negative milestone amount",
      sql: `SELECT COUNT(*) AS count
              FROM milestones
             WHERE amount < 0`,
    },
    {
      name: "negative milestone sort order",
      sql: `SELECT COUNT(*) AS count
              FROM milestones
             WHERE sort_order < 0`,
    },
    {
      name: "empty milestone verifier assignment",
      sql: `SELECT COUNT(*) AS count
              FROM milestones
             WHERE verifier_user_id IS NOT NULL
               AND btrim(verifier_user_id) = ''`,
    },
    {
      name: "invalid milestone approval threshold",
      sql: `SELECT COUNT(*) AS count
              FROM milestones
             WHERE approval_threshold < 1`,
    },
    {
      name: "negative transaction amount",
      sql: `SELECT COUNT(*) AS count
              FROM transactions
             WHERE amount < 0`,
    },
    {
      name: "negative Stellar ledger",
      sql: `SELECT COUNT(*) AS count
              FROM transactions
             WHERE stellar_ledger < 0`,
    },
    {
      name: "empty transaction vault linkage",
      sql: `SELECT COUNT(*) AS count
              FROM transactions
             WHERE vault_id IS NULL OR btrim(vault_id) = ''`,
    },
    {
      name: "duplicate milestone ordering",
      sql: `SELECT COUNT(*) AS count
              FROM (
                SELECT vault_id, sort_order
                  FROM milestones
                 GROUP BY vault_id, sort_order
                HAVING COUNT(*) > 1
              ) duplicates`,
    },
    {
      name: "orphan transaction linkage",
      sql: `SELECT COUNT(*) AS count
              FROM transactions tx
              LEFT JOIN vaults v ON v.id = tx.vault_id
             WHERE v.id IS NULL`,
    },
  ];

  const violations = [];
  for (const check of checks) {
    const count = await countRows(knex, check.sql);
    if (count > 0) violations.push(`${check.name}: ${count}`);
  }

  if (violations.length > 0) {
    throw new Error(
      `${MIGRATION} preflight failed. Remediate these existing rows before retrying: ${violations.join("; ")}`,
    );
  }
}

async function addValidatedCheck(knex, tableName, constraintName, expression) {
  if (await constraintExists(knex, tableName, constraintName)) return;
  await knex.raw(
    `ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${knex.raw(expression).toString()}) NOT VALID`,
    [tableName, constraintName],
  );
  await knex.raw("ALTER TABLE ?? VALIDATE CONSTRAINT ??", [
    tableName,
    constraintName,
  ]);
}

async function createConcurrentIndex(knex, indexName, tableName, columns) {
  if (await indexExists(knex, indexName)) return;
  const quotedColumns = columns
    .map(
      (column) =>
        `"${column.name}"${column.direction ? ` ${column.direction}` : ""}`,
    )
    .join(", ");
  await knex.raw(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${indexName}" ON "${tableName}" (${quotedColumns})`,
  );
}

exports.up = async function up(knex) {
  await log("preflight", "start");
  await assertCleanData(knex);
  await log("preflight", "success");

  // CHECK constraints are added NOT VALID then validated separately. This
  // keeps the operation explicit and gives operators a clear failing phase.
  await addValidatedCheck(
    knex,
    "vaults",
    "ck_vaults_id_nonempty",
    "id IS NOT NULL AND btrim(id) <> ''",
  );
  await addValidatedCheck(
    knex,
    "vaults",
    "ck_vaults_amount_nonnegative",
    "amount >= 0",
  );
  await addValidatedCheck(
    knex,
    "vaults",
    "ck_vaults_date_order",
    "start_date <= end_date",
  );
  await addValidatedCheck(
    knex,
    "vaults",
    "ck_vaults_verifier_nonempty",
    "verifier IS NOT NULL AND btrim(verifier) <> ''",
  );

  await addValidatedCheck(
    knex,
    "milestones",
    "ck_milestones_amount_nonnegative",
    "amount >= 0",
  );
  await addValidatedCheck(
    knex,
    "milestones",
    "ck_milestones_sort_order_nonnegative",
    "sort_order >= 0",
  );
  await addValidatedCheck(
    knex,
    "milestones",
    "ck_milestones_verifier_nonempty",
    "verifier_user_id IS NULL OR btrim(verifier_user_id) <> ''",
  );
  await addValidatedCheck(
    knex,
    "milestones",
    "ck_milestones_threshold_positive",
    "approval_threshold >= 1",
  );

  await addValidatedCheck(
    knex,
    "transactions",
    "ck_transactions_amount_nonnegative",
    "amount >= 0",
  );
  await addValidatedCheck(
    knex,
    "transactions",
    "ck_transactions_ledger_nonnegative",
    "stellar_ledger >= 0",
  );
  await addValidatedCheck(
    knex,
    "transactions",
    "ck_transactions_vault_id_nonempty",
    "vault_id IS NOT NULL AND btrim(vault_id) <> ''",
  );

  // A vault can have only one milestone at a given position. Build the unique
  // index online first, then attach it as a named constraint for introspection.
  const orderingIndex = "uq_milestones_vault_sort_order";
  if (!(await constraintExists(knex, "milestones", orderingIndex))) {
    await createConcurrentIndex(knex, orderingIndex, "milestones", [
      { name: "vault_id" },
      { name: "sort_order" },
    ]);
    if (!(await constraintExists(knex, "milestones", orderingIndex))) {
      await knex.raw("ALTER TABLE ?? ADD CONSTRAINT ?? UNIQUE USING INDEX ??", [
        "milestones",
        orderingIndex,
        orderingIndex,
      ]);
    }
  }

  // Cover the production access patterns without replacing existing indexes:
  // creator/status listings, verifier lifecycle work, milestone dashboards,
  // and transaction history scoped to a vault.
  await createConcurrentIndex(
    knex,
    "idx_vaults_creator_status_created",
    "vaults",
    [
      { name: "creator" },
      { name: "status" },
      { name: "created_at", direction: "DESC" },
    ],
  );
  await createConcurrentIndex(
    knex,
    "idx_vaults_verifier_status_end_date",
    "vaults",
    [{ name: "verifier" }, { name: "status" }, { name: "end_date" }],
  );
  await createConcurrentIndex(
    knex,
    "idx_milestones_vault_status_due_date",
    "milestones",
    [{ name: "vault_id" }, { name: "status" }, { name: "due_date" }],
  );
  await createConcurrentIndex(
    knex,
    "idx_transactions_vault_type_ledger",
    "transactions",
    [
      { name: "vault_id" },
      { name: "type" },
      { name: "stellar_ledger", direction: "DESC" },
    ],
  );

  await log("complete", "success", {
    constraints: 11,
    indexes: 5,
    preflight: "clean data verified before schema hardening",
  });
};

exports.down = async function down(knex) {
  await log("rollback", "start");

  // Dropping the attached UNIQUE constraint also drops its backing index.
  if (
    await constraintExists(knex, "milestones", "uq_milestones_vault_sort_order")
  ) {
    await knex.raw("ALTER TABLE ?? DROP CONSTRAINT ??", [
      "milestones",
      "uq_milestones_vault_sort_order",
    ]);
  } else if (await indexExists(knex, "uq_milestones_vault_sort_order")) {
    await knex.raw(
      'DROP INDEX CONCURRENTLY IF EXISTS "uq_milestones_vault_sort_order"',
    );
  }

  const checks = [
    ["vaults", "ck_vaults_id_nonempty"],
    ["vaults", "ck_vaults_amount_nonnegative"],
    ["vaults", "ck_vaults_date_order"],
    ["vaults", "ck_vaults_verifier_nonempty"],
    ["milestones", "ck_milestones_amount_nonnegative"],
    ["milestones", "ck_milestones_sort_order_nonnegative"],
    ["milestones", "ck_milestones_verifier_nonempty"],
    ["milestones", "ck_milestones_threshold_positive"],
    ["transactions", "ck_transactions_amount_nonnegative"],
    ["transactions", "ck_transactions_ledger_nonnegative"],
    ["transactions", "ck_transactions_vault_id_nonempty"],
  ];
  for (const [tableName, constraintName] of checks) {
    if (await constraintExists(knex, tableName, constraintName)) {
      await knex.raw("ALTER TABLE ?? DROP CONSTRAINT ??", [
        tableName,
        constraintName,
      ]);
    }
  }

  const indexes = [
    ["vaults", "idx_vaults_creator_status_created"],
    ["vaults", "idx_vaults_verifier_status_end_date"],
    ["milestones", "idx_milestones_vault_status_due_date"],
    ["transactions", "idx_transactions_vault_type_ledger"],
  ];
  for (const [, indexName] of indexes) {
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
  }

  await log("rollback", "success");
};
