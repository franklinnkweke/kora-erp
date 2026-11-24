# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- run ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB_FILE=/data/kora.db PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
