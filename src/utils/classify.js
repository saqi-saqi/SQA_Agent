/**
 * URL classification and normalization utilities.
 * Provides first-party/third-party detection, tracking parameter stripping,
 * URL canonicalization for deduplication, and network error classification.
 */

// ---------------------------------------------------------------------------
// Tracking / session parameters to strip during canonicalization
// ---------------------------------------------------------------------------
const TRACKING_PARAMS = new Set([
  // UTM
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  // Click-IDs
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
  'msclkid', 'twclid', 'li_fat_id', 'ttclid',
  // Email marketing
  'mc_cid', 'mc_eid',
  // Analytics / fingerprint
  '_ga', '_gl', '_hsenc', '_hsmi', '__hstc', '__hsfp',
  // Referral
  'ref', 'ref_', 'referer', 'referrer', 'source', 'src',
  // E-commerce / dynamic recommendation
  'pvid', 'scm', 'scm_id', 'spm', 'algo_pvid', 'algo_exp_id',
  'pdp_npi', 'pdp_ext', 'pinPids', 'utparam',
  'sk', 'aff_fcid', 'aff_fsk', 'aff_platform', 'aff_trace_key',
  'terminal_id', 'afSmartRedirect', 'gatewayAdapt',
  'tracelog', '_t', '_r', 'clickid', 'click_id',
  'trk', 'trkInfo',
  // Session
  'sessionid', 'sid', 'nonce',
  'yclid', 'ymclid', '_openstat',
]);

// ---------------------------------------------------------------------------
// Third-party hostname patterns → category
// ---------------------------------------------------------------------------
const THIRD_PARTY_PATTERNS = [
  { pattern: /google-analytics\.com|googletagmanager\.com|analytics\.google\.com/i, category: 'analytics' },
  { pattern: /hotjar\.com|clarity\.ms/i, category: 'analytics' },
  { pattern: /mixpanel\.com|segment\.(io|com)|amplitude\.com|heap\.io/i, category: 'analytics' },
  { pattern: /newrelic\.com|nr-data\.net/i, category: 'analytics' },
  { pattern: /doubleclick\.net|googlesyndication\.com|googleadservices\.com/i, category: 'advertising' },
  { pattern: /facebook\.net|fbcdn\.net|connect\.facebook\.net/i, category: 'advertising' },
  { pattern: /criteo\.(com|net)|outbrain\.com|taboola\.com/i, category: 'advertising' },
  { pattern: /cloudflare\.com|cdnjs\.cloudflare\.com/i, category: 'cdn' },
  { pattern: /jsdelivr\.net|unpkg\.com/i, category: 'cdn' },
  { pattern: /cloudfront\.net|azureedge\.net|akamai(zed)?\.net|fastly\.net/i, category: 'cdn' },
  { pattern: /alicdn\.com/i, category: 'cdn' },
  { pattern: /twitter\.com|x\.com|platform\.twitter\.com/i, category: 'social' },
  { pattern: /linkedin\.com|instagram\.com|pinterest\.com|tiktok\.com/i, category: 'social' },
  { pattern: /bat\.bing\.com|px\.ads\.linkedin\.com/i, category: 'tracking' },
  { pattern: /sentry\.io|bugsnag\.com|rollbar\.com/i, category: 'monitoring' },
];

