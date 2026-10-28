/**
 * dashboard/public/app.js — single-page dashboard client.
 *
 * Hash-based routing:
 *   #/            → run list
 *   #/runs/:id    → run detail (with live SSE)
 *   #/monitors    → scheduled monitoring (Rung 3)
 *   #/trends      → aggregate trends
 *
 * Pure vanilla JS — no build step, no frameworks. Reads from /api/* endpoints.
 *
 * Persuasive-design notes (HCI):
 *   • SVG score rings animate into place — perceived competence + progress
 *   • Every action gives instant toast feedback — feedback loop
 *   • Urgency banner surfaces critical/high findings first — priming
 *   • Verdict labels translate numbers into language — framing
 *   • Empty states guide the next action — reduction + commitment
 */

// ─── auth helpers (Rung 3) ───────────────────────────────────────────
// When the server has SQA_API_TOKEN set, API calls need the key. We store
// it in localStorage and attach it everywhere: fetches use the Authorization
// header; EventSource + report <a> links use ?token= (they can't set headers).

function authHeaders() {
  const token = localStorage.getItem('sqa_token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

function withAuth(url) {
  const token = localStorage.getItem('sqa_token');
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

function handleAuth(res) {
  if (res.status === 401) {
    showAuthPrompt();
    throw new Error('Unauthorized — enter your access key first');
  }
  return res;
}

let authPromptEl = null;
function showAuthPrompt() {
  if (authPromptEl) return;
  authPromptEl = document.createElement('div');
  authPromptEl.className = 'auth-overlay';
  authPromptEl.innerHTML = `
    <div class="auth-box" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <h3 id="auth-title">🔒 Access key required</h3>
      <p>This dashboard is protected. Enter the access key configured in <code>SQA_API_TOKEN</code>.</p>
      <input type="password" id="auth-input" placeholder="Access key" autocomplete="off" aria-label="Access key" />
      <div class="auth-error" id="auth-error" style="display:none;" role="alert"></div>
      <button class="btn btn-primary" id="auth-save">Unlock dashboard</button>
    </div>`;
  document.body.appendChild(authPromptEl);
  const save = () => {
    const value = authPromptEl.querySelector('#auth-input').value.trim();
    if (!value) return;
    localStorage.setItem('sqa_token', value);
    authPromptEl.remove();
    authPromptEl = null;
    navigate(); // re-render with the new key
  };
  authPromptEl.querySelector('#auth-save').addEventListener('click', save);
  authPromptEl.querySelector('#auth-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  authPromptEl.querySelector('#auth-input').focus();
}

const API = {
  runs: () => fetch('/api/runs', { headers: authHeaders() }).then(handleAuth).then(r => r.json()),
  run: (id) => fetch(withAuth(`/api/runs/${encodeURIComponent(id)}`), { headers: authHeaders() }).then(handleAuth).then(r => r.json()),
  trends: () => fetch('/api/trends', { headers: authHeaders() }).then(handleAuth).then(r => r.json()),
  monitors: () => fetch('/api/monitors', { headers: authHeaders() }).then(handleAuth).then(r => r.json()),
  addMonitor: (body) => fetch('/api/monitors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }).then(handleAuth).then(r => r.json()),
  deleteMonitor: (id) => fetch(`/api/monitors/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  }).then(handleAuth).then(r => r.json()),
  runMonitor: (id) => fetch(`/api/monitors/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: authHeaders(),
  }).then(handleAuth).then(r => r.json()),
  deleteSession: (id) => fetch(`/api/monitors/${encodeURIComponent(id)}/session`, {
    method: 'DELETE',
    headers: authHeaders(),
  }).then(handleAuth).then(r => r.json()),
};

const app = document.getElementById('app');
const refreshBtn = document.getElementById('refresh');

let currentEventSource = null;

// ─── utilities ───────────────────────────────────────────────────────

function scoreColor(score) {
  if (score >= 90) return 'var(--success)';
  if (score >= 75) return 'var(--primary)';
  if (score >= 50) return 'var(--medium)';
  return 'var(--critical)';
}

/** Persuasive framing: translate the number into language. */
function verdict(score) {
  if (score == null) return { label: 'Awaiting results', tone: 'muted' };
  if (score >= 90) return { label: 'Excellent', tone: 'good' };
  if (score >= 75) return { label: 'Good', tone: 'ok' };
  if (score >= 50) return { label: 'Needs work', tone: 'warn' };
  return { label: 'At risk', tone: 'bad' };
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString();
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Animated SVG score ring — the app's signature credibility element. */
function scoreRingHtml(score, size = 64) {
  const has = score != null;
  const display = has ? Math.round(score) : '?';
  const color = has ? scoreColor(score) : 'var(--muted)';
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const pct = has ? Math.max(0, Math.min(100, score)) / 100 : 0;
  return `
    <div class="score-ring" style="--ring-size:${size}px; --ring-color:${color}; --ring-c:${c.toFixed(1)}; --ring-off:${(c * (1 - pct)).toFixed(1)};"
         role="img" aria-label="Quality score ${display} out of 100">
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
        <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}"></circle>
        <circle class="ring-value" cx="${size / 2}" cy="${size / 2}" r="${r}"></circle>
      </svg>
      <span class="ring-text">${display}</span>
    </div>`;
}

/** Instant feedback toasts (aria-live polite). */
function toast(message, type = 'info') {
  let holder = document.getElementById('toast-holder');
  if (!holder) {
    holder = document.createElement('div');
    holder.id = 'toast-holder';
    holder.className = 'toast-holder';
    holder.setAttribute('aria-live', 'polite');
    document.body.appendChild(holder);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  holder.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, 3800);
}

function skeletonHtml(blocks = 3) {
  return `<div class="skeleton-wrap">${Array.from({ length: blocks }, () =>
    '<div class="skeleton"></div>').join('')}</div>`;
}

// ─── router ──────────────────────────────────────────────────────────

function navigate() {
  // Close any open SSE stream
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }

  const hash = window.location.hash.slice(1) || '/';
  const [_, route, param] = hash.match(/^\/?(runs\/([^/]+)|trends|monitors)?\/?$/) || [];

  // Highlight active nav link
  const active = route === 'trends' ? 'trends' : route === 'monitors' ? 'monitors' : 'runs';
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.route === active);
  });

  if (route === 'trends') {
    renderTrends();
  } else if (route === 'monitors') {
    renderMonitors();
  } else if (route && route.startsWith('runs/')) {
    renderRunDetail(decodeURIComponent(param));
  } else {
    renderRunList();
  }
}

// ─── run list view ──────────────────────────────────────────────────

function newRunFormHtml() {
  return `
    <div class="chart-card new-run-form">
      <div class="chart-title">Start a new test</div>
      <form id="new-run-form">
        <input id="new-run-url" type="url" placeholder="https://your-site.com" required aria-label="Site URL to test" />
        <label class="form-opt">Pages
          <input id="new-run-pages" type="number" min="1" max="100" value="5" aria-label="Max pages to crawl" />
        </label>
        <button type="submit" class="btn btn-primary" id="new-run-start">▶ Start Test</button>
      </form>
      <div id="new-run-error" class="error" style="display:none;" role="alert"></div>
      <div class="capability-chips" aria-hidden="true">
        <span class="chip">✦ AI-planned tests</span>
        <span class="chip">♿ Accessibility</span>
        <span class="chip">🔌 API contracts</span>
        <span class="chip">🛡 Security headers</span>
        <span class="chip">⚡ Performance</span>
        <span class="chip">👁 Visual regression</span>
        <span class="chip">🎲 Fuzzing</span>
      </div>
      <p class="form-hint">
        Paste a public website URL and click Start. The agent crawls the site,
        builds an AI test plan, then runs browser + API checks (typically 1–5 min).
        To test a local/private site, start the agent with <code>SQA_ALLOW_PRIVATE=true</code>.
      </p>
    </div>`;
}

function wireNewRunForm() {
  const form = document.getElementById('new-run-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = document.getElementById('new-run-url').value.trim();
    const maxPages = parseInt(document.getElementById('new-run-pages').value, 10) || 5;
    const errBox = document.getElementById('new-run-error');
    const btn = document.getElementById('new-run-start');

    errBox.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Starting…';

    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ url, mode: 'matrix', options: { maxPages } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast('Test started — watch the live progress ▶', 'success');
      window.location.hash = `#/runs/${encodeURIComponent(data.runId)}`;
    } catch (err) {
      errBox.textContent = `Could not start test: ${err.message}`;
      errBox.style.display = 'block';
      btn.disabled = false;
      btn.textContent = '▶ Start Test';
    }
  });
}

