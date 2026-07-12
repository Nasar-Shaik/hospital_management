# apps/workers — multi-stage, slim non-root runtime (Doc 04 §6.2)
FROM node:22-alpine AS builder
RUN npm install -g pnpm@10
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@medicore/workers..."
RUN pnpm --filter "@medicore/workers..." run build
RUN pnpm --filter "@medicore/workers" deploy --prod --legacy /out

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /out .
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4100/health || exit 1
CMD ["node", "dist/main.js"]
