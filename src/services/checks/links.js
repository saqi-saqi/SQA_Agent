import { classifyOrigin } from '../../utils/classify.js';
import { validateUrlSafe } from '../ssrf.js';

const MAX_LINKS_TO_CHECK = 50;
const BATCH_SIZE = 5;
const TIMEOUTS = [2000, 3500, 5000];

/**
 * Checks a list of pages for broken links.
 * 
 * @param {Array} pages - Array of crawled PageResult objects.
 * @param {Function} createFinding - Factory function for creating findings.
 * @param {Function} onEvent - Progress callback.
 * @param {AbortSignal} signal - Abort signal.
 * @param {String} siteOrigin - The origin URL of the site being tested.
 * @returns {Array} List of findings.
 */
export async function checkLinks(pages, createFinding, onEvent, signal, siteOrigin) {
    if (!pages || pages.length === 0) return [];
    const findings = [];

    // 1. Gather all unique links and their sources
    const linkSources = new Map();
    for (const page of pages) {
        if (!page.links || !Array.isArray(page.links)) continue;
        for (const link of page.links) {
            try {
                const urlObj = new URL(link);
                if (!['http:', 'https:'].includes(urlObj.protocol)) continue;
                
                const href = urlObj.href;
                if (!linkSources.has(href)) {
                    linkSources.set(href, new Set());
                }
                linkSources.get(href).add(page.url);
            } catch (e) {
                // Ignore invalid URLs
            }
        }
    }

    // 2. Select and sort links to check
    let linksToCheck = Array.from(linkSources.entries()).map(([link, sources]) => {
        return { link, sources: Array.from(sources) };
    });

    // Cross-reference with crawl data: filter out links that successfully loaded in crawl
    linksToCheck = linksToCheck.filter(({ link }) => {
        return !pages.some(p => p.url === link && p.status === 200);
    });

    // Sort: internal first
    linksToCheck.sort((a, b) => {
        const aFirst = classifyOrigin(a.link, siteOrigin) === 'first-party';
        const bFirst = classifyOrigin(b.link, siteOrigin) === 'first-party';
        if (aFirst && !bFirst) return -1;
        if (!aFirst && bFirst) return 1;
        return 0;
    });

    linksToCheck = linksToCheck.slice(0, MAX_LINKS_TO_CHECK);

    // 3. Batch process links
    for (let i = 0; i < linksToCheck.length; i += BATCH_SIZE) {
        if (signal?.aborted) break;
        const batch = linksToCheck.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async ({ link, sources }) => {
            if (signal?.aborted) return;
            
            // SSRF Check
            const ssrfResult = await validateUrlSafe(link);
            if (!ssrfResult.safe) return;

            const origin = classifyOrigin(link, siteOrigin);
            const isFirst = origin === 'first-party';

            let result = null;
            let errorType = null;
            let timedOut = false;

            // Retry logic for timeouts
            for (let attempt = 0; attempt < TIMEOUTS.length; attempt++) {
                if (signal?.aborted) return;
                const timeoutMs = TIMEOUTS[attempt];
                const abortController = new AbortController();
                const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
                
                const onAbort = () => abortController.abort();
                signal?.addEventListener('abort', onAbort);

                try {
                    let res = await fetch(link, { 
                        method: 'HEAD', 
                        signal: abortController.signal,
                        headers: { 'User-Agent': 'QAgent/1.0' }
                    });

                    // HEAD fallback to GET for 405, 403, 429
                    if ([405, 403, 429].includes(res.status)) {
                        res = await fetch(link, { 
                            method: 'GET', 
                            signal: abortController.signal,
                            headers: { 'User-Agent': 'QAgent/1.0' }
                        });
                    }

                    result = res;
                    clearTimeout(timeoutId);
                    signal?.removeEventListener('abort', onAbort);
                    break; // Success or HTTP error response, stop retrying
                } catch (err) {
                    clearTimeout(timeoutId);
                    signal?.removeEventListener('abort', onAbort);
                    
                    if (err.name === 'AbortError') {
                        if (signal?.aborted) return; // Parent aborted
                        timedOut = true;
                        errorType = 'timeout';
                        // Continue to next iteration for retry
                    } else {
                        // Network error (DNS, Connection Refused, etc)
                        errorType = 'network';
                        timedOut = false;
                        break; // Don't retry network errors
                    }
                }
            }

            if (signal?.aborted) return;

            // Analyze result and create finding
            if (result) {
                const status = result.status;
                if (status >= 400) {
                    // Login and scraper-protection responses do not prove a link
                    // is broken for an authenticated user.
                    if ([401, 403].includes(status)) return;

                    const confirmedInternalBroken = isFirst && [404, 410].includes(status);
                    const severity = confirmedInternalBroken ? 'medium' : (isFirst && status >= 500 ? 'medium' : 'info');

                    findings.push(createFinding({
                        title: confirmedInternalBroken ? `Confirmed broken internal link (HTTP ${status})` : `Link response HTTP ${status}`,
                        severity,
                        confidence: confirmedInternalBroken ? 'confirmed' : 'low',
                        category: 'links',
                        findingType: confirmedInternalBroken ? 'bug' : (isFirst ? 'warning' : 'environmental'),
                        origin,
                        ruleId: `broken-link-${status}`,
                        pageUrl: sources[0],
                        description: confirmedInternalBroken ? `The explicitly checked first-party navigation link returned HTTP ${status}.` : `The checked link returned HTTP ${status}; ownership and user impact could not be established from this request alone.`,
                        evidence: `Request URL: ${link}\nHTTP status: ${status}\nOrigin: ${origin}`,
                        occurrences: sources.length,
                        affectedPages: sources,
                        affectedElements: [link]
                    }));
                }
            } else if (timedOut) {
                // Timeout
                const severity = isFirst ? 'medium' : 'info';
                const confidence = isFirst ? 'medium' : 'low';
                
                findings.push(createFinding({
                    title: 'Navigation timeout (not confirmed broken)',
                    severity,
                    confidence,
                    category: 'links',
                    findingType: isFirst ? 'warning' : 'environmental',
                    origin,
                    ruleId: 'broken-link-timeout',
                    pageUrl: sources[0],
                    description: `The link to ${link} timed out after multiple attempts. It is not confirmed broken.`,
                    evidence: `Timed out after ${TIMEOUTS.length} attempts`,
                    occurrences: sources.length,
                    affectedPages: sources,
                    affectedElements: [link]
                }));
            } else if (errorType === 'network') {
                // A direct test from this environment cannot establish whether
                // DNS/connectivity is an application defect.
                findings.push(createFinding({
                    title: 'Link network failure (verification needed)',
                    severity: 'info',
                    confidence: 'low',
                    category: 'links',
                    findingType: 'environmental',
                    origin,
                    ruleId: 'broken-link-network',
                    pageUrl: sources[0],
                    description: `The test environment could not reach ${link}. This does not by itself establish a broken application link.`,
                    evidence: `Request URL: ${link}\nNetwork error type: ${errorType || 'unknown'}`,
                    occurrences: sources.length,
                    affectedPages: sources,
                    affectedElements: [link]
                }));
            }

            if (onEvent) {
                onEvent(`Checked link: ${link}`);
            }
        }));
    }

    return findings;
}
