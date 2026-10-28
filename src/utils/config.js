/**
 * Unified configuration — merges qagent defaults with SQA-agent extensions.
 *
 * Reads from process.env with sensible defaults for local development.
 * SQA_* prefixed vars take precedence over generic ones when both exist.
 */
export const config = Object.freeze({
  // Server
  port: parseInt(process.env.PORT || '3000'),
  nodeEnv: process.env.NODE_ENV || 'development',

  // SSRF — never enable in production
  allowPrivateTargets:
    (process.env.SQA_ALLOW_PRIVATE === 'true') ||
    (process.env.NODE_ENV === 'development' && process.env.ALLOW_PRIVATE_TARGETS === 'true'),

  // CORS
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000,http://localhost:8080').split(','),

  // Rate limiting
  rateLimitMaxRuns: parseInt(process.env.RATE_LIMIT_MAX_RUNS || '5'),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '3600000'),

  // Concurrency
  maxConcurrentRuns: parseInt(process.env.MAX_CONCURRENT_RUNS || '2'),

  // Page limits
  maxPagesHardLimit: parseInt(process.env.SQA_MAX_PAGES_HARD || process.env.MAX_PAGES_HARD_LIMIT || '100'),

  // Timeouts
  maxRunTimeMs: parseInt(process.env.SQA_MAX_RUN_MS || process.env.MAX_RUN_TIME_MS || '300000'),
  pageTimeoutMs: parseInt(process.env.SQA_PAGE_TIMEOUT_MS || process.env.PAGE_TIMEOUT_MS || '30000'),
  maxResponseSizeBytes: parseInt(process.env.MAX_RESPONSE_SIZE_BYTES || '10485760'),

  // Data retention
  cleanupMaxAgeMs: parseInt(process.env.SQA_CLEANUP_MS || process.env.CLEANUP_MAX_AGE_MS || '86400000'),

  // Storage paths
  dataDir: process.env.SQA_DATA_DIR || './data',
  screenshotsDir: process.env.SQA_SCREENSHOTS_DIR || './data/screenshots',

  // Auth — when set, all /api/* routes (except /health) require this token
  apiToken: process.env.SQA_API_TOKEN || '',

  // Scheduler (monitoring) — interval loop that runs due monitors
  schedulerEnabled: process.env.SQA_SCHEDULER_ENABLED !== 'false',
  schedulerIntervalMs: parseInt(process.env.SQA_SCHEDULER_INTERVAL_MS || '60000'),

  // Webhook — POST a run summary to this URL after each monitored run
  webhookUrl: process.env.SQA_WEBHOOK_URL || '',
});
