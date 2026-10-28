import { chromium } from 'playwright';
import { validateUrl } from './ssrf.js';
import { config } from '../utils/config.js';
import { info, warn, error as logError } from '../utils/logger.js';
import { canonicalizeUrl, stripTrackingParams } from '../utils/classify.js';

// Headers that may carry secrets. We keep the *presence* of the header so
// contract tests can verify it's set, but never persist its value.
const SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization|api-key)$/i;

// Cap sampled bodies so a huge response payload doesn't blow up the run JSON.
const MAX_BODY_SAMPLE_CHARS = 5000;

function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

function tryParseBody(text) {
  if (text == null || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON — return truncated string. Keeps payload bounded.
    return typeof text === 'string' ? text.slice(0, MAX_BODY_SAMPLE_CHARS) : null;
  }
}

/**
 * Capture a single XHR/fetch request/response pair as a structured record.
 * Used by the new API-contract executor (Phase 1) and the JSON report export.
 */
async function captureApiCall(response) {
  const request = response.request();
  const resourceType = request.resourceType();
  if (resourceType !== 'xhr' && resourceType !== 'fetch') return null;

  let requestBody = null;
  try {
    const postData = request.postData();
    if (postData) requestBody = tryParseBody(postData);
  } catch { /* ignore */ }

  let responseBody = null;
  let responseContentType = null;
  try {
    responseContentType = response.headers()['content-type'] || null;
    const bodyText = await response.text();
    responseBody = tryParseBody(bodyText);
  } catch { /* some responses (e.g. redirected navigations) cannot be re-read */ }

  return {
    method: request.method(),
    url: response.url(),
    status: response.status(),
    resourceType,
    requestHeaders: redactHeaders(request.headers()),
    responseHeaders: redactHeaders(response.headers()),
    requestBody,
    responseBody,
    responseContentType,
    isNavigation: request.isNavigationRequest(),
    initiator: request.frame() === response.frame() ? 'main-frame' : 'subframe',
    // Captured at response time — useful for waterfall analysis later
    timestamp: new Date().toISOString(),
  };
}

