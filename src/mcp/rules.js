/**
 * mcp/rules.js — plain-language rule knowledge base for explain_finding.
 *
 * Two sources:
 *   1. TestFlow's own ruleIds (static registry below).
 *   2. axe-core rule IDs — handled by a registry of the most common ones
 *      plus a graceful generic fallback (axe has 90+ rules; the fallback
 *      points the agent at the official axe rule docs). A design choice,
 *      flagged: exact per-rule coverage for every axe ID would bloat this
 *      file for little gain — unknown axe IDs still get actionable output.
 */

const RULES = {
  // ─── API contract ────────────────────────────────────────────────
  'api-status-mismatch': {
    title: 'API returned an unexpected HTTP status',
    explanation: 'An endpoint returned a status code different from the recorded/expected contract. If confidence is "suspected", the probe was replayed anonymously or hit bot protection — verify with a real session before treating it as a bug.',
    suggestedFix: 'If the new status is intended, update the endpoint contract. Otherwise investigate why a normally-successful endpoint changed status.',
  },
  'api-schema-mismatch': {
    title: 'API response shape broke its contract',
    explanation: 'The response body no longer matches the expected field structure (missing or wrongly-typed fields). This usually means a field was renamed or removed server-side.',
    suggestedFix: 'Either restore the documented response shape, or update the recorded contract if the new shape is intended.',
  },
  'api-timeout': {
    title: 'API endpoint timed out',
    explanation: 'The endpoint did not respond within the probe timeout. Could be latency, a hang, or an unreachable endpoint in this environment.',
    suggestedFix: 'Check endpoint latency and availability; if legitimately slow, raise the probe timeout for this endpoint.',
  },
  'api-error': {
    title: 'API endpoint failed',
    explanation: 'The endpoint request failed (network error or 5xx-class response).',
    suggestedFix: 'Verify the endpoint is reachable and healthy from the environment TestFlow runs in.',
  },

  // ─── Console / runtime ───────────────────────────────────────────
  'console-error': {
    title: 'Browser console error',
    explanation: 'The page logged an error to the browser console during the scan. Often a failed resource, a thrown error inside app code, or a bad network response.',
    suggestedFix: 'Reproduce locally with devtools open; fix the underlying error the message points at.',
  },
  'uncaught-exception': {
    title: 'Uncaught JavaScript exception',
    explanation: 'An unhandled exception was thrown at page runtime. Anything after the throw on that code path did not execute.',
    suggestedFix: 'Wrap the failing code path or fix the root cause; add an error boundary if the exception originates inside a UI framework.',
  },

  // ─── Network / links ─────────────────────────────────────────────
  'page-load-failure': {
    title: 'Page failed to load',
    explanation: 'The page did not load (timeout, DNS failure, connection refused, or non-2xx/3xx navigation response). Every check that depends on this page was skipped.',
    suggestedFix: 'Confirm the URL is correct and reachable from this environment; check server logs for the failed navigation.',
  },
  'broken-link-network': {
    title: 'Link unreachable (network error)',
    explanation: 'A link on the page could not be fetched at all — DNS, connection refused, or TLS failure.',
    suggestedFix: 'Fix or remove the link; if the target moved, update the href.',
  },
  'broken-link-timeout': {
    title: 'Link timed out',
    explanation: 'The link target did not respond within the timeout window.',
    suggestedFix: 'Check the target server; if it is legitimately slow, that is still a user-facing problem worth fixing.',
  },

  // ─── Performance ─────────────────────────────────────────────────
  'slow-page-load': {
    title: 'Page load exceeded budget',
    explanation: 'The page took longer to become interactive than the performance budget allows.',
    suggestedFix: 'Profile the page: defer non-critical scripts, compress/resize images, enable caching for static assets.',
  },
  'large-images': {
    title: 'Image asset exceeds size budget',
    explanation: 'One or more images are far larger than needed for their rendered size.',
    suggestedFix: 'Serve appropriately sized images (srcset/responsive sizes) in a modern format (WebP/AVIF).',
  },
  'large-document': {
    title: 'Document/HTML exceeds size budget',
    explanation: 'The HTML document itself is unusually large, slowing first paint and parse time.',
    suggestedFix: 'Trim inlined data, paginate long lists, and remove dead markup.',
  },

  // ─── Security headers / cookies ──────────────────────────────────
  'mixed-content-active': {
    title: 'Active mixed content (HTTP script/iframe on HTTPS page)',
    explanation: 'Scripts or iframes loaded over plain HTTP inside an HTTPS page. Browsers block active mixed content, so these resources silently fail.',
    suggestedFix: 'Serve the resource over HTTPS or bundle it locally.',
  },
  'mixed-content-passive': {
    title: 'Passive mixed content (HTTP image/media on HTTPS page)',
    explanation: 'Images or media loaded over plain HTTP inside an HTTPS page — a security warning for users and a downgrade risk.',
    suggestedFix: 'Switch the asset URL to HTTPS.',
  },
  'cookie-no-secure': {
    title: 'Cookie missing Secure attribute',
    explanation: 'A cookie can be sent over plain HTTP, exposing it to interception.',
    suggestedFix: 'Set the Secure attribute on all cookies.',
  },
  'cookie-no-httponly': {
    title: 'Cookie missing HttpOnly attribute',
    explanation: 'The cookie is readable from JavaScript, so an XSS can steal it.',
    suggestedFix: 'Set HttpOnly on session cookies.',
  },
  'cookie-no-samesite': {
    title: 'Cookie missing SameSite attribute',
    explanation: 'Without SameSite the cookie is sent on cross-site requests, enabling CSRF.',
    suggestedFix: 'Set SameSite=Lax (or Strict for session cookies).',
  },
  'cookie-samesite-none-insecure': {
    title: 'SameSite=None without Secure',
    explanation: 'SameSite=None cookies must also be Secure; browsers reject this combination.',
    suggestedFix: 'Add Secure, or drop SameSite=None if cross-site access is not required.',
  },

  // ─── Visual / E2E / fuzz ─────────────────────────────────────────
  'visual-regression': {
    title: 'Visual regression against baseline',
    explanation: 'The page renders measurably differently from its approved baseline snapshot.',
    suggestedFix: 'If the change is intended, re-approve the baseline; otherwise fix the CSS/layout change that shifted rendering.',
  },
  'visual-baseline-captured': {
    title: 'Visual baseline captured',
    explanation: 'Informational: the first snapshot for this page was recorded and stored as the comparison baseline.',
    suggestedFix: 'No action needed.',
  },
  'e2e-flow-failure': {
    title: 'E2E user flow failed',
    explanation: 'A scripted user journey (clicks/fills/assertions) did not complete successfully.',
    suggestedFix: 'Run the flow manually; the failed step in the repro chain points at the broken behavior.',
  },
  'e2e-flow-selector-timeout': {
    title: 'E2E selector timed out',
    explanation: 'An element a flow expects was not present in time — either removed by a recent change or slow to render.',
    suggestedFix: 'Fix the regression, or update the flow if the UI intentionally changed.',
  },
  'fuzz-failure': {
    title: 'Fuzz input caused a failure',
    explanation: 'Generated input (long strings, special characters, unexpected types) crashed a form or endpoint.',
    suggestedFix: 'Add input validation/escaping for the failing field.',
  },
  'axe-injection-failed': {
    title: 'Could not inject accessibility scanner',
    explanation: 'Environmental: axe-core could not be injected into the page, so the deep a11y audit was skipped (not a site bug).',
    suggestedFix: 'Ensure the browser context allows script injection; bundle axe-core locally.',
  },
};

