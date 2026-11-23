import { describe, expect, it } from "@jest/globals";
import { Buffer } from "node:buffer";
import fc from "fast-check";
import { StrKey } from "@stellar/stellar-sdk";
import {
  VAULT_AMOUNT_MAX,
  VAULT_AMOUNT_MIN,
  VAULT_MILESTONES_MAX,
  VAULT_MILESTONES_MIN,
  createVaultSchema,
  parseMilestoneInput,
} from "./vaultValidation.js";

/**
 * Property tests for the arithmetic and schedule invariants at the API
 * boundary. Every property uses a fixed seed and a bounded run count so CI is
 * reproducible while fast-check still provides shrinking diagnostics.
 */

const PROPERTY_SEED = 1509;
const PROPERTY_RUNS = 100;
const SCALE = 10_000_000n;

const validAddress = (fill: number): string =>
  StrKey.encodeEd25519PublicKey(Buffer.alloc(32, fill));

const CREATOR = validAddress(1);
const VERIFIER = validAddress(2);
const SUCCESS_DESTINATION = validAddress(3);
const FAILURE_DESTINATION = validAddress(4);

type ScheduleCase = {
  vaultAmount: number;
  milestoneAmounts: number[];
};

type DecimalScheduleCase = {
  vaultUnits: bigint;
  milestoneUnits: bigint[];
};

const propertyOptions = {
  seed: PROPERTY_SEED,
  numRuns: PROPERTY_RUNS,
  endOnFailure: true,
};

const isoDateForDay = (day: number): string =>
  `2026-02-${String(Math.max(1, Math.min(28, day))).padStart(2, "0")}T00:00:00.000Z`;

const integerScheduleArbitrary: fc.Arbitrary<ScheduleCase> = fc
  .record({
    // At least twenty units are needed to give every generated milestone one
    // unit while preserving the total <= vault amount invariant.
    vaultAmount: fc.integer({ min: 20, max: VAULT_AMOUNT_MAX }),
    weights: fc.array(fc.integer({ min: 1, max: 100_000 }), {
      minLength: VAULT_MILESTONES_MIN,
      maxLength: VAULT_MILESTONES_MAX,
    }),
  })
  .map(({ vaultAmount, weights }) => {
    let remaining = vaultAmount;
    const milestoneAmounts: number[] = [];

    for (let index = 0; index < weights.length; index += 1) {
      const slotsAfterThis = weights.length - index - 1;
      if (slotsAfterThis === 0) {
        milestoneAmounts.push(remaining);
        break;
      }

      const maximumForThis = remaining - slotsAfterThis;
      const amount = 1 + (weights[index] % maximumForThis);
      milestoneAmounts.push(amount);
      remaining -= amount;
    }

    return { vaultAmount, milestoneAmounts };
  });

const formatScaledAmount = (units: bigint): string => {
  const whole = units / SCALE;
  const fraction = (units % SCALE).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
};

const decimalScheduleArbitrary: fc.Arbitrary<DecimalScheduleCase> = fc
  .record({
    // Keep the generated values above the schema's minimum after conversion,
    // while still exercising seven decimal places at the boundary.
    vaultUnits: fc.bigInt({ min: SCALE * 20n, max: SCALE * 1_000_000n }),
    weights: fc.array(fc.integer({ min: 1, max: 100_000 }), {
      minLength: 1,
      maxLength: 12,
    }),
  })
  .map(({ vaultUnits, weights }) => {
    let remaining = vaultUnits;
    const milestoneUnits: bigint[] = [];

    for (let index = 0; index < weights.length; index += 1) {
      const slotsAfterThis = weights.length - index - 1;
      if (slotsAfterThis === 0) {
        milestoneUnits.push(remaining);
        break;
      }

      const minimumReserved = BigInt(slotsAfterThis) * SCALE;
      const maximumForThis = remaining - minimumReserved;
      const amount = SCALE + (BigInt(weights[index]) % maximumForThis);
      milestoneUnits.push(amount);
      remaining -= amount;
    }

    return { vaultUnits, milestoneUnits };
  });

