FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src
# The fallback registry and its placeholder template. A deployment overrides both
# by mounting its own directory at LETTERHEAD_DIR; these are what make the image
# runnable with no configuration at all.
COPY letterheads.json ./
COPY templates ./templates

ENV NODE_ENV=production
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=3002
ENV LETTERHEAD_DIR=/data/letterheads

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.MCP_HTTP_PORT || process.env.PORT || 3002) + '/healthz').then((response) => { if (!response.ok) { process.exit(1); } }).catch(() => process.exit(1));"

USER node

CMD ["node", "index.js"]
