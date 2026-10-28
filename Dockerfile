# TestFlow — Autonomous SQA Agent
# Build:  docker build -t testflow .
# Run:    docker run -p 8080:8080 --env-file .env -v "$(pwd)/data:/app/data" testflow

FROM node:20-slim

WORKDIR /app

# Install native dependencies for SQLite compilation and Playwright dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install npm dependencies (cached layer)
COPY package.json package-lock.json ./
RUN npm ci

# Playwright browser + OS dependencies
RUN npx playwright install --with-deps chromium

# App source and scripts
COPY dashboard ./dashboard
COPY src ./src
COPY routes ./routes
COPY scripts ./scripts

ENV NODE_ENV=production
ENV SQA_DASHBOARD_PORT=8080
EXPOSE 8080

# Results and SQLite database persist in the mounted /app/data volume
CMD ["node", "dashboard/server.js"]
