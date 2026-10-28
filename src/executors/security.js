/**
 * executors/security.js — security headers + mixed content + cookie audit.
 *
 * Consumes: plan.pages[] (for URLs to probe) + crawler's captured headers
 * Produces: findings for missing/insecure headers, mixed content, bad cookies
 *
 * No Playwright needed — uses fetch. Fully testable.
 *
 * Reference standards:
 *   • OWASP Secure Headers Project
 *   • Mozilla Observatory
 *   • CSP Level 3
 */

// ─── security header rules ──────────────────────────────────────────

const HEADER_RULES = [
  {
    name: 'content-security-policy',
    severity: 'high',
    description: 'Content-Security-Policy (CSP) prevents XSS, clickjacking, and injection attacks.',
    fix: "Add a Content-Security-Policy header. Start strict: `default-src 'self'`.",
    check: (val) => val != null && val.trim().length > 0,
  },
  {
    name: 'strict-transport-security',
    severity: 'high',
    description: 'HSTS forces HTTPS, preventing protocol downgrade attacks.',
    fix: 'Add `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.',
    check: (val) => val != null && /max-age\s*=\s*\d{4,}/i.test(val),
    onlyHttps: true,
  },
  {
    name: 'x-frame-options',
    severity: 'medium',
    description: 'X-Frame-Options prevents clickjacking by controlling iframe embedding.',
    fix: 'Add `X-Frame-Options: DENY` or use CSP `frame-ancestors`.',
    check: (val) => val != null && /^(deny|sameorigin)$/i.test(val.trim()),
    // Note: superseded by CSP frame-ancestors, but still recommended as defense-in-depth
  },
  {
    name: 'x-content-type-options',
    severity: 'medium',
    description: 'X-Content-Type-Options: nosniff prevents MIME-type sniffing attacks.',
    fix: 'Add `X-Content-Type-Options: nosniff`.',
    check: (val) => val != null && /nosniff/i.test(val),
  },
  {
    name: 'referrer-policy',
    severity: 'low',
    description: 'Referrer-Policy controls how much referrer info is leaked to other sites.',
    fix: 'Add `Referrer-Policy: strict-origin-when-cross-origin`.',
    check: (val) => val != null && val.trim().length > 0,
  },
  {
    name: 'permissions-policy',
    severity: 'low',
    description: 'Permissions-Policy controls which browser features (camera, mic, geo) the page can use.',
    fix: 'Add `Permissions-Policy: camera=(), microphone=(), geolocation=()`.',
    check: (val) => val != null && val.trim().length > 0,
  },
  {
    name: 'cross-origin-opener-policy',
    severity: 'low',
    description: 'COOP isolates browsing context groups, mitigating cross-origin attacks.',
    fix: 'Add `Cross-Origin-Opener-Policy: same-origin`.',
    check: (val) => val != null && /same-origin/i.test(val),
  },
  {
    name: 'cross-origin-resource-policy',
    severity: 'low',
    description: 'CORP prevents cross-origin resources from being loaded by other origins.',
    fix: 'Add `Cross-Origin-Resource-Policy: same-site` (or `same-origin` for stricter isolation).',
    check: (val) => val != null && /^(same-site|same-origin|cross-origin)$/i.test(val.trim()),
  },
];

// ─── cookie rules ────────────────────────────────────────────────────

export function analyzeCookie(cookieStr, pageUrl) {
  const issues = [];
  const parts = cookieStr.split(';').map(s => s.trim());
  const name = parts[0]?.split('=')[0];
  const attrs = parts.slice(1).map(p => p.toLowerCase());
  const hasSecure = attrs.some(a => a === 'secure');
  const hasHttpOnly = attrs.some(a => a === 'httponly');
  const hasSameSite = attrs.some(a => a.startsWith('samesite'));
  const sameSiteNone = attrs.find(a => a.startsWith('samesite=none'));
  const sameSiteVal = sameSiteNone?.split('=')[1];

  // Is this an HTTPS page?
  const isHttps = /^https:/i.test(pageUrl);

  if (isHttps && !hasSecure) {
    issues.push({
      ruleId: 'cookie-no-secure',
      severity: 'high',
      message: `Cookie "${name}" missing Secure flag over HTTPS`,
      fix: 'Add the `Secure` attribute to the Set-Cookie header.',
    });
  }
  if (!hasHttpOnly) {
    issues.push({
      ruleId: 'cookie-no-httponly',
      severity: 'medium',
      message: `Cookie "${name}" missing HttpOnly flag (accessible to JavaScript)`,
      fix: 'Add the `HttpOnly` attribute to prevent XSS-based cookie theft.',
    });
  }
  if (!hasSameSite) {
    issues.push({
      ruleId: 'cookie-no-samesite',
      severity: 'medium',
      message: `Cookie "${name}" missing SameSite attribute`,
      fix: 'Add `SameSite=Lax` (or `Strict` for sensitive cookies).',
    });
  } else if (sameSiteVal === 'none' && !hasSecure) {
    issues.push({
      ruleId: 'cookie-samesite-none-insecure',
      severity: 'high',
      message: `Cookie "${name}" has SameSite=None without Secure`,
      fix: 'SameSite=None requires the Secure attribute.',
    });
  }

  return issues;
}

