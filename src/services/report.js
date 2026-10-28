import { computeCompliance } from './compliance.js';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Defense-in-depth: redact sensitive header values even if upstream forgot.
// Matches the same set used in crawler.js captureApiCall().
const SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization|api-key)$/i;

function redactHeadersDeep(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

function verdict(score) {
  if (score == null) return { label: 'Awaiting results', tone: 'muted' };
  if (score >= 90) return { label: 'Excellent', tone: '#16a34a' };
  if (score >= 75) return { label: 'Good', tone: '#2563eb' };
  if (score >= 50) return { label: 'Needs work', tone: '#d97706' };
  return { label: 'At risk', tone: '#dc2626' };
}

function scoreRingSvg(score, size = 150) {
  const has = score != null;
  const display = has ? Math.round(score) : '?';
  const color = has
    ? (score >= 90 ? '#16a34a' : score >= 75 ? '#2563eb' : score >= 50 ? '#d97706' : '#dc2626')
    : '#94a3b8';
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const pct = has ? Math.max(0, Math.min(100, score)) / 100 : 0;
  return `
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Score ${display} of 100">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="10"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="47%" text-anchor="middle" dominant-baseline="middle" font-size="${size * 0.28}" font-weight="800" fill="${color}" font-family="system-ui">${display}</text>
      <text x="50%" y="66%" text-anchor="middle" font-size="${size * 0.09}" fill="#64748b" font-family="system-ui">/ 100</text>
    </svg>`;
}

function wcagSectionHtml(run) {
  const compliance = computeCompliance(run);
  const sevColors = { critical: '#dc2626', serious: '#ea580c', high: '#f97316', medium: '#d97706', low: '#3b82f6', info: '#64748b' };

  const criteriaRows = compliance.criteria.map(c => `
    <tr class="${c.status}">
      <td class="crit-id">${c.criterion}</td>
      <td>${escapeHtml(c.title)}</td>
      <td><span class="level-pill">${c.level}</span></td>
      <td>${c.status === 'pass'
        ? '<span class="status pass">✓ Pass</span>'
        : `<span class="status fail">✕ Fail — ${escapeHtml(c.severity || '')} (${c.occurrences})</span>`}</td>
    </tr>`).join('');

  const bestPracticeRows = compliance.bestPractice.map(b => `
    <tr class="${b.status}">
      <td class="crit-id">—</td>
      <td>${escapeHtml(b.title)} <span class="bp-tag">best practice</span></td>
      <td></td>
      <td>${b.status === 'pass'
        ? '<span class="status pass">✓ Pass</span>'
        : `<span class="status fail">✕ Fail — ${escapeHtml(b.severity || '')} (${b.occurrences})</span>`}</td>
    </tr>`).join('');

  return `
  <section class="wcag">
    <h2>WCAG 2.x Accessibility Conformance</h2>
    <div class="wcag-head">
      <div class="wcag-pct" style="color: ${compliance.conformancePct >= 90 ? '#16a34a' : compliance.conformancePct >= 70 ? '#2563eb' : compliance.conformancePct >= 50 ? '#d97706' : '#dc2626'};">
        ${compliance.conformancePct}<span>%</span>
      </div>
      <div class="wcag-summary">
        <p class="wcag-claim">of automatically checked WCAG 2.x success criteria pass
           (${compliance.checkedCount - compliance.violatedCount} of ${compliance.checkedCount}).</p>
        <div class="level-bars">
          <div class="level-bar"><span>Level A</span><div class="bar"><div class="fill" style="width:${compliance.levels.A.pct}%; background:#16a34a;"></div></div><strong>${compliance.levels.A.checked - compliance.levels.A.violated}/${compliance.levels.A.checked}</strong></div>
          <div class="level-bar"><span>Level AA</span><div class="bar"><div class="fill" style="width:${compliance.levels.AA.pct}%; background:#2563eb;"></div></div><strong>${compliance.levels.AA.checked - compliance.levels.AA.violated}/${compliance.levels.AA.checked}</strong></div>
        </div>
        ${compliance.blockers.length ? `
        <div class="blockers">
          <strong>⛔ Conformance blockers (${compliance.blockers.length}):</strong>
          <ul>${compliance.blockers.map(b => `<li><strong>${b.criterion} ${escapeHtml(b.title)}</strong> — ${escapeHtml(b.severity)}${b.pages.length ? `, e.g. ${escapeHtml(b.pages[0])}` : ''}</li>`).join('')}</ul>
        </div>` : '<div class="blockers pass">✓ No conformance blockers detected.</div>'}
      </div>
    </div>
    <table class="wcag-table">
      <thead><tr><th>SC</th><th>Success criterion</th><th>Level</th><th>Status</th></tr></thead>
      <tbody>${criteriaRows}${bestPracticeRows}</tbody>
    </table>
    <p class="limitation">${escapeHtml(compliance.limitation)}</p>
  </section>`;
}

function fixChecklistHtml(run) {
  const actionable = (run.findings || [])
    .filter(f => f.findingType === 'bug' && f.confidence !== 'suspected')
    .sort((a, b) => {
      const rank = { critical: 0, serious: 1, high: 2, medium: 3, low: 4, info: 5 };
      return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
    });

  if (!actionable.length) return '';

  return `
  <section class="checklist">
    <h2>Fix checklist</h2>
    <p class="muted">Work through top-to-bottom — each fix directly raises the score.</p>
    <ol>
      ${actionable.map(f => `
        <li class="fix-item sev-${f.severity}">
          <div><strong>${escapeHtml(f.title)}</strong> <span class="sev-tag">${escapeHtml(f.severity)}</span></div>
          ${f.suggestedFix ? `<div class="fix-hint">${escapeHtml(f.suggestedFix)}</div>` : ''}
          ${f.pageUrl ? `<div class="fix-where">${escapeHtml(f.pageUrl)}</div>` : ''}
        </li>`).join('')}
    </ol>
  </section>`;
}

export function generateHtmlReport(run) {
  const date = new Date(run.startedAt).toLocaleString();
  const v = verdict(run.score);

  let findingsHtml = '';

  if (!run.findings || run.findings.length === 0) {
    findingsHtml = '<p>No findings. Great job!</p>';
  } else {
    const grouped = run.findings.reduce((acc, f) => {
      const cat = f.category || 'general';
      const sev = f.severity || 'info';
      if (!acc[cat]) acc[cat] = {};
      if (!acc[cat][sev]) acc[cat][sev] = [];
      acc[cat][sev].push(f);
      return acc;
    }, {});

    const severities = ['critical', 'serious', 'high', 'medium', 'low', 'info'];

    for (const cat of Object.keys(grouped).sort()) {
      findingsHtml += `<div class="finding-category">
        <h2>${escapeHtml(cat).toUpperCase()}</h2>`;

      for (const sev of severities) {
        if (grouped[cat][sev]) {
          findingsHtml += `<div class="finding-group">
            <h3><span class="badge ${sev}">${sev.toUpperCase()}</span></h3>`;

          for (const f of grouped[cat][sev]) {
            let badgesHtml = `<span class="badge ${sev}">${sev.toUpperCase()}</span>`;
            if (f.confidence) {
              const confidenceClass = `confidence-${f.confidence}`;
              badgesHtml += ` <span class="badge ${confidenceClass}">${escapeHtml(f.confidence).toUpperCase()}</span>`;
            }
            if (f.origin) {
              const originText = f.origin === 'first-party' ? 'First-party' : (f.origin === 'third-party' ? 'Third-party' : escapeHtml(f.origin));
              badgesHtml += ` <span class="badge origin">${originText}</span>`;
            }

            findingsHtml += `<div class="finding-card">
              <h4>${escapeHtml(f.title)} ${badgesHtml}</h4>`;

            if (f.occurrences > 1) {
              const pageCount = f.affectedPages ? f.affectedPages.length : 1;
              findingsHtml += `<p><em>${f.occurrences} occurrences across ${pageCount} pages</em></p>`;
            } else {
              findingsHtml += `<p><strong>Page:</strong> <a href="${escapeHtml(f.pageUrl)}" target="_blank">${escapeHtml(f.pageUrl)}</a></p>`;
            }

            if (f.description) {
              findingsHtml += `<p>${escapeHtml(f.description)}</p>`;
            }

            if (f.evidence) {
              findingsHtml += `<div><strong>Evidence:</strong><pre>${escapeHtml(f.evidence)}</pre></div>`;
            }
            if (f.reproSteps && f.reproSteps.length > 0) {
              findingsHtml += `<div><strong>Repro Steps:</strong><ol>${f.reproSteps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol></div>`;
            }
            if (f.suggestedFix) {
              findingsHtml += `<div><strong>Suggested Fix:</strong><p>${escapeHtml(f.suggestedFix)}</p></div>`;
            }
            if (f.screenshot) {
              const screenshotFile = f.screenshot.replace('/screenshots/', '');
              findingsHtml += `<img src="/api/runs/${run.runId}/screenshots/${screenshotFile}" alt="Screenshot for ${escapeHtml(f.title)}" />`;
            }

            if (f.affectedPages && f.affectedPages.length > 1) {
              findingsHtml += `<details><summary><strong>Affected Pages (${f.affectedPages.length})</strong></summary><ul>`;
              for (const p of f.affectedPages) {
                findingsHtml += `<li><a href="${escapeHtml(p)}" target="_blank">${escapeHtml(p)}</a></li>`;
              }
              findingsHtml += `</ul></details>`;
            }

            findingsHtml += `</div>`;
          }

          findingsHtml += `</div>`;
        }
      }
      findingsHtml += `</div>`;
    }
  }

  const s = run.summary || {};
  const totalFindings = s.totalFindings || (run.findings ? run.findings.length : 0);
  const confirmedBugs = s.confirmedBugs || 0;
  const totalOccurrences = s.totalOccurrences || totalFindings;
  const duration = run.completedAt
    ? Math.max(1, Math.round((new Date(run.completedAt) - new Date(run.startedAt)) / 1000))
    : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Website Quality Report — ${escapeHtml(run.url)}</title>
  <style>
    :root {
      --text: #10152b;
      --muted: #5d657f;
      --card: #ffffff;
      --border: #e3e8f2;
      --bg: #f4f6fb;
      --primary: #5b5ef0;
      --success: #16a34a;
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
      margin: 0;
      padding: 2rem;
    }
    .container { max-width: 960px; margin: 0 auto; }

    .cover {
      background: linear-gradient(135deg, #10152b 0%, #1e2650 100%);
      color: #fff;
      border-radius: 18px;
      padding: 2.5rem 2.8rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 2rem;
      margin-bottom: 1.6rem;
    }
    .cover h1 { font-size: 1.15rem; letter-spacing: 0.14em; text-transform: uppercase; color: #a5b4fc; margin: 0 0 0.6rem; font-weight: 700; }
    .cover .site { font-size: 1.45rem; font-weight: 800; word-break: break-all; margin: 0 0 0.5rem; }
    .cover .meta { color: #94a3b8; font-size: 0.9rem; margin: 0.15rem 0; }
    .verdict-pill {
      display: inline-block; margin-top: 0.9rem; padding: 0.3rem 1rem;
      border-radius: 999px; background: rgba(255,255,255,0.12);
      font-weight: 800; letter-spacing: 0.03em;
    }
    .cover-right { text-align: center; flex-shrink: 0; }
    .cover-right .caption { color: #94a3b8; font-size: 0.8rem; margin-top: 0.3rem; letter-spacing: 0.08em; text-transform: uppercase; }

    .stats {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 0.8rem;
      margin-bottom: 1.6rem;
    }
    .stat {
      background: var(--card); border: 1px solid var(--border); border-radius: 12px;
      padding: 0.9rem 0.6rem; text-align: center;
    }
    .stat .v { font-size: 1.5rem; font-weight: 800; }
    .stat .l { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; }

    section {
      background: var(--card); border: 1px solid var(--border); border-radius: 14px;
      padding: 1.4rem 1.6rem; margin-bottom: 1.4rem;
    }
    h2 { font-size: 1.05rem; margin: 0 0 1rem; letter-spacing: -0.01em; }

    .wcag-head { display: flex; gap: 2rem; align-items: center; flex-wrap: wrap; }
    .wcag-pct { font-size: 3.2rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
    .wcag-pct span { font-size: 1.4rem; }
    .wcag-summary { flex: 1; min-width: 260px; }
    .wcag-claim { margin: 0 0 0.6rem; }
    .level-bars { display: flex; flex-direction: column; gap: 0.4rem; }
    .level-bar { display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; }
    .level-bar span { width: 62px; color: var(--muted); font-weight: 600; }
    .level-bar .bar { flex: 1; height: 10px; background: var(--bg); border-radius: 999px; overflow: hidden; }
    .level-bar .fill { height: 100%; border-radius: 999px; }
    .blockers {
      margin-top: 0.8rem; padding: 0.7rem 0.9rem; border-radius: 10px;
      background: #fef2f2; border: 1px solid #fecaca; font-size: 0.875rem;
    }
    .blockers.pass { background: #f0fdf4; border-color: #bbf7d0; }
    .blockers ul { margin: 0.35rem 0 0; padding-left: 1.2rem; }

    .wcag-table { width: 100%; border-collapse: collapse; margin-top: 1.1rem; font-size: 0.9rem; }
    .wcag-table th { text-align: left; color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 2px solid var(--border); padding: 0.4rem 0.6rem; }
    .wcag-table td { border-bottom: 1px solid var(--border); padding: 0.45rem 0.6rem; }
    .wcag-table tr.fail td { background: #fef2f2; }
    .crit-id { font-family: ui-monospace, Consolas, monospace; font-weight: 700; white-space: nowrap; }
    .level-pill { border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.5rem; font-size: 0.75rem; font-weight: 700; }
    .status.pass { color: var(--success); font-weight: 700; }
    .status.fail { color: #dc2626; font-weight: 700; }
    .bp-tag { color: var(--muted); font-size: 0.72rem; border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.45rem; }
    .limitation { color: var(--muted); font-size: 0.8rem; margin: 0.9rem 0 0; font-style: italic; }

    .checklist ol { margin: 0.5rem 0 0; padding-left: 1.4rem; }
    .fix-item { padding: 0.5rem 0; border-bottom: 1px dashed var(--border); }
    .fix-item:last-child { border-bottom: none; }
    .sev-tag { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; border-radius: 999px; padding: 0.1rem 0.5rem; color: #fff; background: #94a3b8; }
    .fix-item.sev-critical .sev-tag { background: #dc2626; }
    .fix-item.sev-serious .sev-tag, .fix-item.sev-high .sev-tag { background: #ea580c; }
    .fix-item.sev-medium .sev-tag { background: #d97706; }
    .fix-hint { color: var(--muted); font-size: 0.85rem; margin-top: 0.15rem; }
    .fix-where { color: #94a3b8; font-size: 0.75rem; font-family: ui-monospace, Consolas, monospace; margin-top: 0.1rem; word-break: break-all; }

    .finding-category h2 {
      font-size: 0.95rem; letter-spacing: 0.08em; color: var(--muted);
      border-bottom: 2px solid var(--border); padding-bottom: 0.4rem;
    }
    .finding-card {
      background: var(--card); border: 1px solid var(--border); border-left: 4px solid #94a3b8;
      padding: 1rem 1.2rem; margin-bottom: 1rem; border-radius: 10px;
    }
    .finding-group h3 { margin: 0.6rem 0; }
    .badge {
      padding: 0.2rem 0.5rem; border-radius: 999px; font-size: 0.75rem;
      font-weight: bold; color: white; display: inline-block; margin-right: 0.25rem;
    }
    .badge.critical { background-color: #dc2626; }
    .badge.high, .badge.serious { background-color: #ea580c; }
    .badge.medium { background-color: #d97706; }
    .badge.low { background-color: #3b82f6; }
    .badge.info { background-color: #64748b; }
    .badge.confidence-confirmed { background-color: #16a34a; }
    .badge.confidence-high { background-color: #16a34a; }
    .badge.confidence-suspected { background-color: #d97706; }
    .badge.confidence-medium { background-color: #d97706; }
    .badge.confidence-low { background-color: #64748b; }
    .badge.origin { background-color: #8b5cf6; }
    pre {
      background: #f1f5f9; padding: 1rem; border-radius: 8px;
      overflow-x: auto; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word;
    }
    img { max-width: 100%; height: auto; border: 1px solid var(--border); border-radius: 8px; margin-top: 1rem; }
    details { margin-top: 1rem; padding: 0.5rem; background: var(--bg); border-radius: 8px; }
    .muted { color: var(--muted); }
    .footer {
      text-align: center; color: var(--muted); font-size: 0.78rem;
      padding: 1.5rem 0 0.5rem;
    }

    @media print {
      body { background: white; padding: 0; }
      .container { max-width: 100%; }
      .cover { border-radius: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      section, .finding-card { break-inside: avoid; }
      .wcag-table tr.fail td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      a { color: inherit; text-decoration: none; }
      details { display: block; }
      details > summary { display: none; }
      details ul { display: block !important; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="cover">
      <div>
        <h1>Website Quality &amp; Accessibility Report</h1>
        <p class="site">${escapeHtml(run.url)}</p>
        <p class="meta">Scanned ${escapeHtml(date)}${duration ? ` · scan took ${duration}s` : ''}</p>
        <p class="meta">${run.pages ? run.pages.length : 0} page(s) · AI-planned browser + API test matrix</p>
        <span class="verdict-pill" style="background: ${v.tone};">${escapeHtml(v.label)}</span>
      </div>
      <div class="cover-right">
        ${scoreRingSvg(run.score)}
        <div class="caption">Quality score</div>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="v">${run.pages ? run.pages.length : 0}</div><div class="l">Pages</div></div>
      <div class="stat"><div class="v">${totalFindings}</div><div class="l">Findings</div></div>
      <div class="stat"><div class="v">${confirmedBugs}</div><div class="l">Confirmed bugs</div></div>
      <div class="stat"><div class="v">${totalOccurrences}</div><div class="l">Occurrences</div></div>
      <div class="stat"><div class="v">${run.options?.monitorId ? 'Scheduled' : 'Manual'}</div><div class="l">Run type</div></div>
    </div>

    ${wcagSectionHtml(run)}
    ${fixChecklistHtml(run)}

    <section class="findings">
      <h2>All findings</h2>
      ${findingsHtml}
    </section>

    <div class="footer">
      Generated by SQA Agent — autonomous website QA &amp; accessibility monitoring ·
      <a href="/api/runs/${run.runId}/report.json">machine-readable JSON</a>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Generate a machine-readable JSON export of a run.
 *
 * Pairs with generateHtmlReport() — same `run` object, different shape.
 * Designed for CI consumption (jq, SARIF conversion, issue-tracker ingest).
 *
 * Strips Playwright page objects and large capture arrays (consoleLogs,
 * pageExceptions, networkFailures, networkErrors) — those are runtime-only.
 * Keeps apiCalls because that's the new contract-test feed.
 *
 * @param {object} run
 * @returns {string} pretty-printed JSON
 */
export function generateJsonReport(run) {
  const s = run.summary || {};

  const pages = (run.pages || []).map(p => ({
    url: p.url,
    status: p.status,
    title: p.title,
    loadTime: p.loadTime,
    forms: p.forms,
    buttons: p.buttons,
    inputs: p.inputs,
    meta: p.meta || null,
    // New in Phase 0 — captured XHR/fetch traffic (redacted + bounded)
    apiCalls: (p.apiCalls || []).map(c => ({
      method: c.method,
      url: c.url,
      status: c.status,
      // Defense-in-depth: redact again here in case upstream didn't
      requestHeaders: redactHeadersDeep(c.requestHeaders),
      responseHeaders: redactHeadersDeep(c.responseHeaders),
      requestBody: c.requestBody,
      responseBody: c.responseBody,
      responseContentType: c.responseContentType,
      initiator: c.initiator,
      timestamp: c.timestamp,
    })),
  }));

  const findings = (run.findings || []).map(f => ({
    id: f.id,
    title: f.title,
    severity: f.severity,
    confidence: f.confidence,
    category: f.category,
    findingType: f.findingType,
    origin: f.origin,
    ruleId: f.ruleId,
    pageUrl: f.pageUrl,
    description: f.description,
    evidence: f.evidence,
    suggestedFix: f.suggestedFix,
    occurrences: f.occurrences,
    affectedPages: f.affectedPages,
    affectedElements: f.affectedElements,
    reproSteps: f.reproSteps,
    screenshot: f.screenshot,
  }));

  const report = {
    schemaVersion: 1,
    runId: run.runId,
    url: run.url,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    options: run.options,
    score: run.score,
    compliance: computeCompliance(run),
    summary: {
      totalPages: s.totalPages ?? (run.pages ? run.pages.length : 0),
      totalFindings: s.totalFindings ?? findings.length,
      totalOccurrences: s.totalOccurrences ?? findings.length,
      bySeverity: s.bySeverity || { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      byCategory: s.byCategory || {},
      byConfidence: s.byConfidence || { confirmed: 0, high: 0, medium: 0, low: 0 },
      byFindingType: s.byFindingType || { bug: 0, warning: 0, recommendation: 0, informational: 0, environmental: 0 },
      byOrigin: s.byOrigin || { 'first-party': 0, 'third-party': 0, unknown: 0 },
      confirmedBugs: s.confirmedBugs ?? 0,
      observationCount: s.observationCount ?? 0,
      recommendationCount: s.recommendationCount ?? 0,
    },
    pages,
    findings,
    workflowResults: run.workflowResults || [],
    error: run.error || null,
  };

  return JSON.stringify(report, null, 2);
}

/**
 * Generate a branded PDF report for a run.
 *
 * Renders the HTML report in a headless Chromium page and prints it to PDF —
 * the same engine that crawls sites, so no new dependencies.
 *
 * @param {object} run
 * @param {object} [opts]
 * @param {string} [opts.publicUrl] — base URL to serve the HTML from (defaults to localhost:8080)
 * @param {number} [opts.timeoutMs] — page load timeout
 * @returns {Promise<Buffer>} PDF bytes
 */
export async function generatePdfReport(run, opts = {}) {
  const publicUrl = opts.publicUrl || `http://localhost:${process.env.SQA_DASHBOARD_PORT || 8080}`;
  const html = generateHtmlReport(run);
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'report.html');
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, html);

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle', timeout: opts.timeoutMs || 30000 });
    const pdf = await page.pdf({
      width: '8.5in',
      height: '11in',
      printBackground: true,
      preferCSSPageSize: false,
    });
    return pdf;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fs.unlink(htmlPath).catch(() => {});
  }
}
