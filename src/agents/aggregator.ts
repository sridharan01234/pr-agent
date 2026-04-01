import type { AggregatedReview, FindingReport, PRContext, ReviewFinding, Severity } from './types.js';

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Map<string, ReviewFinding>();

  for (const finding of findings) {
    const key = `${finding.filePath}:${finding.line ?? 'none'}:${finding.rule}`;
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, finding);
      continue;
    }

    if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[existing.severity]) {
      seen.set(key, finding);
    }
  }

  return Array.from(seen.values());
}

function sortBySeverity(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

function buildSummary(
  prContext: PRContext,
  findings: ReviewFinding[],
  agentsRun: string[],
  agentErrors: string[],
): string {
  const critical = findings.filter((f) => f.severity === 'CRITICAL').length;
  const high = findings.filter((f) => f.severity === 'HIGH').length;
  const medium = findings.filter((f) => f.severity === 'MEDIUM').length;
  const low = findings.filter((f) => f.severity === 'LOW').length;
  const total = findings.length;

  const overallStatus = critical > 0
    ? '🔴 **CHANGES REQUESTED** — Critical issues found'
    : high > 0
    ? '🟠 **CHANGES REQUESTED** — High-severity issues found'
    : medium > 0
    ? '🟡 **REVIEW NEEDED** — Medium-severity issues found'
    : total > 0
    ? '🟢 **APPROVED WITH SUGGESTIONS** — Minor issues only'
    : '✅ **APPROVED** — No issues found';

  const errorNote = agentErrors.length > 0
    ? `\n\n> ⚠️ ${agentErrors.length} review agent(s) encountered errors: ${agentErrors.join(', ')}`
    : '';

  return `## 🤖 Automated PR Review

${overallStatus}

**PR:** [${prContext.pr.title}](${prContext.pr.url})
**Branch:** \`${prContext.pr.sourceBranch}\` → \`${prContext.pr.targetBranch}\`
**Files changed:** ${prContext.changedFiles.length}

### Summary
| Severity | Count |
|----------|-------|
| 🔴 Critical | ${critical} |
| 🟠 High | ${high} |
| 🟡 Medium | ${medium} |
| 🟢 Low | ${low} |
| **Total** | **${total}** |

**Agents run:** ${agentsRun.join(', ')}${errorNote}

---

*This review was generated automatically by the [PR Review Agent](https://github.com/codespell-ai/pr-review-agent). Each finding was independently identified by a specialized AI sub-agent.*`;
}

export function aggregateReports(
  reports: FindingReport[],
  prContext: PRContext,
): AggregatedReview {
  const allFindings = reports.flatMap((r) => r.findings);
  const deduplicated = deduplicateFindings(allFindings);
  const sorted = sortBySeverity(deduplicated);

  const agentsRun = reports
    .filter((r) => !r.skipped && !r.error)
    .map((r) => r.agentName);

  const agentsSkipped = reports
    .filter((r) => r.skipped)
    .map((r) => `${r.agentName} (${r.skipReason ?? 'skipped'})`);

  const agentErrors = reports
    .filter((r) => r.error)
    .map((r) => r.agentName);

  return {
    prContext,
    findings: sorted,
    summary: buildSummary(prContext, sorted, agentsRun, agentErrors),
    criticalCount: sorted.filter((f) => f.severity === 'CRITICAL').length,
    highCount: sorted.filter((f) => f.severity === 'HIGH').length,
    mediumCount: sorted.filter((f) => f.severity === 'MEDIUM').length,
    lowCount: sorted.filter((f) => f.severity === 'LOW').length,
    totalCount: sorted.length,
    agentsRun,
    agentsSkipped,
    agentErrors,
  };
}