export async function crawlSite({ url, options, onEvent, signal }) {
  const { maxPages = 10, maxDepth = 2, storageState = null } = options || {};

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      // Recorded "login once" session (Rung 3+) — lets the crawl see the
      // authenticated app.
      ...(storageState ? { storageState } : {}),
    });
    
    const parsedStartUrl = new URL(url);
    const origin = parsedStartUrl.origin;
    
    const visited = new Set();
    const queued = new Set();
    const pages = [];
    let dedupCount = 0;
    
    const startCanonical = canonicalizeUrl(url);
    const queue = [{ url, canonicalUrl: startCanonical, depth: 0 }];
    queued.add(startCanonical);
    
    const isIgnoredExtension = (u) => {
      try {
        const p = new URL(u).pathname.toLowerCase();
        const extensions = [
          '.pdf', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', 
          '.mp3', '.mp4', '.avi', '.mov', '.exe', '.dmg',
          '.csv', '.xml', '.json', '.txt', '.rss', '.atom'
        ];
        return extensions.some(ext => p.endsWith(ext));
      } catch (e) {
        return false;
      }
    };

    const isIgnoredProtocol = (u) => {
      return /^(mailto|tel|javascript|data):/i.test(u);
    };

    const shouldSkipUrl = (u) => {
      try {
        const strippedHref = stripTrackingParams(u);
        const urlObj = new URL(strippedHref);
        const queryParamsCount = Array.from(urlObj.searchParams.keys()).length;
        return queryParamsCount > 10;
      } catch (e) {
        return false;
      }
    };

    while (queue.length > 0) {
      if (signal?.aborted) {
        info('Crawl aborted by signal');
        break;
      }
      
      if (visited.size >= maxPages) break;
      
      const current = queue.shift();
      const currentUrl = current.url;
      const normalizedCurrent = current.canonicalUrl || canonicalizeUrl(currentUrl);
      
      if (visited.has(normalizedCurrent)) {
        continue;
      }
      if (current.depth > maxDepth) continue;
      
      try {
        await validateUrl(currentUrl);
      } catch (ssrfErr) {
        warn(`URL failed SSRF validation: ${currentUrl} - ${ssrfErr.message}`);
        continue;
      }
      
      visited.add(normalizedCurrent);
      
      if (onEvent) onEvent(`Crawling ${new URL(currentUrl).pathname || '/'}`);
      
      const page = await context.newPage();
      
      const consoleLogs = [];
      page.on('console', msg => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          consoleLogs.push({ type: msg.type(), text: msg.text(), url: currentUrl, location: msg.location() });
        }
      });
      const pageExceptions = [];
      page.on('pageerror', exception => {
        pageExceptions.push({
          type: 'exception', errorText: exception.message, stack: exception.stack || null,
          url: currentUrl
        });
      });
      
      const networkFailures = [];
      page.on('requestfailed', request => {
        networkFailures.push({
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          failure: request.failure()?.errorText || 'Unknown error',
          isNavigation: request.isNavigationRequest(),
          initiator: request.frame() === page.mainFrame() ? 'main-frame' : 'subframe'
        });
      });
      
      const networkErrors = [];
      const apiCalls = [];
      page.on('response', async response => {
        // Existing 4xx+ capture (kept for backward compatibility)
        if (response.status() >= 400) {
          networkErrors.push({
            url: response.url(),
            status: response.status(),
            method: response.request().method(),
            resourceType: response.request().resourceType(),
            isNavigation: response.request().isNavigationRequest(),
            initiator: response.request().frame() === page.mainFrame() ? 'main-frame' : 'subframe'
          });
        }

        // New: capture all XHR/fetch traffic for the API-contract executor.
        // captureApiCall is async (reads response body) so we fire-and-forget
        // and push the resolved record into apiCalls. Ordering is best-effort
        // by completion, which is fine for downstream contract inference.
        const captured = captureApiCall(response);
        if (captured) {
          captured
            .then(rec => { if (rec) apiCalls.push(rec); })
            .catch(() => { /* swallow — body reads can race with navigation */ });
        }
      });
      
      try {
        const startTime = Date.now();
        const response = await page.goto(currentUrl, { 
          waitUntil: 'domcontentloaded', 
          timeout: config?.pageTimeoutMs || 30000 
        });
        const loadTime = Date.now() - startTime;
        
        const finalUrl = page.url();
        try {
          await validateUrl(finalUrl);
        } catch (ssrfErr) {
          warn(`Final redirected URL failed SSRF validation: ${finalUrl}`);
          await page.close();
          continue;
        }
        
        const status = response ? response.status() : null;
        
        const pageData = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a[href]')].map(a => a.href);
          const images = [...document.querySelectorAll('img')].map((img, index) => {
            const style = getComputedStyle(img);
            return {
              src: img.getAttribute('src'), currentSrc: img.currentSrc || null,
              alt: img.getAttribute('alt'), hasAlt: img.hasAttribute('alt'),
              naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
              loading: img.loading, role: img.getAttribute('role'), ariaLabel: img.getAttribute('aria-label'),
              ariaHidden: img.getAttribute('aria-hidden'), visible: style.visibility !== 'hidden' && style.display !== 'none' && img.getClientRects().length > 0,
              selector: img.id ? `img#${CSS.escape(img.id)}` : (img.getAttribute('data-testid') ? `img[data-testid="${img.getAttribute('data-testid')}"]` : `img:nth-of-type(${index + 1})`)
            };
          });
          const semanticH1 = [...document.querySelectorAll('[role="heading"][aria-level="1"]')].map(el => el.textContent?.trim()).filter(Boolean);
          return {
            title: document.title,
            links,
            images,
            forms: document.querySelectorAll('form').length,
            buttons: document.querySelectorAll('button, [role="button"], input[type="submit"]').length,
            inputs: document.querySelectorAll('input, textarea, select').length,
            metaDescription: document.querySelector('meta[name="description"]')?.content || null,
            h1: document.querySelector('h1')?.textContent?.trim() || null,
            semanticH1,
            viewport: document.querySelector('meta[name="viewport"]')?.content || null,
            favicon: !!document.querySelector('link[rel*="icon"]'),
            doctype: !!document.doctype,
          };
        });
        
        const internalLinks = pageData.links.filter(l => {
          if (isIgnoredProtocol(l)) return false;
          try {
            const u = new URL(l, finalUrl);
            if (u.origin !== origin) return false;
            if (u.hash && u.href.replace(u.hash, '') === new URL(finalUrl).href.replace(new URL(finalUrl).hash, '')) return false;
            if (isIgnoredExtension(u.href)) return false;
            if (shouldSkipUrl(u.href)) return false;
            return true;
          } catch (e) {
            return false;
          }
        });
        
        internalLinks.forEach(l => {
          try {
            const u = new URL(l, finalUrl);
            const nUrl = canonicalizeUrl(u.href);
            if (!visited.has(nUrl) && !queued.has(nUrl)) {
              queued.add(nUrl);
              queue.push({ url: u.href, canonicalUrl: nUrl, depth: current.depth + 1 });
            } else {
              dedupCount++;
            }
          } catch (e) {
            // ignore invalid urls
          }
        });
        
        const pageResult = {
          url: currentUrl,
          status,
          title: pageData.title,
          loadTime,
          links: pageData.links,
          images: pageData.images.map(i => i.src),
          imageDetails: pageData.images,
          forms: pageData.forms,
          buttons: pageData.buttons,
          inputs: pageData.inputs,
          meta: {
            metaDescription: pageData.metaDescription,
            h1: pageData.h1,
            semanticH1: pageData.semanticH1,
            viewport: pageData.viewport,
            favicon: pageData.favicon,
            doctype: pageData.doctype
          },
          consoleLogs,
          pageExceptions,
          networkFailures,
          networkErrors,
          // NEW — captured XHR/fetch traffic, redacted + bounded
          apiCalls,
          page
        };
        
        pages.push(pageResult);
        
      } catch (err) {
        logError(`Failed to crawl ${currentUrl}`, err);
        await page.close().catch(() => {});
      }
    }
    
    info(`Crawling finished. Deduplicated ${dedupCount} URLs.`);
    
    return { pages, browser, context, siteOrigin: origin };
    
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

export async function closeCrawlSession(browser) {
  if (browser) await browser.close().catch(() => {});
}