function statusPills(r) {
  const url = r.url || 'Unknown site';
  return `
    <span class="run-status ${r.status}">${r.status}</span>
    ${r.summary ? `<span class="run-status pill-findings">${r.summary.totalFindings || 0} findings</span>` : ''}
    ${r.summary?.confirmedBugs ? `<span class="run-status pill-bugs">${r.summary.confirmedBugs} bugs</span>` : ''}`;
}

async function renderRunList() {
  app.innerHTML = skeletonHtml(3);

  try {
    const [{ runs, count }, trends] = await Promise.all([
      API.runs(),
      API.trends().catch(() => null),
    ]);

    // ── hero strip: the state of your sites at a glance ──
    let hero = '';
    if (trends && trends.totalRuns > 0) {
      const sev = trends.findingsBySeverity || {};
      const urgent = (sev.critical || 0) + (sev.high || 0);
      const avgColor = trends.avgScore != null ? scoreColor(trends.avgScore) : 'var(--muted)';
      hero = `
        <div class="hero-strip">
          <div class="hero-stat">
            <span class="hero-value" style="color:${avgColor}">${trends.avgScore ?? '—'}</span>
            <span class="hero-label">average score</span>
          </div>
          <div class="hero-stat">
            <span class="hero-value">${trends.totalRuns}</span>
            <span class="hero-label">runs completed</span>
          </div>
          <div class="hero-stat">
            <span class="hero-value" style="color:${urgent ? 'var(--critical)' : 'var(--success)'}">${urgent}</span>
            <span class="hero-label">high-priority issues</span>
          </div>
          <div class="hero-stat">
            <span class="hero-value">${trends.completedRuns ?? 0}</span>
            <span class="hero-label">passed checks ✓</span>
          </div>
        </div>
        ${urgent > 0 ? `
          <div class="alert-banner" role="alert">
            <span class="alert-icon">⚠</span>
            <strong>${urgent} high-priority issue${urgent === 1 ? '' : 's'}</strong> across your sites —
            open a run below to see exactly what to fix.
          </div>` : ''}`;
    }

    const cards = runs.map(r => {
      const url = r.url || 'Unknown site';
      const status = r.status || 'unknown';
      return `
        <article class="run-card">
          <a class="run-card-link" href="#/runs/${encodeURIComponent(r.runId)}"
             aria-label="Open run details for ${escapeHtml(url)}">
            ${scoreRingHtml(r.score, 64)}
            <div class="run-meta">
              <div class="run-url">${escapeHtml(url)}</div>
              <div class="run-time">${formatDate(r.startedAt)}</div>
              <div class="run-pills">${statusPills(r)}</div>
            </div>
            <span class="run-chevron" aria-hidden="true">›</span>
          </a>
          <div class="run-actions">
            <a href="${withAuth(`/api/runs/${encodeURIComponent(r.runId)}/report.html`)}" target="_blank" rel="noopener" class="btn btn-ghost" aria-label="Open HTML report for ${escapeHtml(url)}">Report</a>
            <a href="${withAuth(`/api/runs/${encodeURIComponent(r.runId)}/report.json`)}" target="_blank" rel="noopener" class="btn btn-ghost" aria-label="Open JSON report for ${escapeHtml(url)}">JSON</a>
          </div>
        </article>`;
    }).join('');

    app.innerHTML = `
      ${hero}
      ${newRunFormHtml()}
      <div id="monitors-cards">
        ${count === 0
          ? `<div class="empty-state">
               <div class="empty-icon">🧪</div>
               <h2>No tests yet</h2>
               <p>Start your first test above — you'll see a quality score, findings, and fixes in about a minute.</p>
             </div>`
          : `<h2 class="section-title">Recent runs</h2><div class="run-list">${cards}</div>`}
      </div>`;
    wireNewRunForm();
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load runs: ${escapeHtml(err.message)}</div>`;
  }
}

// ─── run detail view ─────────────────────────────────────────────────

const SEVERITY_ICONS = { critical: '🚨', high: '🔺', medium: '🟠', low: '🔵', info: 'ℹ️' };

async function renderRunDetail(runId) {
  app.innerHTML = skeletonHtml(3);

  try {
    const run = await API.run(runId);
    const v = verdict(run.score);
    const summary = run.summary || {};
    const siteUrl = run.url || 'Unknown site';

    // ── triage: split baselines out, group the rest by rule ──
    const all = run.findings || [];
    const baselines = all.filter(f => f.ruleId === 'visual-baseline-captured');
    const issues = all.filter(f => f.ruleId !== 'visual-baseline-captured')
      .slice()
      .sort((a, b) => {
        const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
        return (order[a.severity] || 5) - (order[b.severity] || 5)
          || String(a.ruleId || '').localeCompare(String(b.ruleId || ''));
      });

    const kindOf = (f) => {
      if (f.findingType === 'informational') return 'info';
      if (f.findingType === 'environmental' || f.confidence === 'suspected') return 'suspected';
      return 'bug';
    };

    // Group consecutive same-rule findings (display-only; data keeps
    // per-page findings so dedup/report semantics are untouched).
    const sevRank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    const groups = [];
    for (const f of issues) {
      const ruleId = f.ruleId || 'general';
      const last = groups[groups.length - 1];
      if (last && last.ruleId === ruleId) last.items.push(f);
      else groups.push({ ruleId, items: [f] });
    }

    const findingsHtml = groups.map(g => {
      const kinds = [...new Set(g.items.map(kindOf))].join(' ');
      const occ = g.items.reduce((s, f) => s + (f.occurrences || 1), 0);
      const pageCount = new Set(g.items.flatMap(f => f.affectedPages || [f.pageUrl].filter(Boolean))).size;
      if (g.items.length === 1) {
        return `<div data-kind="${kinds}">${renderFindingCard(g.items[0], run.runId)}</div>`;
      }
      const worst = g.items.reduce((w, f) => ((sevRank[f.severity] || 0) > (sevRank[w.severity] || 0) ? f : w), g.items[0]);
      const groupTitle = g.items[0].title.replace(/\s*\([^)]*\)\s*$/, '');
      return `
        <details class="finding-group severity-${worst.severity}" data-kind="${kinds}">
          <summary>
            <span class="badge ${worst.severity}">${SEVERITY_ICONS[worst.severity] || ''} ${worst.severity}</span>
            <span class="group-title">${escapeHtml(groupTitle)}</span>
            <span class="group-count">${occ} occurrences · ${pageCount} page${pageCount === 1 ? '' : 's'}</span>
            <span class="group-chevron" aria-hidden="true">▾</span>
          </summary>
          <div class="findings-list group-items">${g.items.map(f => renderFindingCard(f, run.runId)).join('')}</div>
        </details>`;
    }).join('');

    const findingsSection = `
      <div class="findings-toolbar">
        <h2 id="findings-header" style="font-size: 1.125rem;">Findings (${issues.length})</h2>
        <div class="filter-chips" role="group" aria-label="Filter findings">
          <button class="chip filter-chip active" data-filter="all" aria-pressed="true">All</button>
          <button class="chip filter-chip" data-filter="bug" aria-pressed="false">Bugs</button>
          <button class="chip filter-chip" data-filter="suspected" aria-pressed="false">Suspected</button>
          <button class="chip filter-chip" data-filter="info" aria-pressed="false">Info</button>
        </div>
      </div>
      ${baselines.length ? `<div class="baseline-note" data-kind="info">📸 ${baselines.length} visual baseline${baselines.length === 1 ? '' : 's'} initialized — future runs will pixel-diff against these.</div>` : ''}
      ${groups.length === 0 && baselines.length ? '' : `<div class="findings-list" id="findings-list" data-filter="all">${findingsHtml}</div>`}
    `;

    const isLive = run.status === 'running' || run.status === 'queued';
    const emptyHtml = all.length === 0
      ? (isLive
          // While scanning there are no findings yet — "All clear" would be a lie.
          ? `<div class="empty-state">
               <div class="empty-icon">🔍</div>
               <h2>Scanning…</h2>
               <p>The agent is still working — findings appear here as each check completes.</p>
             </div>`
          : `<div class="empty-state">
               <div class="empty-icon">🎉</div>
               <h2>All clear</h2>
               <p>No issues found on this site. Re-run any time, or add it as a Monitor to watch it automatically.</p>
             </div>`)
      : findingsSection;

    app.innerHTML = `
      <div class="run-detail-header">
        ${scoreRingHtml(run.score, 96)}
        <div class="run-detail-info">
          <div class="verdict-line">
            <span class="verdict verdict-${v.tone}">${v.label}</span>
            <span class="run-status ${run.status}">${run.status}</span>
            ${run.mode === 'matrix' ? '<span class="run-status">matrix</span>' : ''}
            ${run.options?.monitorId ? `<span class="run-status">scheduled</span>` : ''}
          </div>
          <h2 style="font-size: 1.25rem; word-break: break-all; margin: 0.35rem 0 0;">${escapeHtml(siteUrl)}</h2>
          <p style="color: var(--muted); margin: 0.3rem 0 0;">
            ${formatDate(run.startedAt)}${run.completedAt ? ` → ${formatDate(run.completedAt)}` : ''}
          </p>
          <p style="margin: 0.6rem 0 0;">
            <a href="#/" class="btn btn-ghost">← All runs</a>
          </p>
        </div>
      </div>

      <div class="stats">
        <div class="stat"><span class="stat-icon">📄</span><div class="stat-value">${summary.totalPages ?? (run.pages ? run.pages.length : 0)}</div><div class="stat-label">Pages</div></div>
        <div class="stat"><span class="stat-icon">🔍</span><div class="stat-value">${summary.totalFindings ?? all.length}</div><div class="stat-label">Findings</div></div>
        <div class="stat"><span class="stat-icon">🐛</span><div class="stat-value">${summary.confirmedBugs ?? 0}</div><div class="stat-label">Confirmed bugs</div></div>
        <div class="stat"><span class="stat-icon">📍</span><div class="stat-value">${summary.totalOccurrences ?? all.length}</div><div class="stat-label">Occurrences</div></div>
        <div class="stat"><span class="stat-icon">💡</span><div class="stat-value">${summary.recommendationCount ?? 0}</div><div class="stat-label">Recommendations</div></div>
      </div>

      ${emptyHtml}
    `;

    // Filter chips — hide/show groups via data-kind attributes
    app.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        app.querySelectorAll('.filter-chip').forEach(c => {
          const active = c === chip;
          c.classList.toggle('active', active);
          c.setAttribute('aria-pressed', String(active));
        });
        document.getElementById('findings-list')?.setAttribute('data-filter', chip.dataset.filter);
      });
    });

    // If run is still active, show live progress + subscribe to SSE.
    // Anchored to the run header (always present) — the findings section may
    // legitimately not exist yet while the scan is still running.
    if (isLive) {
      const progressCard = document.createElement('div');
      progressCard.className = 'chart-card progress-card';
      progressCard.innerHTML = `
        <div class="chart-title"><span class="live-dot"></span> Live progress — the agent is working, this page updates automatically</div>
        <div class="progress-shimmer" aria-hidden="true"></div>
        <div class="progress-box" id="progress-box">
          <div class="progress-line">Waiting for events…</div>
        </div>`;
      app.querySelector('.run-detail-header')?.after(progressCard);
      subscribeToEvents(runId);
    }
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load run: ${escapeHtml(err.message)}</div>`;
  }
}

