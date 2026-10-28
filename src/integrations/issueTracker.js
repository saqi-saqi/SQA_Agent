/**
 * integrations/issueTracker.js — abstract interface for pushing findings
 * to issue trackers (GitHub Issues, Jira, etc.).
 *
 * Interface (IssueTrackerAdapter):
 *   {
 *     name:    string,
 *     search:  async ({ ruleId, signature }) => Issue | null,
 *                  Find an existing open issue matching the signature
 *     create:  async ({ title, body, labels, severity }) => Issue,
 *                  Create a new issue
 *     update:  async (issue, { body, labels, comment? }) => Issue,
 *                  Update an existing issue (e.g. add a comment for re-occurrence)
 *     close:   async (issue, { reason }) => Issue,
 *                  Close an issue (e.g. when the finding no longer appears)
 *   }
 *
 * Issue shape:
 *   { id, url, state, title, labels: string[] }
 *
 * Lifecycle (managed by IssueTrackerPublisher):
 *   1. Take findings from a completed run
 *   2. Group by signature (ruleId + pageUrl hash)
 *   3. For each group:
 *      • search() → existing open issue?
 *        YES → update() with new occurrence info
 *        NO  → create() with the finding details
 *   4. Optionally: close issues whose findings no longer appear
 */

const SEVERITY_LABELS = {
  critical: 'P0-critical',
  high:     'P1-high',
  medium:   'P2-medium',
  low:      'P3-low',
  info:     'P4-info',
};

/**
 * Compute a stable signature for a finding.
 * Two findings with the same signature are the same bug — different runs
 * shouldn't create duplicate issues.
 */
export function findingSignature(finding) {
  const ruleId = finding.ruleId || finding.id || 'unknown';
  const pageUrl = finding.pageUrl || '';
  // Strip query strings from page URLs so ?foo=bar doesn't fragment signatures
  const cleanUrl = (() => {
    try {
      const u = new URL(pageUrl);
      return u.origin + u.pathname;
    } catch {
      return pageUrl;
    }
  })();
  return `${ruleId}::${cleanUrl}`;
}

/**
 * Build a Markdown body for an issue from a finding.
 */
