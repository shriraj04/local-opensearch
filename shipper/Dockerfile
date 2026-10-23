FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY index.mjs mng-query.mjs index-template.json index-template-fallback.json status.html ./
USER node
EXPOSE 9700
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:9700/status >/dev/null || exit 1
CMD ["node", "index.mjs"]
