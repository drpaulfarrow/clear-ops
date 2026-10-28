FROM node:22-slim

# git and the GitHub CLI for the engineer and maintainer, python3 for the analyst,
# headless Chromium and a few open fonts for the design worker's screenshots
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates curl gnupg \
    chromium fonts-liberation fonts-dejavu-core fonts-noto-core \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --shell /usr/sbin/nologin designer

# The service runs as root; the design worker's browser and branch previews run as the unprivileged
# designer user (src/design.ts), which cannot read the service's environment, /data or git credentials.

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