function renderFindingCard(f, runId) {
  const sev = f.severity || 'info';
  const icon = SEVERITY_ICONS[sev] || 'ℹ️';
  const badge = `<span class="badge ${sev}">${icon} ${sev}</span>`;
  const confidence = f.confidence
    ? `<span class="badge badge-neutral">${escapeHtml(f.confidence)}</span>`
    : '';
  const origin = f.origin
    ? `<span class="badge badge-neutral">${escapeHtml(f.origin)}</span>`
    : '';
  const ruleId = f.ruleId
    ? `<span class="badge badge-rule">${escapeHtml(f.ruleId)}</span>`
    : '';

  const occurrences = f.occurrences > 1
    ? `<div class="finding-meta">🔁 ${f.occurrences} occurrences across ${f.affectedPages?.length || 1} pages</div>`
    : '';

  const page = f.pageUrl
    ? `<div class="finding-meta"><a href="${escapeHtml(f.pageUrl)}" target="_blank" rel="noopener">${escapeHtml(f.pageUrl)}</a></div>`
    : '';

  const description = f.description
    ? `<p style="margin-top: 0.5rem;">${escapeHtml(f.description)}</p>`
    : '';

  const evidence = f.evidence
    ? `<pre class="finding-evidence">${escapeHtml(f.evidence)}</pre>`
    : '';

  const fix = f.suggestedFix
    ? `<div class="finding-fix"><strong>Fix:</strong> ${escapeHtml(f.suggestedFix)}</div>`
    : '';

  const screenshot = f.screenshot
    ? `<img class="finding-screenshot" src="${withAuth(`/api/runs/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(f.screenshot.replace(/^.*\//, ''))}`)}" alt="Screenshot for ${escapeHtml(f.title)}" loading="lazy" />`
    : '';

  const matrixCells = f.matrixCells?.length
    ? `<div class="finding-meta">Observed in: ${f.matrixCells.map(escapeHtml).join(', ')}</div>`
    : '';

  return `
    <div class="finding-card severity-${sev}">
      <div class="finding-header">
        <div class="finding-title">${escapeHtml(f.title)}</div>
        <div>${badge}${confidence}${origin}${ruleId}</div>
      </div>
      ${page}${description}${evidence}${fix}${screenshot}${occurrences}${matrixCells}
    </div>`;
}

function subscribeToEvents(runId) {
  currentEventSource = new EventSource(withAuth(`/api/runs/${encodeURIComponent(runId)}/events`));

  currentEventSource.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.message === '__DONE__') {
        currentEventSource.close();
        // Re-render with final state
        renderRunDetail(runId);
        return;
      }
      const box = document.getElementById('progress-box');
      if (box) {
        const line = document.createElement('div');
        line.className = 'progress-line';
        const text = data.message || JSON.stringify(data);
        const time = new Date().toLocaleTimeString();
        line.textContent = `[${time}] ${String(text).slice(0, 300)}`;
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
      }
      console.log('[event]', data.message);
    } catch {
      // ignore parse errors
    }
  };

  currentEventSource.onerror = () => {
    currentEventSource.close();
  };
}