// ─── mixed content detection ────────────────────────────────────────

/**
 * Detect mixed content on HTTPS pages by checking the captured apiCalls
 * (XHR/fetch to HTTP origins from an HTTPS page = mixed content).
 */
export function detectMixedContent(page) {
  const issues = [];
  if (!/^https:/i.test(page.url)) return issues;

  for (const call of page.apiCalls || []) {
    if (/^http:/i.test(call.url)) {
      issues.push({
        ruleId: 'mixed-content-active',
        severity: 'high',
        message: `Active mixed content: ${call.method} ${call.url}`,
        fix: 'Upgrade the resource URL to HTTPS or remove the request.',
      });
    }
  }

  // Check image srcs too — passive mixed content
  for (const img of page.imageDetails || []) {
    if (img.src && /^http:/i.test(img.src)) {
      issues.push({
        ruleId: 'mixed-content-passive',
        severity: 'medium',
        message: `Passive mixed content: image ${img.src}`,
        fix: 'Upgrade the image URL to HTTPS.',
      });
    }
  }

  return issues;
}

// ─── main executor ───────────────────────────────────────────────────

/**
 * Probe each page's URL via fetch, capture response headers, run all rules.
 * Skips pages whose URL is unreachable — those will already have been
 * flagged by the crawler.
 */
export async function probeSecurityHeaders(pageUrl, ctx) {
  const fetchImpl = ctx.options?.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error('No fetch available — pass ctx.options.fetch');
  const timeoutMs = ctx.options?.timeout ?? 10000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (ctx.signal) {
    if (ctx.signal.aborted) ctrl.abort();
    else ctx.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  try {
    const response = await fetchImpl(pageUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const headers = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

    return {
      ok: true,
      status: response.status,
      headers,
      cookies: response.headers.getSetCookie?.() || [],
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Main executor entry — registered as 'security' in the registry. */
export default async function securityExecutor(ctx) {
  const pages = ctx.plan?.pages || [];
  const findings = [];

  ctx.onEvent?.(`Auditing security headers for ${pages.length} pages`);

  // De-dup URLs (pages + viewports may share a URL)
  const urls = new Set();
  for (const page of pages) {
    urls.add(page.url);
  }

  for (const url of urls) {
    if (ctx.signal?.aborted) break;

    const isHttps = /^https:/i.test(url);
    const probe = await probeSecurityHeaders(url, ctx);
    if (!probe.ok) {
      // Network failure — already flagged by crawler; skip
      continue;
    }

    // Header rules
    for (const rule of HEADER_RULES) {
      if (rule.onlyHttps && !isHttps) continue;

      const value = probe.headers[rule.name];
      const passed = rule.check(value);
      if (!passed) {
        findings.push(ctx.createFinding({
          title: `Missing or invalid ${rule.name} header`,
          severity: rule.severity,
          confidence: 'confirmed',
          category: 'network',
          findingType: rule.severity === 'low' ? 'recommendation' : 'bug',
          origin: 'first-party',
          ruleId: `header-${rule.name}`,
          pageUrl: url,
          description: `${rule.description} Current value: ${value || '(missing)'}`,
          suggestedFix: rule.fix,
        }));
      }
    }

    // Cookie rules
    for (const cookie of probe.cookies) {
      const issues = analyzeCookie(cookie, url);
      for (const issue of issues) {
        findings.push(ctx.createFinding({
          title: issue.message,
          severity: issue.severity,
          confidence: 'confirmed',
          category: 'network',
          findingType: 'bug',
          origin: 'first-party',
          ruleId: issue.ruleId,
          pageUrl: url,
          description: `Cookie: ${cookie}`,
          suggestedFix: issue.fix,
        }));
      }
    }
  }

  // Mixed content — uses crawler's captured data, no fetch needed
  for (const page of pages) {
    const issues = detectMixedContent(page);
    for (const issue of issues) {
      findings.push(ctx.createFinding({
        title: issue.message,
        severity: issue.severity,
        confidence: 'confirmed',
        category: 'network',
        findingType: 'bug',
        origin: 'first-party',
        ruleId: issue.ruleId,
        pageUrl: page.url,
        suggestedFix: issue.fix,
      }));
    }
  }

  ctx.onEvent?.(`security complete: ${findings.length} findings`);
  return {
    findings,
    stats: {
      pagesAudited: urls.size,
      headerFindings: findings.filter(f => f.ruleId?.startsWith('header-')).length,
      cookieFindings: findings.filter(f => f.ruleId?.startsWith('cookie-')).length,
      mixedContentFindings: findings.filter(f => f.ruleId?.startsWith('mixed-content')).length,
    },
  };
}
