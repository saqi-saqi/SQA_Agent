import { info, warn } from '../../utils/logger.js';

const SCREENSHOT_TIMEOUT_MS = 3000;
const MAX_SEO_SCREENSHOTS = 2;

/**
 * Run basic SEO and quality checks.
 * @param {Array} pages - PageResult objects with meta field
 * @param {Function} createFinding - Finding factory function
 * @param {Function} onEvent - Progress callback
 * @param {string} screenshotDir - Directory for screenshots
 * @param {string} runId - Current run ID
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<Array>} Array of findings
 */
export async function checkSeo(pages, createFinding, onEvent, screenshotDir, runId, signal) {
  onEvent('Running SEO checks');
  const findings = [];
  
  const issues = {
    'missing-title': { affectedPages: new Set() },
    'missing-meta-desc': { affectedPages: new Set() },
    'missing-h1': { affectedPages: new Set() },
    'missing-viewport': { affectedPages: new Set() },
    'missing-favicon': { affectedPages: new Set() }
  };
  
  const missingAltText = {
    affectedElements: 0,
    affectedPages: new Set(),
    samples: [],
    screenshots: []
  };

  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) {
      warn('SEO check aborted due to signal');
      break;
    }

    const page = pages[i];
    const meta = page.meta || {};
    
    // Check title
    if (!page.title || page.title.trim() === '') {
      issues['missing-title'].affectedPages.add(page.url);
    }
    
    // Check meta description
    if (!meta.metaDescription) {
      issues['missing-meta-desc'].affectedPages.add(page.url);
    }
    
    // Check h1
    if (!meta.h1 && !(meta.semanticH1 || []).length) {
      issues['missing-h1'].affectedPages.add(page.url);
    }
    
    // Check viewport
    if (!meta.viewport) {
      issues['missing-viewport'].affectedPages.add(page.url);
    }
    
    // Check favicon
    if (!meta.favicon) {
      issues['missing-favicon'].affectedPages.add(page.url);
    }
    
    // Only a loaded, visible non-decorative <img> without an alt attribute is
    // an actionable observation. alt="" is intentional decorative markup.
    for (const img of (page.imageDetails || [])) {
      const hasLoadedSource = Boolean(img.currentSrc || img.src) && img.naturalWidth > 0 && img.naturalHeight > 0;
      const decorative = img.hasAlt && img.alt === '' || img.ariaHidden === 'true' || img.role === 'presentation';
      if (!img.hasAlt && img.visible && hasLoadedSource && !decorative) {
        missingAltText.affectedElements++;
        missingAltText.affectedPages.add(page.url);
        if (missingAltText.samples.length < 5) missingAltText.samples.push(`${page.url}\nSelector: ${img.selector}\nImage source: ${img.currentSrc || img.src}`);
        
        if (page.page && !page.page.isClosed() && missingAltText.screenshots.length < MAX_SEO_SCREENSHOTS) {
          try {
            const name = `seo-${runId}-alt-${missingAltText.screenshots.length}.png`;
            await page.page.screenshot({ 
              path: `${screenshotDir}/${name}`, 
              fullPage: false,
              timeout: SCREENSHOT_TIMEOUT_MS 
            });
            missingAltText.screenshots.push(`/screenshots/${name}`);
          } catch {}
        }
      }
    }
  }

  const rules = [
    {
      id: 'missing-title',
      title: 'Missing page title',
      severity: 'medium',
      confidence: 'high',
      findingType: 'warning',
      description: 'Pages have no <title> tag or the title is empty. Page titles are important for SEO and user experience.',
      suggestedFix: 'Add a descriptive <title> tag to the <head> section. Titles should be unique, descriptive, and under 60 characters.'
    },
    {
      id: 'missing-meta-desc',
      title: 'Missing meta description',
      severity: 'low',
      confidence: 'high',
      findingType: 'recommendation',
      description: 'Pages have no meta description. Meta descriptions help search engines and social media display a summary.',
      suggestedFix: 'Add a <meta name="description" content="..."> tag to the <head> section. Keep it under 160 characters.'
    },
    {
      id: 'missing-h1',
      title: 'No semantic level-one heading detected',
      severity: 'low',
      confidence: 'medium',
      findingType: 'recommendation',
      description: 'No <h1> or [role="heading"][aria-level="1"] was detected in the rendered DOM. This is an SEO recommendation, not a confirmed functional defect.',
      suggestedFix: 'Consider providing a semantic level-one heading when it fits the page structure.'
    },
    {
      id: 'missing-viewport',
      title: 'Missing viewport meta tag',
      severity: 'low',
      confidence: 'medium',
      findingType: 'recommendation',
      description: 'No viewport meta tag was detected in the rendered document. Mobile behavior was not independently tested.',
      suggestedFix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the <head> section.'
    },
    {
      id: 'missing-favicon',
      title: 'Missing favicon',
      severity: 'info',
      confidence: 'high',
      findingType: 'recommendation',
      description: 'No favicon link was found. Favicons improve brand recognition and user experience.',
      suggestedFix: 'Add a favicon: <link rel="icon" href="/favicon.ico"> in the <head> section.'
    }
  ];

  for (const rule of rules) {
    const issue = issues[rule.id];
    if (issue.affectedPages.size > 0) {
      const affectedPagesArray = Array.from(issue.affectedPages);
      findings.push(createFinding({
        title: rule.title,
        severity: rule.severity,
        confidence: rule.confidence,
        findingType: rule.findingType,
        ruleId: rule.id,
        category: 'seo',
        origin: null,
        pageUrl: affectedPagesArray[0],
        description: rule.description,
        evidence: `Found on ${affectedPagesArray.length} page(s).`,
        occurrences: affectedPagesArray.length,
        affectedPages: affectedPagesArray,
        reproSteps: [
          'Open affected page(s)',
          'View page source',
          'Check for the respective tag in the <head> section (or body for h1)'
        ],
        suggestedFix: rule.suggestedFix
      }));
    }
  }

  if (missingAltText.affectedElements > 0) {
    const affectedPagesArray = Array.from(missingAltText.affectedPages);
    const screenshot = missingAltText.screenshots.length > 0 ? missingAltText.screenshots[0] : null;
    
    findings.push(createFinding({
      title: 'Missing image alt text',
      severity: 'low',
      confidence: 'high',
      findingType: 'warning',
      ruleId: 'missing-alt-text',
      category: 'accessibility',
      origin: null,
      description: 'Images are missing alternative text. Alt text is essential for screen readers and accessibility.',
      evidence: [`Found ${missingAltText.affectedElements} loaded, visible <img> element(s) without an alt attribute across ${affectedPagesArray.length} page(s).`, ...missingAltText.samples].join('\n\n'),
      occurrences: affectedPagesArray.length,
      affectedElements: missingAltText.affectedElements,
      affectedPages: affectedPagesArray,
      screenshot,
      reproSteps: [
        'Open affected page(s)',
        'Inspect image elements',
        'Observe that the image has no alt attribute (not alt="")'
      ],
      suggestedFix: 'Add a descriptive alt attribute to the <img> tag. Use alt="" for decorative images.'
    }));
  }

  info(`SEO check complete: ${findings.length} rule violation(s) found`);
  return findings;
}

function truncateUrl(url) {
  if (!url) return '';
  return url.length > 80 ? url.slice(0, 77) + '...' : url;
}