// ─── monitors view (Rung 3) ──────────────────────────────────────────

async function renderMonitors() {
  app.innerHTML = skeletonHtml(2);

  try {
    const { monitors, schedulerEnabled } = await API.monitors();

    const cards = monitors.map(m => {
      const url = m.url || 'Unknown site';
      const lastRun = m.lastRunAt ? formatDate(m.lastRunAt) : 'never';
      const next = m.nextRunAt ? formatDate(m.nextRunAt) : '—';
      const statusChip = m.lastStatus
        ? `<span class="run-status ${m.lastStatus}">${m.lastStatus}</span>`
        : '<span class="run-status">waiting</span>';
      // Recorded session chip (record-once login)
      const hasSession = m.session?.exists;
      const sessionChip = hasSession
        ? `<span class="session-chip ok" title="Cookies: ${m.session.cookieCount || 0} · domains: ${escapeHtml((m.session.domains || []).join(', ') || '—')}">
             🔑 Session ✓ ${m.sessionRecordedAt ? `· ${formatDate(m.sessionRecordedAt)}` : ''}
           </span>
           ${m.sessionExpired ? '<span class="session-chip expired">⚠ Session expired — re-record</span>' : ''}`
        : '<span class="session-chip">🔓 No session — public pages only</span>';
      const sessionActions = hasSession
        ? `<button class="btn btn-ghost monitor-rerecord" data-id="${escapeHtml(m.id)}" aria-label="Re-record login for ${escapeHtml(m.label || m.id)}">🔑 Re-record</button>
           <button class="btn btn-ghost monitor-delsession" data-id="${escapeHtml(m.id)}" aria-label="Remove saved session for ${escapeHtml(m.label || m.id)}">Remove session</button>`
        : `<button class="btn monitor-record" data-id="${escapeHtml(m.id)}" aria-label="Record login for ${escapeHtml(m.label || m.id)}">🔑 Record login</button>`;
      return `
        <article class="run-card monitor-card" data-id="${escapeHtml(m.id)}">
          <div class="run-card-link">
            ${scoreRingHtml(m.lastScore, 64)}
            <div class="run-meta">
              <div class="run-url">${escapeHtml(m.label || m.id)} ${m.enabled === false ? '<span class="badge badge-neutral">paused</span>' : ''}</div>
              <div class="run-time">
                <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
                · every ${m.intervalHours}h
                ${m.onlyNewFindings !== false ? '· regressions only' : '· all findings'}
              </div>
              <div class="run-pills">${statusChip}<span class="run-time">Last: ${lastRun}</span><span class="run-time">Next: ${next}</span></div>
              <div class="run-pills">${sessionChip}</div>
            </div>
          </div>
          <div class="run-actions">
            <button class="btn btn-primary monitor-run" data-id="${escapeHtml(m.id)}" aria-label="Run test now for ${escapeHtml(m.label || m.id)}">▶ Run now</button>
            ${sessionActions}
            <button class="btn btn-ghost monitor-delete" data-id="${escapeHtml(m.id)}" aria-label="Delete monitor ${escapeHtml(m.label || m.id)}">Delete</button>
          </div>
        </article>`;
    }).join('');

    app.innerHTML = `
      <div id="record-banner"></div>
      <div class="page-head">
        <h2>Website monitoring</h2>
        <p class="muted">${monitors.length ? `Watching ${monitors.length} site${monitors.length === 1 ? '' : 's'} — the scheduler re-tests them automatically and reports only what's new.` : 'Add a client site once — the agent re-tests it on your schedule and pings you only when something new appears.'}</p>
      </div>
      <div class="chart-card new-run-form">
        <div class="chart-title">Add a monitored site</div>
        <form id="monitor-form">
          <input id="monitor-label" type="text" placeholder="Client / site name (e.g. Acme Marketing)" required aria-label="Monitor label" />
          <input id="monitor-url" type="url" placeholder="https://client-site.com" required aria-label="Monitor URL" />
          <label class="form-opt">Every
            <input id="monitor-interval" type="number" min="1" max="720" value="24" aria-label="Interval in hours" /> h
          </label>
          <label class="form-opt">Pages
            <input id="monitor-pages" type="number" min="1" max="100" value="5" aria-label="Max pages" />
          </label>
          <label class="form-opt"><input id="monitor-newonly" type="checkbox" checked /> New findings only</label>
          <button type="submit" class="btn btn-primary">Add Monitor</button>
        </form>
        <div id="monitor-error" class="error" style="display:none;" role="alert"></div>
        <p class="form-hint">
          Findings are filed to the configured issue tracker / webhook — new regressions only, when
          the checkbox is set. Configure trackers via <code>SQA_ISSUE_TRACKER</code> etc. (see README).
        </p>
      </div>
      ${schedulerEnabled ? '' : '<div class="error">Scheduler is disabled (SQA_SCHEDULER_ENABLED=false) — monitors will not run automatically.</div>'}
      <div id="monitors-cards">
        ${monitors.length
          ? `<div class="run-list">${cards}</div>`
          : `<div class="empty-state">
               <div class="empty-icon">📡</div>
               <h2>No monitors yet</h2>
               <p>Monitoring turns this tool into a watchdog: add a site above and it gets re-tested every interval — you only hear about what changed.</p>
             </div>`}
      </div>`;

    wireMonitorForm();
    wireMonitorButtons();
    refreshRecordState();
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load monitors: ${escapeHtml(err.message)}</div>`;
  }
}