const buildVaultInput = (
  amount: unknown,
  milestoneAmounts: Array<string | number>,
  overrides: Record<string, unknown> = {},
) => ({
  amount,
  startDate: "2026-01-01T00:00:00.000Z",
  endDate: "2027-01-01T00:00:00.000Z",
  verifier: VERIFIER,
  destinations: {
    success: SUCCESS_DESTINATION,
    failure: FAILURE_DESTINATION,
  },
  creator: CREATOR,
  milestones: milestoneAmounts.map((milestoneAmount, index) => ({
    title: `Milestone ${index + 1}`,
    description: `Generated schedule case ${index + 1}`,
    dueDate: isoDateForDay(index + 1),
    amount: milestoneAmount,
  })),
  ...overrides,
});

const parseVault = (input: unknown) => createVaultSchema.safeParse(input);

const issueMessages = (result: ReturnType<typeof parseVault>): string[] =>
  result.success ? [] : result.error.issues.map((issue) => issue.message);

const assertValidSchedule = (schedule: ScheduleCase): void => {
  const result = parseVault(
    buildVaultInput(schedule.vaultAmount, schedule.milestoneAmounts),
  );
  if (!result.success) {
    throw new Error(
      `valid schedule rejected: ${JSON.stringify(schedule)}; issues=${JSON.stringify(issueMessages(result))}`,
    );
  }
  expect(result.data.milestones).toHaveLength(schedule.milestoneAmounts.length);
};

const assertDecimalSchedule = (schedule: DecimalScheduleCase): void => {
  const result = parseVault(
    buildVaultInput(
      formatScaledAmount(schedule.vaultUnits),
      schedule.milestoneUnits.map(formatScaledAmount),
    ),
  );
  if (!result.success) {
    throw new Error(
      `decimal schedule rejected: ${JSON.stringify({
        vaultUnits: schedule.vaultUnits.toString(),
        milestoneUnits: schedule.milestoneUnits.map((unit) => unit.toString()),
      })}; issues=${JSON.stringify(issueMessages(result))}`,
    );
  }
};

