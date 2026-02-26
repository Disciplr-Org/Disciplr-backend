import { Router } from "express";
import { healthRouter } from "./health.js";
import { vaultsRouter } from "./vaults.js";
import { authRouter } from "./auth.js";
import { adminRouter } from "./admin.js";
import { analyticsRouter } from "./analytics.js";
import { transactionsRouter } from "./transactions.js";
import { privacyRouter } from "./privacy.js";
import { apiKeysRouter } from "./apiKeys.js";

export const v1Router = Router();

v1Router.use("/health", healthRouter);
v1Router.use("/vaults", vaultsRouter);
v1Router.use("/auth", authRouter);
v1Router.use("/admin", adminRouter);
v1Router.use("/analytics", analyticsRouter);
v1Router.use("/transactions", transactionsRouter);
v1Router.use("/privacy", privacyRouter);
v1Router.use("/api-keys", apiKeysRouter);
