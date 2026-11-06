# XenoSaves Archive — API + worker image
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY migrations ./migrations
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# git: GitHub sources (blobless clones) · p7zip-full: RAR/7z listing + integrity tests (never extraction)
# clamav: optional local scanning when CLAMD_HOST is not used
RUN apt-get update \
 && apt-get install -y --no-install-recommends git p7zip-full ca-certificates clamav \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
