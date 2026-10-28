# SQA Agent

Autonomous software QA agent for web apps — it explores, plans, and runs
comprehensive web + API test suites, then watches your sites over time and
files the regressions as tickets.

Give it a URL and it will:

1. **Crawl** the site with a real browser (Playwright), capturing pages,
   forms, links, console errors, and every background API call.
2. **Plan** a test suite: an LLM (Z.ai GLM — free tier works) invents E2E
   user flows and API contracts; heuristics derive accessibility rules,
   performance budgets, visual baselines, and fuzz targets.
3. **Execute** the plan across a matrix of browsers × viewports × user roles.
4. **Report** findings with severity, confidence, evidence, and suggested
   fixes — scored 0–100 — via a live web dashboard, HTML/JSON reports,
   GitHub/Jira issues, and webhooks.
5. **Monitor**: schedule sites for automatic re-testing; only *new*
   regressions get filed, so you hear about what changed.

## Quickstart (local)

```bash
npm install
npx playwright install chromium
npm run start:dashboard        # → http://localhost:8080
```

Open the dashboard, type a URL into "Start a new test", click Start.

To test sites on `localhost`, set `SQA_ALLOW_PRIVATE=true` first.

## Quickstart (Docker / VPS)

```bash
cp .env.example .env           # edit: set SQA_API_TOKEN at minimum
docker compose up -d --build
```

The dashboard is now on port 8080 behind your access key. Put a reverse
proxy (nginx/Caddy) with HTTPS in front for anything internet-facing.

## Monitoring (Rung 3)

Open the **Monitors** page and add a site — label, URL, interval (hours),
pages to crawl. The built-in scheduler re-tests each site on its interval
(no cron needed; it lives inside the server). Each monitored run:

- **Files regressions only** (default): findings whose signature
  (`ruleId + page + severity`) already existed in the previous run are
  skipped; new findings — or known ones that got *worse* — are published.
- **Notifies**: a POST summary goes to `SQA_WEBHOOK_URL` (or the monitor's
  own `webhookUrl`) with the score, findings, and a report link. Works with
  Discord/Slack/generic receivers.

Monitors are stored in `data/monitors.json` (editable) and managed via the
UI or the API:

```bash
TOKEN=your-access-key
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/monitors
curl -H "Authorization: Bearer $TOKEN" -X POST http://localhost:8080/api/monitors \
  -H 'Content-Type: application/json' \
  -d '{"id":"acme","label":"Acme site","url":"https://acme.com","intervalHours":24,"options":{"maxPages":5}}'
curl -H "Authorization: Bearer $TOKEN" -X POST http://localhost:8080/api/monitors/acme/run
```

## Logged-in monitoring (record-once login)

Most valuable pages sit behind a login. For any monitor you can record your
own login once, and every scheduled run will test the **authenticated** app:

1. Open the **Monitors** page and click **🔑 Record login**.
2. A real browser window opens on the machine running the agent. Log in with
   your own credentials (your 2FA, your captcha).
3. When you're in, click **✅ Save session** in the banner at the bottom.
4. Done — the next run crawls the authenticated app, and API contract probes
   send your session cookies automatically.

Notes:

- Sessions are **encrypted at rest** (AES-256-GCM). The key lives in
  `data/.session.key` (or set `SQA_SESSION_SECRET`), and sessions are bound
  to a monitor, never logged, and deletable from the UI.
- Sessions expire like any login. The agent detects it (it lands on login
  pages despite the session), flags the monitor **⚠ Session expired**, and
  keeps testing the public site until you re-record.
- The recording browser opens on the machine running the agent. On a VPS
  (no display), record locally and copy `data/sessions/` + `data/.session.key`
  to the server with your deployment.
- Only record logins for sites you own or are authorized to test. Recording
  into third-party platforms (LinkedIn, Facebook, ...) violates their terms
  and risks your account.

### What the AI sees (privacy guarantee)

The AI planner (GLM) only ever receives **anonymous structure**:

- Page URLs with query values stripped, titles, and element counts
- API endpoint shapes — field names and types (`"token": "string"`),
  **never actual values** from request/response bodies

Your **password is never captured** (you type it into the real site; the
agent saves only the resulting session). Your **session cookies are
encrypted at rest** (AES-256-GCM) and are used solely to browse as you and
probe your site's API — they are never placed in prompts, findings,
reports, webhooks, or issue trackers. This boundary is enforced in one
place (`src/explorer/prompts.js`) and locked by tests in
`test/llmPrivacy.test.js`, which inject fake secrets and prove they cannot
reach the AI.

## Issue trackers

Set `SQA_ISSUE_TRACKER` to auto-file findings (deduplicated by signature):

- **GitHub**: `SQA_GITHUB_REPO=owner/name`, `SQA_GITHUB_TOKEN=…`
- **Jira**: `SQA_JIRA_BASE_URL`, `SQA_JIRA_EMAIL`, `SQA_JIRA_API_TOKEN`,
  `SQA_JIRA_PROJECT_KEY`
- **console**: logs what would be filed (useful for testing)

Tune with `SQA_TRACKER_MIN_SEVERITY` (default `medium`) and preview with
`SQA_TRACKER_DRY_RUN=true`. See `.env.example` for every variable.

## AI planning

Install the SDK and provide credentials (free tier is fine — the agent makes
only a few LLM calls per run):

```bash
npm i z-ai-web-dev-sdk
```

Create `~/.z-ai-config`:

```json
{ "baseUrl": "https://api.z.ai/api/paas/v4", "apiKey": "YOUR_KEY" }
```

Model defaults to `glm-4.7-flash` (free); override with `SQA_LLM_MODEL`.
Without the SDK the agent still runs — only the AI-inferred flows/API
contracts are skipped.

## Security notes (read before deploying)

- **Always set `SQA_API_TOKEN`** on anything reachable outside localhost.
  Without it anyone can scan arbitrary sites from your server's IP.
- Keep `SQA_ALLOW_PRIVATE=false` in production (it blocks the server being
  used to probe internal networks).
- The agent intentionally bypasses browser CSP for its own automation
  contexts — that's what lets the a11y scanner work on hardened sites.
- Results live in `data/` unencrypted; restrict the volume/host accordingly.

## Tests

```bash
npm test        # node --test, 400+ tests
```