// Most common axe-core rule IDs — the ones that cover the bulk of real-
// world violations. Anything not listed falls through to the generic axe
// explanation with a docs link.
const AXE_RULES = {
  'color-contrast': {
    title: 'Insufficient color contrast',
    explanation: 'Text does not meet the minimum contrast ratio against its background (4.5:1 normal text, 3:1 large text).',
    suggestedFix: 'Darken the text color or lighten the background until the ratio passes.',
    docs: 'https://deque.github.io/axe-core/rules/color-contrast/',
  },
  'image-alt': {
    title: 'Image missing alt text',
    explanation: 'An <img> has no alt attribute, so screen readers announce the file name or skip it.',
    suggestedFix: 'Add a meaningful alt attribute (or alt="" for purely decorative images).',
  },
  'button-name': {
    title: 'Button has no accessible name',
    explanation: 'A button has no text content, aria-label, or associated label — screen readers announce it as just "button".',
    suggestedFix: 'Add visible text, an aria-label, or an aria-labelledby reference.',
  },
  'link-name': {
    title: 'Link has no accessible name',
    explanation: 'A link has no discernible text (e.g. an icon-only link without a label).',
    suggestedFix: 'Add link text or an aria-label describing the destination.',
  },
  label: {
    title: 'Form field missing a label',
    explanation: 'An input/select/textarea has no associated <label>, placeholder-only naming, or aria-label.',
    suggestedFix: 'Add a <label for="…"> or aria-label for every form control.',
  },
  'aria-valid-attr-value': {
    title: 'Invalid ARIA attribute value',
    explanation: 'An aria-* attribute references something that does not exist (e.g. aria-labelledby pointing at a missing ID).',
    suggestedFix: 'Point the ARIA attribute at a valid element or fix the value format.',
  },
  'aria-valid-attr': {
    title: 'Invalid ARIA attribute',
    explanation: 'An aria-* attribute is misspelled or does not exist.',
    suggestedFix: 'Correct the attribute name.',
  },
  'aria-roles': {
    title: 'Invalid ARIA role',
    explanation: 'A role attribute value is not a valid ARIA role.',
    suggestedFix: 'Use a valid role token from the ARIA spec.',
  },
  region: {
    title: 'Page content outside landmark regions',
    explanation: 'All page content should sit inside landmarks (header, nav, main, aside, footer) so screen-reader users can navigate by region.',
    suggestedFix: 'Wrap content in semantic landmarks or add role="region" with a label.',
  },
  'html-has-lang': {
    title: '<html> missing lang attribute',
    explanation: 'Screen readers need the document language to pick the right pronunciation.',
    suggestedFix: 'Add lang="en" (or the actual language) to the <html> element.',
  },
  'document-title': {
    title: 'Document missing <title>',
    explanation: 'The page has no title — required for screen readers, browser tabs, and search results.',
    suggestedFix: 'Add a descriptive <title> element.',
  },
  'duplicate-id': {
    title: 'Duplicate element ID',
    explanation: 'Two elements share the same id, breaking label associations and ARIA references.',
    suggestedFix: 'Make every id unique.',
  },
  'nested-interactive': {
    title: 'Nested interactive elements',
    explanation: 'An interactive control (button/link) is inside another interactive control — unpredictable for assistive tech.',
    suggestedFix: 'Restructure so interactive elements are siblings, not ancestors.',
  },
  'empty-table-header': {
    title: 'Empty table header',
    explanation: 'A <th> has no text, so column relationships are announced without meaning.',
    suggestedFix: 'Add header text or use a plain <td>.',
  },
};

