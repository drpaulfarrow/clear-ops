FROM node:22-slim

# git for the engineer agent, python3 for the analyst, ca-certificates for outbound HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV REPO_DIR=/data/workspace
ENV PORT=8080
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "dist/index.js"]
