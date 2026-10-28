import { classifyConsoleObservation } from '../../utils/classify.js';

export async function checkConsole(pages, createFinding, onEvent, siteOrigin) {
  onEvent?.('Starting console checks...');
  const findings = [];

  const noisePatterns = [
    /Refused to get unsafe header/i,
    /possible EventEmitter memory leak/i,
    /^undefined$/i,
    /ResizeObserver loop/i,
    /ServiceWorker/i,
    /Service Worker/i
  ];

  const map = new Map();

  for (const page of pages) {
    if (page.consoleLogs) {
      for (const log of page.consoleLogs) {
        const msg = log.text;
        const key = `console-${msg}`;
        if (!map.has(key)) {
          map.set(key, { type: 'console', log, pages: [] });
        }
        map.get(key).pages.push(page.url);
      }
    }

    if (page.pageExceptions) {
      for (const exc of page.pageExceptions) {
        const msg = exc.errorText || exc.message || String(exc);
        const key = `exception-${msg}`;
        if (!map.has(key)) {
          map.set(key, { type: 'exception', exc, pages: [], url: exc.url || page.url });
        }
        map.get(key).pages.push(page.url);
      }
    }
  }

  for (const [key, item] of map.entries()) {
    const affectedPages = [...new Set(item.pages)];
    const occurrences = affectedPages.length;
    const pageUrl = affectedPages[0];

    let severity = 'info';
    let confidence = 'low';
    let findingType = 'informational';
    let title = '';
    let description = '';
    let ruleId = '';
    let msg = '';
    let sourceUrl = '';

    if (item.type === 'console') {
      msg = item.log.text;
      sourceUrl = item.log.url || pageUrl;
      title = `Console ${item.log.type}: ${msg.substring(0, 60)}${msg.length > 60 ? '...' : ''}`;
      description = `Browser console message observed:\n${msg}`;
      ruleId = 'console-error';
    } else {
      msg = item.exc.errorText || item.exc.message || String(item.exc);
      sourceUrl = item.url || pageUrl;
      title = 'Uncaught JavaScript exception';
      description = `An uncaught exception occurred:\n${msg}`;
      ruleId = 'uncaught-exception';
    }

    const classification = classifyConsoleObservation({ type: item.type === 'exception' ? 'exception' : item.log.type, text: msg, sourceUrl }, siteOrigin);
    if (!classification.report) continue; // network check owns resource failures
    const originClass = classification.origin || null;
    const isNoise = noisePatterns.some(p => p.test(msg));

    if (isNoise) {
      severity = 'info';
      confidence = 'low';
      findingType = 'informational';
    } else {
      severity = classification.severity;
      confidence = classification.confidence;
      findingType = classification.findingType;
    }

    findings.push(createFinding({
      title,
      severity,
      confidence,
      category: 'console',
      findingType,
      origin: originClass,
      ruleId,
      pageUrl,
      description,
      evidence: [`Message: ${msg}`, sourceUrl ? `Source: ${sourceUrl}` : null, item.exc?.stack ? `Stack:\n${item.exc.stack}` : null].filter(Boolean).join('\n'),
      occurrences,
      affectedPages
    }));
  }

  onEvent?.('Console checks completed.');
  return findings;
}
