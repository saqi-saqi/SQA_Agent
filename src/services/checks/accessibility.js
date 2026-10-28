import { AxeBuilder } from '@axe-core/playwright';
import { info, warn } from '../../utils/logger.js';

const AXE_TIMEOUT_MS = 12000;
const SCREENSHOT_TIMEOUT_MS = 3000;
const MAX_A11Y_SCREENSHOTS = 3;

/**
 * Run axe-core accessibility checks on crawled pages.
 * @param {Array} pages - PageResult objects with .page (Playwright Page) still open
 * @param {Function} createFinding - Finding factory function
 * @param {Function} onEvent - Progress callback
 * @param {string} screenshotDir - Directory to save screenshots
 * @param {string} runId - Current run ID for screenshot naming
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<Array>} Array of findings
 */
export async function checkAccessibility(pages, createFinding, onEvent, screenshotDir, runId, signal) {
  onEvent('Running accessibility checks');
  const findings = [];
  const violationGroups = new Map(); // Group by rule ID
  let screenshotCount = 0;
  
  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) {
      warn('Accessibility check aborted due to signal');
      break;
    }

    const pageResult = pages[i];
    if (!pageResult.page || pageResult.page.isClosed()) {
      warn(`No open page instance for ${pageResult.url}, skipping accessibility check`);
      continue;
    }

    onEvent(`Running accessibility check on page ${i + 1}/${pages.length}`);
    
    try {
      // Analyze with timeout to prevent hanging on massive DOMs
      const axePromise = new AxeBuilder({ page: pageResult.page }).analyze();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('axe-core analysis timed out after 12s')), AXE_TIMEOUT_MS)
      );

      const results = await Promise.race([axePromise, timeoutPromise]);
      
      for (const violation of results.violations || []) {
        const impact = mapImpact(violation.impact);
        const ruleId = violation.id;

        if (!violationGroups.has(ruleId)) {
          violationGroups.set(ruleId, {
            violation,
            impact,
            ruleId,
            occurrences: 0,
            affectedPages: new Set(),
            affectedElements: 0,
            firstPageUrl: pageResult.url,
            sampleSelectors: [],
            screenshot: null,
            firstNodeFailureSummary: null
          });
        }

        const group = violationGroups.get(ruleId);
        group.affectedPages.add(pageResult.url);
        
        for (const node of violation.nodes || []) {
          group.occurrences++;
          group.affectedElements++;
          
          if (!group.firstNodeFailureSummary && node.failureSummary) {
            group.firstNodeFailureSummary = node.failureSummary;
          }

          const target = node.target?.join(', ') || 'unknown element';
          if (group.sampleSelectors.length < 5 && !group.sampleSelectors.includes(target)) {
            group.sampleSelectors.push(target);
          }

          // Take screenshot for visual accessibility issues (capped to avoid slowdowns)
          // Only for high-severity rules, max 1 per rule
          if (impact === 'high' && !group.screenshot && screenshotCount < MAX_A11Y_SCREENSHOTS && !pageResult.page.isClosed()) {
            try {
              const screenshotName = `a11y-${runId}-${screenshotCount}.png`;
              const screenshotPath = `${screenshotDir}/${screenshotName}`;
              
              const element = await pageResult.page.$(node.target?.[0] || 'body').catch(() => null);
              if (element) {
                await element.screenshot({ path: screenshotPath, timeout: SCREENSHOT_TIMEOUT_MS }).catch(async () => {
                  if (!pageResult.page.isClosed()) {
                    await pageResult.page.screenshot({ path: screenshotPath, fullPage: false, timeout: SCREENSHOT_TIMEOUT_MS });
                  }
                });
              } else if (!pageResult.page.isClosed()) {
                await pageResult.page.screenshot({ path: screenshotPath, fullPage: false, timeout: SCREENSHOT_TIMEOUT_MS });
              }
              group.screenshot = `/screenshots/${screenshotName}`;
              screenshotCount++;
            } catch {
              // Screenshot failed, proceed without it
            }
          }
        }
      }
    } catch (err) {
      warn(`Accessibility check failed for ${pageResult.url}: ${err.message}`);
    }
  }
  
  // Convert grouped violations to findings
  for (const [, group] of violationGroups) {
    const { 
      violation, impact, ruleId, occurrences, affectedPages, 
      affectedElements, firstPageUrl, sampleSelectors, screenshot, 
      firstNodeFailureSummary 
    } = group;
    
    const affectedPagesArray = Array.from(affectedPages);
    const description = `${violation.help} — Found ${occurrences} occurrences across ${affectedPagesArray.length} pages.`;
    
    const evidenceLines = [
      `Rule: ${violation.id}`,
      `Description: ${violation.description}`,
      `Total occurrences: ${occurrences}`,
      `Affected pages:\n- ${affectedPagesArray.slice(0, 5).join('\n- ')}${affectedPagesArray.length > 5 ? `\n...and ${affectedPagesArray.length - 5} more` : ''}`,
      `Sample elements:\n- ${sampleSelectors.join('\n- ')}`
    ];

    findings.push(createFinding({
      title: violation.description || violation.id,
      severity: impact,
      confidence: 'confirmed',
      category: 'accessibility',
      findingType: 'warning',
      origin: 'axe-core',
      ruleId,
      pageUrl: firstPageUrl,
      description,
      evidence: evidenceLines.join('\n'),
      screenshot,
      reproSteps: [
        `Run axe-core on affected pages (e.g. ${firstPageUrl})`,
        `Inspect elements violating rule "${violation.id}"`
      ],
      suggestedFix: violation.helpUrl || firstNodeFailureSummary || `Fix the accessibility violation: ${violation.help}`,
      occurrences,
      affectedPages: affectedPagesArray,
      affectedElements
    }));
  }
  
  info(`Accessibility check complete: ${findings.length} issues found`);
  return findings;
}

function mapImpact(axeImpact) {
  switch (axeImpact) {
    case 'critical': return 'high';
    case 'serious': return 'medium';
    case 'moderate': return 'low';
    case 'minor': return 'info';
    default: return 'low';
  }
}
