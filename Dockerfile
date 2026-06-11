# syntax=docker/dockerfile:1

# ---------- Build stage ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Install all dependencies (including dev) for building.
COPY package*.json ./
RUN npm ci

# Copy sources and build the server + client bundle.
COPY . .
RUN npm run build:client && npm run build

# Remove dev dependencies to slim the node_modules we carry over.
RUN npm prune --omit=dev

# ---------- Runtime stage ----------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/views ./views
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json

# Data directory (vaults + sqlite db) is mounted as a volume.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3065
CMD ["node", "dist/main.js"]