// ─── record-once login UI (session capture) ──────────────────────────

let recordPollTimer = null;

function renderRecordBanner(status) {
  const slot = document.getElementById('record-banner');
  if (!slot) return;
  if (!status.active) {
    slot.innerHTML = '';
    stopRecordPolling();
    return;
  }
  const secs = Math.round((status.elapsedMs || 0) / 1000);
  slot.innerHTML = `
    <div class="record-banner">
      <span class="record-dot" aria-hidden="true"></span>
      <strong>Recording login…</strong>
      <span class="record-url">${escapeHtml(status.currentUrl || '')}</span>
      <span class="muted">${Math.floor(secs / 60)}m ${secs % 60}s · click "✅ Save session" in the browser window when logged in</span>
      <button class="btn btn-ghost" id="record-cancel">Cancel</button>
    </div>`;
  document.getElementById('record-cancel').addEventListener('click', async () => {
    await fetch('/api/record-cancel', { method: 'POST', headers: authHeaders() }).then(handleAuth).catch(err => toast(err.message, 'error'));
  });
}

function stopRecordPolling() {
  if (recordPollTimer) {
    clearInterval(recordPollTimer);
    recordPollTimer = null;
  }
}

function startRecordPolling() {
  stopRecordPolling();
  const tick = async () => {
    try {
      const status = await fetch('/api/record-status', { headers: authHeaders() }).then(handleAuth).then(r => r.json());
      const wasActive = !!document.getElementById('record-banner')?.querySelector('.record-banner');
      renderRecordBanner(status);
      if (wasActive && !status.active) {
        toast('Login recording finished — the session was saved if you clicked Save.', 'success');
        renderMonitors();
      }
    } catch { /* transient — keep polling */ }
  };
  tick();
  recordPollTimer = setInterval(tick, 1500);
}