export function buildIssueBody(finding, runContext = {}) {
  const lines = [];

  lines.push(`### ${finding.title || 'Untitled finding'}`);
  lines.push('');

  if (finding.description) {
    lines.push(finding.description);
    lines.push('');
  }

  lines.push('#### Details');
  lines.push('');
  lines.push(`- **Severity:** ${finding.severity || 'info'}`);
  lines.push(`- **Confidence:** ${finding.confidence || 'unknown'}`);
  lines.push(`- **Category:** ${finding.category || 'general'}`);
  lines.push(`- **Rule ID:** \`${finding.ruleId || 'n/a'}\``);

  if (finding.origin) {
    lines.push(`- **Origin:** ${finding.origin}`);
  }

  if (finding.pageUrl) {
    lines.push(`- **Page:** [${finding.pageUrl}](${finding.pageUrl})`);
  }

  if (finding.occurrences > 1) {
    lines.push(`- **Occurrences:** ${finding.occurrences}`);
    if (finding.affectedPages?.length) {
      lines.push('- **Affected pages:**');
      for (const p of finding.affectedPages.slice(0, 10)) {
        lines.push(`  - ${p}`);
      }
      if (finding.affectedPages.length > 10) {
        lines.push(`  - _...and ${finding.affectedPages.length - 10} more_`);
      }
    }
  }

  if (runContext.runId) {
    lines.push(`- **Run ID:** \`${runContext.runId}\``);
  }
  if (runContext.url) {
    lines.push(`- **Target:** ${runContext.url}`);
  }
  if (runContext.matrixCells?.length) {
    lines.push(`- **Observed in matrix cells:** ${runContext.matrixCells.join(', ')}`);
  }

  lines.push('');

  if (finding.evidence) {
    lines.push('#### Evidence');
    lines.push('');
    lines.push('```');
    lines.push(finding.evidence);
    lines.push('```');
    lines.push('');
  }

  if (finding.reproSteps?.length) {
    lines.push('#### Repro Steps');
    lines.push('');
    finding.reproSteps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`);
    });
    lines.push('');
  }

  if (finding.suggestedFix) {
    lines.push('#### Suggested Fix');
    lines.push('');
    lines.push(finding.suggestedFix);
    lines.push('');
  }

  lines.push('---');
  lines.push('_This issue was auto-filed by SQA Agent. Do not edit the title or signature._');

  return lines.join('\n');
}

/**
 * Group findings by signature, picking the most severe as the representative.
 * Returns a Map: signature → { finding, allOccurrences }
 */
export function groupFindingsBySignature(findings) {
  const groups = new Map();

  for (const finding of findings) {
    const sig = findingSignature(finding);
    if (!groups.has(sig)) {
      groups.set(sig, {
        signature: sig,
        finding,
        allOccurrences: finding.occurrences || 1,
      });
    } else {
      const existing = groups.get(sig);
      existing.allOccurrences += finding.occurrences || 1;

      // Keep the most severe as representative
      const sevRank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
      if ((sevRank[finding.severity] || 0) > (sevRank[existing.finding.severity] || 0)) {
        existing.finding = finding;
      }
    }
  }

  return groups;
}

/**
 * Build the label set for a finding issue.
 */
export function labelsForFinding(finding, options = {}) {
  const labels = [];

  // Severity label
  if (finding.severity && SEVERITY_LABELS[finding.severity]) {
    labels.push(SEVERITY_LABELS[finding.severity]);
  }

  // Category label
  if (finding.category) {
    labels.push(`category:${finding.category}`);
  }

  // Origin label
  if (finding.origin) {
    labels.push(`origin:${finding.origin}`);
  }

  // Custom labels from options
  if (options.extraLabels?.length) {
    labels.push(...options.extraLabels);
  }

  // Always include "sqa-agent" so users can filter
  labels.push('sqa-agent');

  // Dedup
  return Array.from(new Set(labels));
}

/**
 * IssueTrackerPublisher — orchestrates search/create/update per finding.
 */
export class IssueTrackerPublisher {
  constructor({ adapter, options = {} } = {}) {
    if (!adapter) throw new Error('IssueTrackerPublisher requires an adapter');
    if (typeof adapter.search !== 'function' ||
        typeof adapter.create !== 'function' ||
        typeof adapter.update !== 'function') {
      throw new Error('Adapter must implement search, create, update');
    }
    this.adapter = adapter;
    this.options = {
      minSeverity: 'medium',  // don't auto-file low/info findings
      dryRun: false,
      closeResolved: false,
      ...options,
    };
  }

  /**
   * Publish findings to the issue tracker.
   * Returns { filed, updated, skipped, closed, errors }
   */
  async publish(findings, runContext = {}) {
    const stats = { filed: 0, updated: 0, skipped: 0, closed: 0, errors: [] };

    // Filter by minSeverity
    const sevRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
    const minRank = sevRank[this.options.minSeverity] ?? 2;

    const eligible = findings.filter(f =>
      (sevRank[f.severity] || 0) >= minRank
    );

    if (eligible.length === 0) {
      // Even with no findings, we may want to close resolved issues
      if (this.options.closeResolved && typeof this.adapter.listOpen === 'function') {
        await this._closeResolved(new Set(), runContext, stats);
      }
      return stats;
    }

    // Group by signature
    const groups = groupFindingsBySignature(eligible);

    // Track which signatures are present in this run (for auto-close)
    const presentSignatures = new Set();
    for (const [, group] of groups) {
      presentSignatures.add(group.signature);
    }

    for (const [, group] of groups) {
      const { signature, finding, allOccurrences } = group;

      try {
        if (this.options.dryRun) {
          // Dry-run: log what we would do, don't make API calls
          stats.filed++;
          continue;
        }

        // Search for existing issue
        const existing = await this.adapter.search({ ruleId: finding.ruleId, signature });

        if (existing) {
          // Update with new occurrence info
          const comment = `**Re-occurred** in run \`${runContext.runId || 'unknown'}\` (${new Date().toISOString()})\n` +
                          `Occurrences: ${allOccurrences}`;
          await this.adapter.update(existing, {
            labels: labelsForFinding(finding, this.options),
            comment,
          });
          stats.updated++;
        } else {
          // Create new issue
          await this.adapter.create({
            title: `[SQA] ${finding.title}`,
            body: buildIssueBody(finding, runContext),
            labels: labelsForFinding(finding, this.options),
            severity: finding.severity,
            signature,
          });
          stats.filed++;
        }
      } catch (err) {
        stats.errors.push({
          signature,
          finding: finding.title,
          error: err.message,
        });
      }
    }

    // Auto-close: list open issues with the sqa-agent label and close any
    // whose signature is no longer present in this run.
    if (this.options.closeResolved && typeof this.adapter.listOpen === 'function') {
      await this._closeResolved(presentSignatures, runContext, stats);
    }

    return stats;
  }

  /**
   * Close issues that no longer appear in the current run.
   * Lists all open sqa-agent issues, compares signatures, closes mismatches.
   */
  async _closeResolved(presentSignatures, runContext, stats) {
    try {
      const openIssues = await this.adapter.listOpen();
      for (const issue of openIssues) {
        const sig = issue._signature;
        if (!sig) continue;  // Can't match without a signature
        if (presentSignatures.has(sig)) continue;  // Still present — leave open

        try {
          await this.adapter.close(issue, {
            reason: 'completed',
          });
          stats.closed++;
          stats.errors = stats.errors || [];
          // Log as informational — not an error, just a state change
        } catch (err) {
          stats.errors.push({
            signature: sig,
            finding: issue.title,
            error: `close failed: ${err.message}`,
          });
        }
      }
    } catch (err) {
      stats.errors.push({
        signature: '__close_resolved__',
        finding: 'auto-close sweep',
        error: err.message,
      });
    }
  }
}
