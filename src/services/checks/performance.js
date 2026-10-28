import { info, warn } from '../../utils/logger.js';

const SCREENSHOT_TIMEOUT_MS = 3000;
const MAX_PERF_SCREENSHOTS = 2;

/**
 * Run performance checks.
 * @param {Array} pages - PageResult objects
 * @param {Function} createFinding - Finding factory function
 * @param {Function} onEvent - Progress callback
 * @param {string} screenshotDir - Directory for screenshots  
 * @param {string} runId - Current run ID
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<Array>} Array of findings
 */
export async function checkPerformance(pages, createFinding, onEvent, screenshotDir, runId, signal) {
  onEvent('Running performance checks');
  const findings = [];
  let screenshotCount = 0;
  
  const slowPages = [];
  const largeImages = [];
  
  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) {
      warn('Performance check aborted due to signal');
      break;
    }

    const page = pages[i];
    
    // Check load time (threshold: 3 seconds)
    if (page.loadTime > 3000) {
      slowPages.push({ url: page.url, loadTime: page.loadTime, pageObj: page });
    }
    
    // Check for large images (threshold: 1 MB) and Web Vitals
    let webVitals = {};
    if (page.page && !page.page.isClosed()) {
      try {
        const perfData = await page.page.evaluate(() => {
          const resources = performance.getEntriesByType('resource')
            .filter(r => r.initiatorType === 'img' || r.name.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)/i))
            .map(r => ({
              url: r.name,
              size: r.transferSize || r.encodedBodySize || 0,
              duration: r.duration
            }))
            .filter(r => r.size > 0);
            
          let lcp = null;
          const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
          if (lcpEntries.length > 0) {
            lcp = lcpEntries[lcpEntries.length - 1].startTime;
          }
          
          let cls = 0;
          const clsEntries = performance.getEntriesByType('layout-shift');
          for (const entry of clsEntries) {
            if (!entry.hadRecentInput) {
              cls += entry.value;
            }
          }
            
          const docSize = (() => {
            const navEntries = performance.getEntriesByType('navigation');
            if (navEntries.length > 0) {
              return navEntries[0].transferSize || navEntries[0].encodedBodySize || 0;
            }
            return 0;
          })();
            
          const navigation = performance.getEntriesByType('navigation')[0];
          return { resources, docSize, lcp, cls, navigation: navigation ? {
            dns: navigation.domainLookupEnd - navigation.domainLookupStart,
            tcp: navigation.connectEnd - navigation.connectStart,
            tls: navigation.secureConnectionStart > 0 ? navigation.connectEnd - navigation.secureConnectionStart : 0,
            ttfb: navigation.responseStart - navigation.requestStart,
            domContentLoaded: navigation.domContentLoadedEventEnd - navigation.startTime,
            loadEvent: navigation.loadEventEnd - navigation.startTime
          } : null };
        }).catch(() => null);
        
        if (perfData) {
          webVitals = { lcp: perfData.lcp, cls: perfData.cls, navigation: perfData.navigation };
          
          for (const resource of perfData.resources || []) {
            if (resource.size > 1048576) { // 1 MB
              largeImages.push({ url: resource.url, size: resource.size, pageUrl: page.url });
            }
          }
          
          if (perfData.docSize > 5242880) { // 5 MB document
            findings.push(createFinding({
              title: 'Large document size',
              severity: 'medium',
              confidence: 'high',
              category: 'performance',
              ruleId: 'large-document',
              findingType: 'warning',
              origin: null,
              pageUrl: page.url,
              description: `The HTML document is ${formatBytes(perfData.docSize)}. Large documents take longer to download and parse.`,
              evidence: `Page: ${page.url}\nDocument size: ${formatBytes(perfData.docSize)}\nThreshold: 5 MB`,
              reproSteps: [
                `Open ${page.url}`,
                'Open DevTools > Network tab',
                'Check the size of the document request'
              ],
              suggestedFix: 'Reduce document size by removing unnecessary content, minifying HTML, implementing pagination, or loading content dynamically.'
            }));
          }
        }
      } catch (err) {
        // Performance API may not be available or page navigated
      }
    }
    
    // Store webVitals to page object for later use in slow pages deduplication
    page.webVitals = webVitals;
  }
  
  // Consolidate slow pages
  if (slowPages.length > 0) {
    let maxLoadTime = 0;
    const affectedPages = [];
    let evidenceText = 'Page URLs and Load Times:\n';
    
    let screenshot = null;
    
    for (const sp of slowPages) {
      if (sp.loadTime > maxLoadTime) maxLoadTime = sp.loadTime;
      affectedPages.push(sp.url);
      evidenceText += `- ${sp.url}: ${sp.loadTime}ms`;
      
      const vitals = sp.pageObj.webVitals;
      if (vitals && (vitals.lcp !== null || vitals.cls > 0)) {
        evidenceText += ` (LCP: ${vitals.lcp ? vitals.lcp.toFixed(2) + 'ms' : 'N/A'}, CLS: ${vitals.cls ? vitals.cls.toFixed(4) : '0'})`;
      }
      if (vitals?.navigation) evidenceText += ` [TTFB: ${vitals.navigation.ttfb.toFixed(0)}ms, DCL: ${vitals.navigation.domContentLoaded.toFixed(0)}ms, load: ${vitals.navigation.loadEvent.toFixed(0)}ms]`;
      evidenceText += '\n';
      
      if (!screenshot && sp.pageObj.page && !sp.pageObj.page.isClosed() && screenshotCount < MAX_PERF_SCREENSHOTS) {
        try {
          const name = `perf-${runId}-load-0.png`;
          await sp.pageObj.page.screenshot({ 
            path: `${screenshotDir}/${name}`, 
            fullPage: false,
            timeout: SCREENSHOT_TIMEOUT_MS 
          });
          screenshot = `/screenshots/${name}`;
          screenshotCount++;
        } catch {}
      }
    }
    
    let severity = 'low';
    let confidence = 'low';
    if (maxLoadTime > 15000) {
      severity = 'high';
      confidence = 'medium';
    } else if (maxLoadTime > 5000) {
      severity = 'medium';
      confidence = 'low';
    } else if (maxLoadTime > 3000) {
      severity = 'low';
      confidence = 'low';
    }
    
    findings.push(createFinding({
      title: 'Slow page load times detected',
      severity,
      confidence,
      findingType: 'warning',
      ruleId: 'slow-page-load',
      category: 'performance',
      origin: null,
      description: 'One or more navigations exceeded 3 seconds in this test environment. This is navigation completion timing, not a claim about user-perceived load or total background network activity.',
      evidence: evidenceText.trim(),
      occurrences: slowPages.length,
      affectedPages,
      screenshot,
      reproSteps: [
        'Open the affected URLs in a browser',
        'Open DevTools > Network tab',
        'Refresh the page and observe load times'
      ],
      suggestedFix: 'Optimize page load performance. Consider: reducing server response time, minimizing render-blocking resources, optimizing images, implementing lazy loading, and using a CDN.'
    }));
  }
  
  // Consolidate large images
  if (largeImages.length > 0) {
    largeImages.sort((a, b) => b.size - a.size);
    const topImages = largeImages.slice(0, 10);
    
    const affectedPagesSet = new Set(largeImages.map(img => img.pageUrl));
    let evidenceText = 'Top oversized images:\n';
    for (const img of topImages) {
      evidenceText += `- ${img.url} (${formatBytes(img.size)}) on ${img.pageUrl}\n`;
    }
    
    findings.push(createFinding({
      title: 'Large image resources detected',
      severity: topImages[0].size > 5242880 ? 'medium' : 'low',
      confidence: 'high',
      findingType: 'recommendation',
      ruleId: 'large-images',
      category: 'performance',
      origin: null,
      description: 'Images exceeding 1 MB were found. Large images slow page loading, especially on mobile. Note: measured in test conditions.',
      evidence: evidenceText.trim(),
      occurrences: largeImages.length,
      affectedPages: Array.from(affectedPagesSet),
      reproSteps: [
        'Open affected pages',
        'Open DevTools > Network tab (Filter by Img)',
        'Observe image sizes'
      ],
      suggestedFix: 'Optimize the images: compress them, use modern formats (WebP/AVIF), resize to actual display dimensions, or implement lazy loading.'
    }));
  }
  
  info(`Performance check complete: ${findings.length} consolidated issue(s) found`);
  return findings;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function truncateUrl(url) {
  if (!url) return '';
  return url.length > 80 ? url.slice(0, 77) + '...' : url;
}
