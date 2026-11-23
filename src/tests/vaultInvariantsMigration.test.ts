import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const migrationPath = path.join(
  process.cwd(),
  "db",
  "migrations",
  "20260827000000_harden_vault_invariants.cjs",
);

const migrationSource = fs.readFileSync(migrationPath, "utf8");

describe("vault invariant migration contract", () => {
  it("is an explicitly non-transactional online migration", () => {
    expect(migrationSource).toContain(
      "exports.config = { transaction: false }",
    );
    expect(migrationSource).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS",
    );
    expect(migrationSource).toContain("DROP INDEX CONCURRENTLY IF EXISTS");
  });

  it("preflights every invariant before adding schema objects", () => {
    const preflightStart = migrationSource.indexOf(
      'await log("preflight", "start")',
    );
    const firstConstraint = migrationSource.indexOf("await addValidatedCheck(");
    const firstIndex = migrationSource.indexOf("await createConcurrentIndex(");

    expect(preflightStart).toBeGreaterThanOrEqual(0);
    expect(firstConstraint).toBeGreaterThan(preflightStart);
    expect(firstIndex).toBeGreaterThan(preflightStart);
    expect(migrationSource).toContain("await assertCleanData(knex)");
    expect(migrationSource).toContain(
      "Remediate these existing rows before retrying",
    );
  });

  it.each([
    ["empty vault identity", "WHERE id IS NULL OR btrim(id) = ''"],
    ["negative vault amount", "WHERE amount < 0"],
    ["invalid lifecycle dates", "WHERE start_date > end_date"],
    [
      "empty verifier assignment",
      "WHERE verifier IS NULL OR btrim(verifier) = ''",
    ],
    ["negative milestone amount", "WHERE amount < 0"],
    ["negative milestone order", "WHERE sort_order < 0"],
    [
      "empty milestone verifier assignment",
      "WHERE verifier_user_id IS NOT NULL",
    ],
    ["invalid approval threshold", "WHERE approval_threshold < 1"],
    ["negative transaction amount", "WHERE amount < 0"],
    ["negative Stellar ledger", "WHERE stellar_ledger < 0"],
    [
      "empty transaction vault linkage",
      "WHERE vault_id IS NULL OR btrim(vault_id) = ''",
    ],
    ["duplicate milestone positions", "GROUP BY vault_id, sort_order"],
    ["orphan transaction linkage", "LEFT JOIN vaults v ON v.id = tx.vault_id"],
  ])("contains a preflight for %s", (_name, sqlFragment) => {
    expect(migrationSource).toContain(sqlFragment);
  });

  it("maps each strict check to the table and policy it protects", () => {
    const expectedChecks = [
      ["vaults", "ck_vaults_id_nonempty", "id IS NOT NULL AND btrim(id) <> ''"],
      ["vaults", "ck_vaults_amount_nonnegative", "amount >= 0"],
      ["vaults", "ck_vaults_date_order", "start_date <= end_date"],
      [
        "vaults",
        "ck_vaults_verifier_nonempty",
        "verifier IS NOT NULL AND btrim(verifier) <> ''",
      ],
      ["milestones", "ck_milestones_amount_nonnegative", "amount >= 0"],
      ["milestones", "ck_milestones_sort_order_nonnegative", "sort_order >= 0"],
      [
        "milestones",
        "ck_milestones_verifier_nonempty",
        "verifier_user_id IS NULL OR btrim(verifier_user_id) <> ''",
      ],
      [
        "milestones",
        "ck_milestones_threshold_positive",
        "approval_threshold >= 1",
      ],
      ["transactions", "ck_transactions_amount_nonnegative", "amount >= 0"],
      [
        "transactions",
        "ck_transactions_ledger_nonnegative",
        "stellar_ledger >= 0",
      ],
      [
        "transactions",
        "ck_transactions_vault_id_nonempty",
        "vault_id IS NOT NULL AND btrim(vault_id) <> ''",
      ],
    ];

    for (const [table, name, expression] of expectedChecks) {
      expect(migrationSource).toContain(`"${table}",`);
      expect(migrationSource).toContain(`"${name}"`);
      expect(migrationSource).toContain(`"${expression}"`);
    }
    expect(expectedChecks).toHaveLength(11);
  });

  it("protects milestone identity with a unique vault position", () => {
    expect(migrationSource).toContain(
      'const orderingIndex = "uq_milestones_vault_sort_order"',
    );
    expect(migrationSource).toContain('{ name: "vault_id" }');
    expect(migrationSource).toContain('{ name: "sort_order" }');
    expect(migrationSource).toContain("UNIQUE USING INDEX");
    expect(migrationSource).toContain("duplicate milestone ordering");
  });

  it.each([
    ["idx_vaults_creator_status_created", "vaults"],
    ["idx_vaults_verifier_status_end_date", "vaults"],
    ["idx_milestones_vault_status_due_date", "milestones"],
    ["idx_transactions_vault_type_ledger", "transactions"],
  ])("defines the production index %s on %s", (indexName, tableName) => {
    expect(migrationSource).toContain(`"${indexName}"`);
    expect(migrationSource).toContain(`"${tableName}"`);
  });

  it("uses descending order for cursor and newest-first query patterns", () => {
    expect(migrationSource).toContain(
      '{ name: "created_at", direction: "DESC" }',
    );
    expect(migrationSource).toContain(
      '{ name: "stellar_ledger", direction: "DESC" }',
    );
  });

  it("makes every new object reversible", () => {
    const rollbackStart = migrationSource.indexOf(
      "exports.down = async function down",
    );
    const upSection = migrationSource.slice(0, rollbackStart);
    const downSection = migrationSource.slice(rollbackStart);
    const objectNames = [
      "uq_milestones_vault_sort_order",
      "ck_vaults_id_nonempty",
      "ck_vaults_amount_nonnegative",
      "ck_vaults_date_order",
      "ck_vaults_verifier_nonempty",
      "ck_milestones_amount_nonnegative",
      "ck_milestones_sort_order_nonnegative",
      "ck_milestones_verifier_nonempty",
      "ck_milestones_threshold_positive",
      "ck_transactions_amount_nonnegative",
      "ck_transactions_ledger_nonnegative",
      "ck_transactions_vault_id_nonempty",
      "idx_vaults_creator_status_created",
      "idx_vaults_verifier_status_end_date",
      "idx_milestones_vault_status_due_date",
      "idx_transactions_vault_type_ledger",
    ];

    expect(rollbackStart).toBeGreaterThan(0);
    for (const objectName of objectNames) {
      expect(upSection).toContain(objectName);
      expect(downSection).toContain(objectName);
    }
  });

  it("keeps preflight diagnostics free of row values", () => {
    expect(migrationSource).toContain("Do not include row values");
    expect(migrationSource).not.toContain("console.log(rows)");
    expect(migrationSource).not.toContain("console.log(row)");
    expect(migrationSource).not.toContain("SELECT * FROM vaults");
  });

  it("records operator-visible phases without leaking sensitive data", () => {
    expect(migrationSource).toContain('await log("preflight", "start")');
    expect(migrationSource).toContain('await log("preflight", "success")');
    expect(migrationSource).toContain('await log("complete", "success"');
    expect(migrationSource).toContain('await log("rollback", "start")');
    expect(migrationSource).toContain('await log("rollback", "success")');
  });

  it("declares the exact object count in its completion audit event", () => {
    expect(migrationSource).toContain("constraints: 11");
    expect(migrationSource).toContain("indexes: 5");
    expect(migrationSource).toContain(
      'preflight: "clean data verified before schema hardening"',
    );
  });

  it("does not silently repair business rows during migration", () => {
    const upSection = migrationSource.slice(
      0,
      migrationSource.indexOf("exports.down = async function down"),
    );
    expect(upSection).not.toContain("UPDATE vaults");
    expect(upSection).not.toContain("UPDATE milestones");
    expect(upSection).not.toContain("DELETE FROM");
  });
});