describe("createVaultSchema amount and schedule invariants", () => {
  it("accepts every generated schedule whose allocation is bounded by the vault", () => {
    fc.assert(
      fc.property(integerScheduleArbitrary, (schedule) => {
        const total = schedule.milestoneAmounts.reduce(
          (sum, amount) => sum + amount,
          0,
        );
        expect(total).toBeLessThanOrEqual(schedule.vaultAmount);
        expect(schedule.milestoneAmounts.every((amount) => amount > 0)).toBe(
          true,
        );
        assertValidSchedule(schedule);
      }),
      propertyOptions,
    );
  });

  it("preserves acceptance when a valid schedule is reordered", () => {
    fc.assert(
      fc.property(integerScheduleArbitrary, (schedule) => {
        const reordered = [...schedule.milestoneAmounts].reverse();
        assertValidSchedule({ ...schedule, milestoneAmounts: reordered });
      }),
      { ...propertyOptions, seed: PROPERTY_SEED + 1 },
    );
  });

  it("accepts a schedule with exactly the vault amount allocated", () => {
    fc.assert(
      fc.property(integerScheduleArbitrary, (schedule) => {
        const total = schedule.milestoneAmounts.reduce(
          (sum, amount) => sum + amount,
          0,
        );
        expect(total).toBe(schedule.vaultAmount);
        assertValidSchedule(schedule);
      }),
      { ...propertyOptions, seed: PROPERTY_SEED + 2 },
    );
  });

  it("rejects a schedule that exceeds the vault by one smallest unit", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: VAULT_AMOUNT_MIN, max: VAULT_AMOUNT_MAX - 1 }),
        (vaultAmount) => {
          const result = parseVault(
            buildVaultInput(vaultAmount, [vaultAmount + 1]),
          );
          expect(result.success).toBe(false);
          expect(issueMessages(result)).toContain(
            "Total milestone amount cannot exceed vault amount",
          );
        },
      ),
      { ...propertyOptions, seed: PROPERTY_SEED + 3 },
    );
  });

  it("rejects every negative generated vault amount", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: -1 }), (amount) => {
        const result = parseVault(buildVaultInput(amount, [1]));
        expect(result.success).toBe(false);
        expect(issueMessages(result)).toContain("must be a positive number");
      }),
      { ...propertyOptions, seed: PROPERTY_SEED + 4 },
    );
  });

  it("rejects zero and non-finite amounts without throwing", () => {
    const adversarialAmounts: unknown[] = [
      0,
      -0,
      "0",
      "0.0000000",
      -1,
      "-999999999",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "",
      "not-a-number",
      "  ",
      null,
      undefined,
    ];

    for (const amount of adversarialAmounts) {
      expect(() => parseVault(buildVaultInput(amount, [1]))).not.toThrow();
      expect(parseVault(buildVaultInput(amount, [1])).success).toBe(false);
    }
  });

  it("rejects amounts above the practical API bound", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: VAULT_AMOUNT_MAX + 1, max: 2_000_000_000 }),
        (amount) => {
          const result = parseVault(buildVaultInput(amount, [1]));
          expect(result.success).toBe(false);
          expect(issueMessages(result)).toContain(
            `must be between ${VAULT_AMOUNT_MIN} and ${VAULT_AMOUNT_MAX.toLocaleString()}`,
          );
        },
      ),
      { ...propertyOptions, seed: PROPERTY_SEED + 5 },
    );
  });

  it("accepts exact lower and upper supported amount boundaries", () => {
    expect(
      parseVault(buildVaultInput(VAULT_AMOUNT_MIN, [VAULT_AMOUNT_MIN])).success,
    ).toBe(true);
    expect(
      parseVault(buildVaultInput(VAULT_AMOUNT_MAX, [VAULT_AMOUNT_MAX])).success,
    ).toBe(true);
  });

  it("accepts generated schedules with seven decimal places deterministically", () => {
    fc.assert(
      fc.property(decimalScheduleArbitrary, (schedule) => {
        const total = schedule.milestoneUnits.reduce(
          (sum, amount) => sum + amount,
          0n,
        );
        expect(total).toBe(schedule.vaultUnits);
        assertDecimalSchedule(schedule);
        assertDecimalSchedule(schedule);
      }),
      { ...propertyOptions, seed: PROPERTY_SEED + 6 },
    );
  });

  it("rejects a due date before the vault start for every generated amount", () => {
    fc.assert(
      fc.property(integerScheduleArbitrary, (schedule) => {
        const result = parseVault(
          buildVaultInput(schedule.vaultAmount, schedule.milestoneAmounts, {
            milestones: schedule.milestoneAmounts.map((amount, index) => ({
              title: `Milestone ${index + 1}`,
              dueDate: "2025-12-31T23:59:59.999Z",
              amount,
            })),
          }),
        );
        expect(result.success).toBe(false);
        expect(issueMessages(result)).toContain("cannot be before startDate");
      }),
      { ...propertyOptions, seed: PROPERTY_SEED + 7 },
    );
  });

  it("rejects schedules whose end date is not strictly after start date", () => {
    fc.assert(
      fc.property(integerScheduleArbitrary, (schedule) => {
        const result = parseVault(
          buildVaultInput(schedule.vaultAmount, schedule.milestoneAmounts, {
            endDate: "2026-01-01T00:00:00.000Z",
          }),
        );
        expect(result.success).toBe(false);
        expect(issueMessages(result)).toContain(
          "must be greater than startDate",
        );
      }),
      { ...propertyOptions, seed: PROPERTY_SEED + 8 },
    );
  });

  it("rejects more than the supported number of milestones", () => {
    const amounts = Array.from({ length: VAULT_MILESTONES_MAX + 1 }, () => 1);
    const result = parseVault(
      buildVaultInput(VAULT_MILESTONES_MAX + 1, amounts),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain(
      `must contain at most ${VAULT_MILESTONES_MAX} items`,
    );
  });

  it("rejects an empty milestone schedule", () => {
    const result = parseVault(buildVaultInput(100, []));
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain("must contain at least one item");
  });

  it("rejects malformed milestone shapes rather than coercing missing fields", () => {
    const malformedSchedules: unknown[] = [
      { title: "missing amount", dueDate: isoDateForDay(1) },
      { title: "missing date", amount: "10" },
      { title: "", dueDate: isoDateForDay(1), amount: "10" },
      { title: "   ", dueDate: isoDateForDay(1), amount: "10" },
      { title: "valid", dueDate: "not-a-date", amount: "10" },
      null,
      "milestone",
      42,
    ];

    for (const milestone of malformedSchedules) {
      expect(() => parseMilestoneInput(milestone)).not.toThrow();
      expect(parseMilestoneInput(milestone).success).toBe(false);
    }
  });

  it("keeps malformed numeric strings out of both root and child amount paths", () => {
    const malformedNumbers = [
      "1e309",
      "Infinity",
      "0x10",
      "1_000",
      "1,000",
      "NaN",
    ];
    for (const amount of malformedNumbers) {
      const root = parseVault(buildVaultInput(amount, ["1"]));
      const child = parseMilestoneInput({
        title: "Malformed numeric test",
        dueDate: isoDateForDay(1),
        amount,
      });
      expect(root.success).toBe(false);
      expect(child.success).toBe(false);
    }
  });

  it("rejects precision beyond the seven-decimal settlement boundary", () => {
    const tooPreciseAmounts = [
      "1.00000001",
      "10.12345678",
      "999999999.99999999",
    ];
    for (const amount of tooPreciseAmounts) {
      const root = parseVault(buildVaultInput(amount, ["1"]));
      const child = parseMilestoneInput({
        title: "Precision boundary",
        dueDate: isoDateForDay(1),
        amount,
      });
      expect(root.success).toBe(false);
      expect(child.success).toBe(false);
    }
  });

  it("reports the same issue set for repeated parsing of a failing case", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: VAULT_AMOUNT_MAX + 1, max: 2_000_000_000 }),
        (amount) => {
          const input = buildVaultInput(amount, [1]);
          const first = parseVault(input);
          const second = parseVault(input);
          expect(issueMessages(first)).toEqual(issueMessages(second));
        },
      ),
      { ...propertyOptions, seed: PROPERTY_SEED + 9 },
    );
  });

  it("keeps allocation checking independent of milestone ordering", () => {
    fc.assert(
      fc.property(integerScheduleArbitrary, (schedule) => {
        const shuffled = [...schedule.milestoneAmounts].sort((a, b) => b - a);
        const originalResult = parseVault(
          buildVaultInput(schedule.vaultAmount, schedule.milestoneAmounts),
        );
        const sortedResult = parseVault(
          buildVaultInput(schedule.vaultAmount, shuffled),
        );
        expect(sortedResult.success).toBe(originalResult.success);
      }),
      { ...propertyOptions, seed: PROPERTY_SEED + 10 },
    );
  });

  it("does not accept invalid destination or verifier address shapes", () => {
    const invalidFields = [
      ["verifier", "GINVALID"],
      ["destinations.success", "C" + "A".repeat(55)],
      ["destinations.failure", "not-an-address"],
      ["creator", ""],
    ] as const;

    for (const [field, value] of invalidFields) {
      const input = buildVaultInput(100, [100]);
      if (field === "destinations.success") input.destinations.success = value;
      else if (field === "destinations.failure")
        input.destinations.failure = value;
      else if (field === "verifier") input.verifier = value;
      else input.creator = value;
      expect(parseVault(input).success).toBe(false);
    }
  });
});