async function refreshRecordState() {
  try {
    const status = await fetch('/api/record-status', { headers: authHeaders() }).then(handleAuth).then(r => r.json());
    if (status.active) startRecordPolling();
  } catch { /* auth or network — banner not critical */ }
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    || `monitor-${Date.now()}`;
}

function wireMonitorForm() {
  const form = document.getElementById('monitor-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('monitor-error');
    errBox.style.display = 'none';
    const label = document.getElementById('monitor-label').value.trim();
    try {
      const result = await API.addMonitor({
        id: slugify(label),
        label,
        url: document.getElementById('monitor-url').value.trim(),
        intervalHours: parseInt(document.getElementById('monitor-interval').value, 10) || 24,
        options: { maxPages: parseInt(document.getElementById('monitor-pages').value, 10) || 5 },
        onlyNewFindings: document.getElementById('monitor-newonly').checked,
      });
      if (result.error) throw new Error(result.error);
      toast(`Now monitoring “${label}” 📡`, 'success');
      renderMonitors();
    } catch (err) {
      errBox.textContent = `Could not add monitor: ${err.message}`;
      errBox.style.display = 'block';
    }
  });
}

function wireMonitorButtons() {
  app.querySelectorAll('.monitor-run').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Starting…';
      try {
        await API.runMonitor(btn.dataset.id);
        toast('Monitor run started — watch the live progress ▶', 'success');
        window.location.hash = '#/';
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '▶ Run now';
        toast(`Could not start run: ${err.message}`, 'error');
      }
    });
  });
  app.querySelectorAll('.monitor-record, .monitor-rerecord').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/monitors/${encodeURIComponent(btn.dataset.id)}/record-login`, {
          method: 'POST',
          headers: authHeaders(),
        }).then(handleAuth);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        toast('Browser window opened — log in, then click "✅ Save session" in the banner.', 'success');
        btn.disabled = false;
        startRecordPolling();
      } catch (err) {
        toast(`Could not start recording: ${err.message}`, 'error');
        btn.disabled = false;
      }
    });
  });
  app.querySelectorAll('.monitor-delsession').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove the saved login session for this monitor?')) return;
      await API.deleteSession(btn.dataset.id).catch(err => toast(err.message, 'error'));
      toast('Saved session removed', 'info');
      renderMonitors();
    });
  });
  app.querySelectorAll('.monitor-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this monitor?')) return;
      await API.deleteMonitor(btn.dataset.id).catch(err => toast(err.message, 'error'));
      toast('Monitor deleted', 'info');
      renderMonitors();
    });
  });
}

// ─── trends view ─────────────────────────────────────────────────────

async function renderTrends() {
  app.innerHTML = skeletonHtml(2);

  try {
    const trends = await API.trends();

    const avgScoreColor = trends.avgScore != null ? scoreColor(trends.avgScore) : 'var(--muted)';
    const avgVerdict = verdict(trends.avgScore);

    // Score chart: bar chart of recent runs
    const maxScore = 100;
    const scoreBars = trends.scoreTrend.map(t => {
      const height = t.score != null ? (t.score / maxScore) * 100 : 0;
      const color = t.score != null ? scoreColor(t.score) : 'var(--muted)';
      return `<div class="score-bar" style="height: ${height}%; background: ${color};" data-score="Score: ${t.score ?? '?'}"></div>`;
    }).join('');

    // Severity breakdown
    const sev = trends.findingsBySeverity;
    const totalSev = Object.values(sev).reduce((a, b) => a + b, 0) || 1;
    const sevBars = ['critical', 'high', 'medium', 'low', 'info'].map(s => {
      const count = sev[s] || 0;
      const pct = (count / totalSev) * 100;
      const colors = { critical: 'var(--critical)', high: 'var(--high)', medium: 'var(--medium)', low: 'var(--low)', info: 'var(--info)' };
      return `<div style="width: ${pct}%; background: ${colors[s]};" title="${s}: ${count}"></div>`;
    }).join('');

    const categoryList = Object.entries(trends.findingsByCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `<div style="display: flex; justify-content: space-between; padding: 0.25rem 0; border-bottom: 1px solid var(--border);">
        <span>${escapeHtml(cat)}</span>
        <strong>${count}</strong>
      </div>`).join('');

    app.innerHTML = `
      <div class="page-head">
        <h2>Trends</h2>
        <p class="muted">How your sites' quality moves over time — the number your clients will ask about.</p>
      </div>
      <div class="trends-grid">
        <div class="chart-card trend-hero">
          <div class="chart-title">Average score</div>
          <div class="chart-value" style="color: ${avgScoreColor};">${trends.avgScore ?? '—'}</div>
          <span class="verdict verdict-${avgVerdict.tone}">${avgVerdict.label}</span>
        </div>

        <div class="chart-card">
          <div class="chart-title">Total runs</div>
          <div class="chart-value">${trends.totalRuns}</div>
          <div style="color: var(--muted); font-size: 0.875rem; margin-top: 0.5rem;">
            ${trends.completedRuns} completed · ${trends.failedRuns} failed
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">Findings by severity</div>
          <div class="severity-bar">${sevBars}</div>
          <div style="margin-top: 0.5rem; font-size: 0.8125rem; color: var(--muted);">
            ${['critical', 'high', 'medium', 'low', 'info'].map(s =>
              `${s}: <strong>${sev[s] || 0}</strong>`
            ).join(' · ')}
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">Score trend (last ${trends.scoreTrend.length})</div>
          ${trends.scoreTrend.length > 0
            ? `<div class="score-chart">${scoreBars}</div>`
            : '<p style="color: var(--muted);">No completed runs yet.</p>'}
        </div>

        <div class="chart-card" style="grid-column: 1 / -1;">
          <div class="chart-title">Findings by category</div>
          ${categoryList || '<p style="color: var(--muted);">No findings yet.</p>'}
        </div>

        ${trends.flakyTests?.length ? `
          <div class="chart-card" style="grid-column: 1 / -1;">
            <div class="chart-title">Flaky tests</div>
            <ul>${trends.flakyTests.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
          </div>
        ` : ''}
      </div>
    `;
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load trends: ${escapeHtml(err.message)}</div>`;
  }
}

// ─── wire up events ──────────────────────────────────────────────────

window.addEventListener('hashchange', navigate);
refreshBtn.addEventListener('click', navigate);
navigate();
