import { classifyNetworkObservation } from '../../utils/classify.js';

export async function checkNetwork(pages, createFinding, onEvent, siteOrigin) {
  onEvent?.('Starting network checks...');
  const findings = [];
  
  const noisePatterns = [
    /favicon\.ico/i,
    /manifest\.json/i,
    /\.map$/i
  ];

  const map = new Map();

  for (const page of pages) {
    if (!page.networkFailures && !page.networkErrors) continue;
    
    // Process network failures
    for (const fail of (page.networkFailures || [])) {
      if (noisePatterns.some(p => p.test(fail.url))) continue;
      
      const key = `${fail.url}-fail-${fail.failure}-${fail.resourceType}-${fail.method}`;
      if (!map.has(key)) {
        map.set(key, { type: 'failure', data: fail, pages: [] });
      }
      map.get(key).pages.push(page.url);
    }

    // Process network errors
    for (const err of (page.networkErrors || [])) {
      if (noisePatterns.some(p => p.test(err.url))) continue;

      const key = `${err.url}-err-${err.status}-${err.resourceType}-${err.method}`;
      if (!map.has(key)) {
        map.set(key, { type: 'error', data: err, pages: [] });
      }
      map.get(key).pages.push(page.url);
    }
  }

  for (const [key, item] of map.entries()) {
    const affectedPages = [...new Set(item.pages)];
    const occurrences = item.pages.length;
    const pageUrl = affectedPages[0];

    const url = item.data.url;
    const classification = classifyNetworkObservation({ ...item.data, pageUrl, occurrences, isAuthenticationPage: /\/(login|signin|auth|oauth)(\/|$|[?#])/i.test(pageUrl) }, siteOrigin);
    if (!classification.report) continue;
    const detail = item.type === 'error' ? `HTTP ${item.data.status}` : item.data.failure;
    const title = item.type === 'error' ? `${detail} ${classification.category} response` : `${classification.category} request failure`;
    const description = classification.findingType === 'bug'
      ? `A required first-party ${item.data.resourceType} request failed with ${detail}.`
      : `Observed ${detail} while loading a ${item.data.resourceType} resource; this was classified from request context and is not automatically an application defect.`;
    const evidence = [
      `Request URL: ${url}`, `Page URL: ${pageUrl}`, `Method: ${item.data.method}`, `Resource type: ${item.data.resourceType}`,
      `Observed: ${detail}`, `Origin: ${classification.origin}`, classification.thirdPartyCategory ? `Third-party category: ${classification.thirdPartyCategory}` : null,
      `Occurrences: ${occurrences}`
    ].filter(Boolean).join('\n');

    findings.push(createFinding({
      title,
      severity: classification.severity,
      confidence: classification.confidence,
      category: 'network',
      findingType: classification.findingType,
      origin: classification.origin,
      ruleId: `network-${classification.category}-${item.data.status || classification.failureClass}`,
      pageUrl,
      description,
      evidence,
      occurrences,
      affectedPages
    }));
  }

  onEvent?.('Network checks completed.');
  return findings;
}
