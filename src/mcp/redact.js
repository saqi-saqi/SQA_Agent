/**
 * mcp/redact.js — privacy boundary for MCP tool responses.
 *
 * The calling agent is an EXTERNAL consumer — same trust level as the LLM
 * provider. Nothing leaves this process for an MCP caller without passing
 * through this file:
 *
 *   • URLs are sanitized with the SAME sanitizeUrlForPrompt() used for LLM
 *     prompts (origin + path + parameter NAMES, never values).
 *   • Free-text fields (evidence, description, error messages) are scrubbed
 *     against credential patterns: Bearer tokens, JWTs, cookie values,
 *     key=value secrets.
 *
 * This mirrors the LLM boundary documented in ../explorer/prompts.js — one
 * concept, two enforcement points, both locked by tests.
 */
import { sanitizeUrlForPrompt } from '../explorer/prompts.js';
import { isUnauthenticatedProbe } from '../services/scoring.js';

export { sanitizeUrlForPrompt as sanitizeUrl };
const sanitizeUrl = sanitizeUrlForPrompt;

// Credential patterns scrubbed from any free text that reaches an agent.
// Ordered: most specific first, so narrower patterns win.
const SECRET_PATTERNS = [
  // JWTs (three base64url segments)
  { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, replacement: '[REDACTED_JWT]' },
  // Bearer / Basic credentials
  { re: /\b(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi, replacement: '$1 [REDACTED]' },
  // Cookie values: "cookie: a=b; session=xyz" → values stripped
  { re: /((?:set-)?cookie\s*[:=]\s*)[^\n\r"']+/gi, replacement: '$1[REDACTED]' },
  // key=value / "key": "value" secrets
  { re: /(["']?(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret|password|passwd|session[_-]?id|sessionid|x-api-key|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
    replacement: '$1[REDACTED]' },
  // Long hex/base64ish secrets (32+ chars) — likely tokens, never prose
  { re: /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, replacement: '[REDACTED_TOKEN]' },
];

/** Scrub credential material from a free-text string. */
export function scrubText(text) {
  if (text == null) return '';
  let out = String(text);
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** Scrub an error into an agent-safe message. NEVER returns stack traces. */
export function sanitizeError(err) {
  const message = err instanceof Error ? err.message : String(err?.message ?? err ?? 'Unknown error');
  return scrubText(message).slice(0, 500);
}

/**
 * Build the agent-facing shape of one finding.
 *
 * verbosity "summary" (default): {rule, severity, url, selector,
 * suggestedFix, confidence, title} — no raw evidence blobs.
 * verbosity "full": everything, still redacted.
 */
export function redactFinding(finding, verbosity = 'summary') {
  const rawRule = finding.ruleId || finding.id || 'unknown';
  const rule = rawRule.replace(/^axe-/, '');
  const base = {
    rule,
    // ruleId preserved (not sensitive) — the invariant validator keys on it.
    ruleId: finding.ruleId || null,
    severity: finding.severity || 'info',
    url: sanitizeUrl(finding.pageUrl || finding.url || ''),
    selector: finding.selector || getNodeSignatureLocal(finding),
    suggestedFix: finding.suggestedFix ? scrubText(finding.suggestedFix) : null,
    confidence: finding.confidence || 'unknown',
    title: finding.title ? scrubText(finding.title) : '',
    // Classification metadata — lets the shared validateReport() invariant
    // gate re-derive bucket counts from the redacted shape itself. The
    // unauthenticated flag is a boolean, not credential material.
    findingType: finding.findingType || null,
    category: finding.category || null,
    unauthenticated: isUnauthenticatedProbeLocal(finding),
  };

  if (verbosity !== 'full') return base;

  return {
    ...base,
    id: finding.id || null,
    category: finding.category || null,
    findingType: finding.findingType || null,
    origin: finding.origin || null,
    description: finding.description ? scrubText(finding.description) : null,
    evidence: finding.evidence ? scrubText(finding.evidence) : null,
    occurrences: finding.occurrences ?? 1,
    affectedPages: (finding.affectedPages || []).map(sanitizeUrl),
    affectedElements: finding.affectedElements ?? null,
    reproSteps: (finding.reproSteps || []).map(scrubText),
    metrics: finding.metrics ? scrubMetrics(finding.metrics) : null,
  };
}

/** Fallback node signature (kept in sync with matrixRunner.getNodeSignature). */
function getNodeSignatureLocal(finding) {
  if (finding.target) {
    return Array.isArray(finding.target) ? finding.target.join(' ') : String(finding.target);
  }
  return '';
}

/**
 * Freeze the unauthenticated/suspected classification as a boolean flag on
 * the redacted shape, so downstream validation classifies identically to
 * the scan pipeline regardless of which text fields survived redaction.
 */
function isUnauthenticatedProbeLocal(finding) {
  try { return isUnauthenticatedProbe(finding) === true; } catch { return false; }
}

/** Metrics are numeric or unmeasured markers — scrub any embedded strings. */
function scrubMetrics(metrics) {
  const out = {};
  for (const [k, v] of Object.entries(metrics)) {
    out[k] = typeof v === 'string' ? scrubText(v) : v;
  }
  return out;
}
