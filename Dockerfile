# SQA Agent — monitoring service image (Rung 3)
# Build:  docker build -t sqa-agent .
# Run:    docker run -p 8080:8080 --env-file .env -v "$(pwd)/data:/app/data" sqa-agent

FROM node:20-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json package-lock.json ./
RUN npm ci

# Playwright browser + OS dependencies
RUN npx playwright install --with-deps chromium

# App source
COPY dashboard ./dashboard
COPY src ./src
COPY routes ./routes

ENV NODE_ENV=production
ENV SQA_DASHBOARD_PORT=8080
EXPOSE 8080

# Results/screenshots persist in the mounted /app/data volume
CMD ["node", "dashboard/server.js"]
