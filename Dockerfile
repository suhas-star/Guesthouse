# Guest house portal: self-hosted image (Node.js 22 + SQLite). Put it behind an HTTPS reverse proxy.
#   docker build -t guesthouse-portal .
#   docker run -d -p 8080:8080 -v ghdata:/data --env-file .env guesthouse-portal
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN python3 build.py && node --disable-warning=ExperimentalWarning test/smoke.mjs

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/ltmgh.sqlite
WORKDIR /app
COPY --from=build /app/worker.mjs ./worker.mjs
COPY --from=build /app/package.json ./package.json
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.mjs"]
