import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ALLOWLIST,
  extractEnvExampleKeys,
  extractEnvTsKeys,
  findMissingEnvExampleKeys,
  runCli,
} from "../check-env-example.mjs";

const SAMPLE_ENV_TS = `
import { z } from "zod";

const positiveInt = (fallback: number) => z.string().optional();
const httpUrl = () => z.string();

export const envSchema = z
  .object({
    // Core
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: positiveInt(3000),
    DATABASE_URL: z.string().min(1),
    SOROBAN_RPC_URL: httpUrl().optional(),
    // COMMENTED_OUT: z.string().optional(),
    /* BLOCK_COMMENTED: z.string().optional(), */
    JWT_KEYS: z
      .string()
      .optional()
      .transform((val) => {
        if (!val) return [];
        const NESTED_OBJ = { INNER_KEY: 123 };
        return [NESTED_OBJ];
      }),
    LOG_LEVEL: z.enum(["debug", "info"]).default("info"),
  })
  .superRefine((data, ctx) => {
    const OUTSIDE_KEY = { SUPER_REFINE_KEY: true };
    void OUTSIDE_KEY;
  });

export const OTHER_CONST = {
  NOT_AN_ENV_VAR: "ignored",
};
`;

const SAMPLE_ENV_EXAMPLE = `
# Core settings
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://localhost:5432/app
# Optional commented-out variable
# SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
# Example prose: PROSE_KEY=should-not-match
export JWT_KEYS=[]
LOG_LEVEL=info
NODE_ENV=production
`;

describe("extractEnvTsKeys", () => {
  it("extracts all top-level keys from z.object including helper wrappers and multiline chains", () => {
    const keys = extractEnvTsKeys(SAMPLE_ENV_TS);
    assert.deepStrictEqual(keys, [
      "DATABASE_URL",
      "JWT_KEYS",
      "LOG_LEVEL",
      "NODE_ENV",
      "PORT",
      "SOROBAN_RPC_URL",
    ]);
  });

  it("ignores commented-out keys and keys outside z.object or inside nested blocks", () => {
    const keys = extractEnvTsKeys(SAMPLE_ENV_TS);
    assert.ok(!keys.includes("COMMENTED_OUT"));
    assert.ok(!keys.includes("BLOCK_COMMENTED"));
    assert.ok(!keys.includes("INNER_KEY"));
    assert.ok(!keys.includes("SUPER_REFINE_KEY"));
    assert.ok(!keys.includes("NOT_AN_ENV_VAR"));
  });
});

describe("extractEnvExampleKeys", () => {
  it("extracts active, commented-out, and exported keys while ignoring prose comments", () => {
    const keys = extractEnvExampleKeys(SAMPLE_ENV_EXAMPLE);
    assert.deepStrictEqual(keys, [
      "DATABASE_URL",
      "JWT_KEYS",
      "LOG_LEVEL",
      "NODE_ENV",
      "PORT",
      "SOROBAN_RPC_URL",
    ]);
  });
});

describe("findMissingEnvExampleKeys", () => {
  it("returns no missing keys when all env.ts variables are documented", () => {
    const result = findMissingEnvExampleKeys({
      envTsSource: SAMPLE_ENV_TS,
      envExampleSource: SAMPLE_ENV_EXAMPLE,
    });
    assert.deepStrictEqual(result.missingKeys, []);
  });

  it("reports missing keys in sorted order", () => {
    const partialExample = `
NODE_ENV=development
DATABASE_URL=postgres://localhost:5432/app
`;
    const result = findMissingEnvExampleKeys({
      envTsSource: SAMPLE_ENV_TS,
      envExampleSource: partialExample,
    });
    assert.deepStrictEqual(result.missingKeys, [
      "JWT_KEYS",
      "LOG_LEVEL",
      "PORT",
      "SOROBAN_RPC_URL",
    ]);
  });

  it("honours an explicit allowlist", () => {
    const partialExample = `
NODE_ENV=development
DATABASE_URL=postgres://localhost:5432/app
`;
    const result = findMissingEnvExampleKeys({
      envTsSource: SAMPLE_ENV_TS,
      envExampleSource: partialExample,
      allowlist: ["JWT_KEYS", "PORT"],
    });
    assert.deepStrictEqual(result.missingKeys, ["LOG_LEVEL", "SOROBAN_RPC_URL"]);
  });

  it("has an empty default ALLOWLIST", () => {
    assert.equal(ALLOWLIST.size, 0);
  });
});

describe("runCli", () => {
  it("exits 0 when all variables are documented", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-env-ok-"));
    try {
      const envTsPath = path.join(tmpDir, "env.ts");
      const envExamplePath = path.join(tmpDir, ".env.example");
      fs.writeFileSync(envTsPath, SAMPLE_ENV_TS, "utf8");
      fs.writeFileSync(envExamplePath, SAMPLE_ENV_EXAMPLE, "utf8");

      const out = [];
      const err = [];
      const code = runCli({
        envTsPath,
        envExamplePath,
        stdout: (msg) => out.push(msg),
        stderr: (msg) => err.push(msg),
      });

      assert.equal(code, 0);
      assert.equal(err.length, 0);
      assert.match(out.join("\n"), /OK: all 6 environment variables/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits 1 and lists missing keys on stderr", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-env-fail-"));
    try {
      const envTsPath = path.join(tmpDir, "env.ts");
      const envExamplePath = path.join(tmpDir, ".env.example");
      fs.writeFileSync(envTsPath, SAMPLE_ENV_TS, "utf8");
      fs.writeFileSync(envExamplePath, "NODE_ENV=development\n", "utf8");

      const out = [];
      const err = [];
      const code = runCli({
        envTsPath,
        envExamplePath,
        stdout: (msg) => out.push(msg),
        stderr: (msg) => err.push(msg),
      });

      assert.equal(code, 1);
      assert.equal(out.length, 0);
      const stderrText = err.join("\n");
      assert.match(stderrText, /Missing 5 environment variable\(s\)/);
      assert.match(stderrText, /- DATABASE_URL/);
      assert.match(stderrText, /- JWT_KEYS/);
      assert.match(stderrText, /- LOG_LEVEL/);
      assert.match(stderrText, /- PORT/);
      assert.match(stderrText, /- SOROBAN_RPC_URL/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
