FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ git

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
# The Prisma client postinstall runs before prisma/schema.prisma is copied in,
# so it only leaves a stub behind — generate the real client before building.
# prisma.config.ts requires DATABASE_URL to load; the value is unused by
# `generate` (no database connection is made).
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app

# Install minimal runtime deps (curl for the healthcheck, openssl for the
# Prisma query engine)
RUN apk add --no-cache curl openssl

# Copy package manifest and built artifacts
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

# Copy the knex config and migrations so `npm run migrate:latest` (and
# `migrate:status`) can run inside the image. `knex` is a production
# dependency for exactly this reason.
COPY --from=builder /app/knexfile.cjs ./
COPY --from=builder /app/db ./db

# `dist/services/vaultTransitions.js` imports ../../shared/vaultMachine.mjs,
# so the shared runtime module must ship alongside dist as well.
COPY --from=builder /app/shared ./shared

# Install only production dependencies
RUN npm ci --omit=dev

# Ship the Prisma schema and the client generated in the builder stage; the
# `@prisma/client` postinstall in this stage has no schema to generate from.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Ensure files are owned by the non-root user
RUN chown -R node:node /app

# Switch to non-root `node` user
USER node

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Container-level health probe (docker-compose only defines one for its own
# service). Shell form so ${PORT} is expanded at runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f "http://localhost:${PORT}/api/health" || exit 1

CMD ["npm", "start"]