// Two-part country TLDs for root-domain extraction
const TWO_PART_TLDS = new Set([
  'co.uk', 'com.au', 'co.jp', 'co.kr', 'com.br', 'com.cn',
  'com.mx', 'co.in', 'co.za', 'com.sg', 'com.hk', 'co.nz',
  'com.ar', 'com.tw', 'com.tr', 'com.pk',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRootDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if `urlString` belongs to the same root domain as `originString`.
 */
export function isFirstParty(urlString, originString) {
  try {
    const url = new URL(urlString);
    const origin = new URL(originString);
    if (url.origin === origin.origin) return true;
    return getRootDomain(url.hostname) === getRootDomain(origin.hostname);
  } catch {
    return false;
  }
}

/** 'first-party' | 'third-party' */
export function classifyOrigin(urlString, originString) {
  return isFirstParty(urlString, originString) ? 'first-party' : 'third-party';
}

/**
 * For third-party URLs, return a human-readable category.
 */
export function classifyThirdPartyCategory(urlString) {
  try {
    const hostname = new URL(urlString).hostname.toLowerCase();
    for (const { pattern, category } of THIRD_PARTY_PATTERNS) {
      if (pattern.test(hostname)) return category;
    }
    return 'other';
  } catch {
    return 'unknown';
  }
}

/** True if `param` is a known tracking / session parameter. */
export function isTrackingParam(param) {
  return TRACKING_PARAMS.has(param.toLowerCase());
}

/** Remove tracking parameters from a URL string. */
export function stripTrackingParams(urlString) {
  try {
    const url = new URL(urlString);
    const toDelete = [];
    for (const key of url.searchParams.keys()) {
      if (isTrackingParam(key)) toDelete.push(key);
    }
    for (const key of toDelete) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return urlString;
  }
}

/**
 * Full canonicalization pipeline:
 *   raw URL → remove fragment → strip tracking params → sort params → normalize trailing slash
 */
export function canonicalizeUrl(urlString) {
  try {
    const url = new URL(urlString);
    url.hash = '';
    const toDelete = [];
    for (const key of url.searchParams.keys()) {
      if (isTrackingParam(key)) toDelete.push(key);
    }
    for (const key of toDelete) url.searchParams.delete(key);
    url.searchParams.sort();
    let result = url.toString();
    if (result.endsWith('/') && url.pathname === '/' && !url.search) {
      result = result.slice(0, -1);
    }
    return result;
  } catch {
    return urlString;
  }
}

/** True if the error text represents an environmental / browser-level block. */
export function isEnvironmentalError(errorText) {
  if (!errorText) return false;
  const patterns = [
    /ERR_ABORTED/i,
    /ERR_BLOCKED_BY_ORB/i,
    /ERR_BLOCKED_BY_CLIENT/i,
    /ERR_BLOCKED_BY_RESPONSE/i,
    /CORS/i,
    /Mixed Content/i,
    /cross-origin/i,
  ];
  return patterns.some(p => p.test(errorText));
}

/**
 * Classify a network error string into a machine-readable bucket.
 */
export function classifyNetworkError(errorText) {
  if (!errorText) return 'unknown';
  if (/ERR_ABORTED/i.test(errorText)) return 'aborted';
  if (/ERR_BLOCKED/i.test(errorText)) return 'blocked';
  if (/CORS|cross-origin/i.test(errorText)) return 'cors';
  if (/ERR_NAME_NOT_RESOLVED|DNS/i.test(errorText)) return 'dns';
  if (/ERR_CONNECTION_REFUSED/i.test(errorText)) return 'connection-refused';
  if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|timeout/i.test(errorText)) return 'timeout';
  if (/ERR_SSL|ERR_CERT|certificate/i.test(errorText)) return 'ssl';
  return 'network-error';
}

const AUTH_PATH = /\/(login|signin|sign-in|logout|auth|oauth|token|session|accounts?)(\/|$|[?#])/i;
const OPTIONAL_TYPES = new Set(['image', 'font', 'media', 'manifest', 'other']);

/**
 * Classify a raw response/request failure without treating a transport event as
 * an application defect.
 */
export function classifyNetworkObservation(observation, siteOrigin) {
  const url = observation.url || '';
  const status = observation.status ?? null;
  const origin = classifyOrigin(url, siteOrigin);
  const thirdPartyCategory = origin === 'third-party' ? classifyThirdPartyCategory(url) : null;
  const resourceType = observation.resourceType || 'other';
  const method = (observation.method || 'GET').toUpperCase();
  const failureClass = observation.failure ? classifyNetworkError(observation.failure) : null;
  const authContext = Boolean(observation.isAuthenticationPage || AUTH_PATH.test(url) || AUTH_PATH.test(observation.pageUrl || ''));
  const required = Boolean(observation.required) || ['document', 'xhr', 'fetch'].includes(resourceType);
  const repeated = (observation.occurrences || 1) > 1;
  const base = { origin, thirdPartyCategory, status, method, resourceType, failureClass, required, authContext };

  if (failureClass === 'aborted') {
    if (required && repeated && !observation.isNavigation) return { ...base, category: 'aborted', findingType: 'warning', confidence: 'medium', severity: 'low', report: true };
    return { ...base, category: 'aborted', findingType: 'environmental', confidence: 'low', severity: 'info', report: false };
  }
  if (failureClass === 'cors') {
    if (origin === 'first-party' && required) return { ...base, category: 'cors', findingType: 'bug', confidence: 'high', severity: 'medium', report: true };
    return { ...base, category: 'cors', findingType: origin === 'third-party' ? 'environmental' : 'warning', confidence: 'low', severity: 'info', report: true };
  }
  if (failureClass === 'blocked') return { ...base, category: 'blocked', findingType: 'environmental', confidence: 'low', severity: 'info', report: false };
  if (failureClass) {
    const environmental = ['dns', 'connection-refused', 'timeout', 'ssl'].includes(failureClass);
    return { ...base, category: failureClass, findingType: environmental ? 'environmental' : 'warning', confidence: environmental ? 'low' : 'medium', severity: environmental ? 'info' : 'low', report: true };
  }

  if (status === 401 || status === 403) {
    if (authContext) return { ...base, category: status === 401 ? 'authentication' : 'authorization', findingType: 'informational', confidence: 'high', severity: 'info', report: false };
    if (origin === 'first-party' && required) return { ...base, category: status === 401 ? 'authentication' : 'authorization', findingType: 'warning', confidence: 'medium', severity: 'low', report: true };
    return { ...base, category: status === 401 ? 'authentication' : 'authorization', findingType: 'informational', confidence: 'low', severity: 'info', report: false };
  }
  if (status >= 500) {
    if (origin === 'first-party' && required) return { ...base, category: 'server-error', findingType: 'bug', confidence: 'confirmed', severity: resourceType === 'document' ? 'high' : 'medium', report: true };
    return { ...base, category: 'third-party', findingType: 'environmental', confidence: 'low', severity: 'info', report: true };
  }
  if (status >= 400) {
    if (origin === 'first-party' && required && !authContext) return { ...base, category: 'client-error', findingType: 'warning', confidence: 'high', severity: status === 404 && resourceType === 'document' ? 'medium' : 'low', report: true };
    return { ...base, category: origin === 'third-party' ? 'third-party' : 'client-error', findingType: origin === 'third-party' ? 'environmental' : 'warning', confidence: 'low', severity: 'info', report: origin === 'third-party' && !OPTIONAL_TYPES.has(resourceType) };
  }
  return { ...base, category: 'unknown', findingType: 'informational', confidence: 'low', severity: 'info', report: false };
}

/** Browser console output has a different meaning from a JavaScript exception. */
export function classifyConsoleObservation(log, siteOrigin) {
  const message = log.text || '';
  if (/Failed to load resource|net::ERR_|CORS|cross-origin/i.test(message)) return { kind: 'resource-failure', report: false };
  if (/deprecated|deprecation|warning/i.test(message)) return { kind: 'warning', report: true, findingType: 'informational', confidence: 'low', severity: 'info' };
  if (log.type === 'exception' || /Uncaught|Unhandled promise rejection/i.test(message)) {
    const origin = classifyOrigin(log.sourceUrl || log.url || siteOrigin, siteOrigin);
    return { kind: 'exception', report: true, origin, findingType: origin === 'third-party' ? 'environmental' : 'bug', confidence: origin === 'third-party' ? 'low' : 'confirmed', severity: origin === 'third-party' ? 'info' : 'medium' };
  }
  return { kind: 'console-error', report: true, findingType: 'warning', confidence: 'medium', severity: 'low' };
}