const PREFIX_RULES = [
  { prefix: 'broken-link-', base: RULES['broken-link-network'] },
  { prefix: 'network-', base: {
    title: 'Network request failure',
    explanation: 'A background request (fetch/XHR) failed or returned an error status during the scan.',
    suggestedFix: 'Check the failing request URL and status in the full report; fix the resource or its caller.',
  } },
  { prefix: 'header-', base: {
    title: 'Security header missing or misconfigured',
    explanation: 'A recommended HTTP security header (CSP, HSTS, X-Frame-Options, …) is absent or weak.',
    suggestedFix: 'Add/repair the header at the web server or CDN level.',
  } },
  { prefix: 'perf-budget-', base: {
    title: 'Performance budget exceeded',
    explanation: 'A measured metric exceeded its configured budget.',
    suggestedFix: 'See which metric (metric in the rule ID, e.g. perf-budget-lcp) and optimize for it.',
  } },
  { prefix: 'workflow-', base: RULES['e2e-flow-failure'] },
];

/**
 * Look up a rule. Returns:
 *   { known: true,  title, explanation, suggestedFix, docs? }
 *   { known: false, title, explanation, suggestedFix, docs? }  (best effort)
 */
export function explainRule(ruleId) {
  const id = String(ruleId || '').trim();
  if (!id) return { known: false, title: 'Unknown rule', explanation: 'No rule ID provided.', suggestedFix: null };

  if (RULES[id]) return { known: true, docs: null, ...RULES[id] };

  const prefixHit = PREFIX_RULES.find(p => id.startsWith(p.prefix));
  if (prefixHit) return { known: true, docs: null, ...prefixHit.base, title: `${prefixHit.base.title} (${id})` };

  const axeId = id.startsWith('axe-') ? id.slice(4) : id;
  if (AXE_RULES[axeId]) return { known: true, docs: AXE_RULES[axeId].docs || null, ...AXE_RULES[axeId] };

  // Generic fallback — most unmatched IDs are axe-core rules (kebab-case).
  return {
    known: false,
    title: id,
    explanation: 'No detailed entry for this rule ID in the local knowledge base. IDs in kebab-case are usually axe-core accessibility rules; check the axe rule documentation for the exact criterion.',
    suggestedFix: 'Resolve the finding title and affected selector in the scan report — they describe what failed and where.',
    docs: 'https://deque.github.io/axe-core/axe-docs/',
  };
}
