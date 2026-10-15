FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
# Dev dependencies are kept: tsx runs the TypeScript sources directly.
RUN npm ci && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_URL=file:/app/data/opspilot.db

USER node
EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
