# ─────────────────────────────────────────────────────────────────────────────
# UpDown keeper. Multi-stage: build TypeScript, then ship only runtime deps.
#
#   docker build -t updown-keeper .
#   docker run --rm --env-file .env -p 9464:9464 \
#     -v "$PWD/../contracts/deployments:/deployments:ro" \
#     -e DEPLOYMENTS_PATH=/deployments/97.json updown-keeper
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:26-alpine AS runtime
# tini reaps zombies and forwards SIGTERM, so shutdown stays graceful in a container.
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./

# Never run as root; the keeper needs no filesystem write access at all.
USER node

EXPOSE 9464
ENV METRICS_PORT=9464 METRICS_HOST=0.0.0.0

# The container is unhealthy as soon as any market falls two intervals behind.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.METRICS_PORT||9464)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
