import { CorsOptions } from "cors";
import { config } from "./index.js";

const isWildcard = config.corsOrigins === "*";

/**
 * CORS configuration implementing strict allowlist behavior:
 * - Allows server-to-server requests (no Origin header)
 * - Blocks 'null' Origin (untrusted)
 * - Allows origins in allowlist (or all if wildcard)
 * - Disables credentials when wildcard is used
 */
export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Block 'null' origin (untrusted)
    if (origin === "null") {
      console.log(
        JSON.stringify({
          level: "warn",
          event: "security.cors_rejected",
          service: config.serviceName,
          origin,
          timestamp: new Date().toISOString(),
        }),
      );
      callback(null, false);
      return;
    }

    // Allow server-to-server requests (no Origin header)
    if (!origin) {
      callback(null, true);
      return;
    }

    // Wildcard: allow all origins, echo request origin
    if (isWildcard) {
      callback(null, true);
      return;
    }

    // Check allowlist
    const allowedOrigins = config.corsOrigins as string[]
    const normalizedOrigin = origin.replace(/\/+$/, '')
    if (allowedOrigins.includes(normalizedOrigin)) {
      callback(null, true);
    } else {
      console.log(
        JSON.stringify({
          level: "warn",
          event: "security.cors_rejected",
          service: config.serviceName,
          origin,
          timestamp: new Date().toISOString(),
        }),
      );
      callback(null, false);
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "idempotency-key"],
  credentials: isWildcard ? false : true,
};