describe("milestone amount property boundaries", () => {
  it("accepts every positive amount within the shared bound", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: VAULT_AMOUNT_MIN, max: VAULT_AMOUNT_MAX }),
        (amount) => {
          const result = parseMilestoneInput({
            title: "Boundary milestone",
            dueDate: isoDateForDay(1),
            amount: String(amount),
          });
          if (!result.success) {
            throw new Error(
              `positive amount rejected: amount=${amount}; issues=${JSON.stringify(result.error.issues)}`,
            );
          }
        },
      ),
      { ...propertyOptions, seed: PROPERTY_SEED + 11 },
    );
  });

  it("rejects every generated amount just outside the upper bound", () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: VAULT_AMOUNT_MAX + 1,
          max: VAULT_AMOUNT_MAX + 10_000,
        }),
        (amount) => {
          expect(
            parseMilestoneInput({
              title: "Too large",
              dueDate: isoDateForDay(1),
              amount: String(amount),
            }).success,
          ).toBe(false);
        },
      ),
      { ...propertyOptions, seed: PROPERTY_SEED + 12 },
    );
  });

  it("rejects every generated amount just below the lower bound", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: VAULT_AMOUNT_MIN - 1 }),
        (amount) => {
          expect(
            parseMilestoneInput({
              title: "Too small",
              dueDate: isoDateForDay(1),
              amount: String(amount),
            }).success,
          ).toBe(false);
        },
      ),
      { ...propertyOptions, seed: PROPERTY_SEED + 13 },
    );
  });
});
