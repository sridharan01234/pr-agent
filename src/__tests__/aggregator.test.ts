import { aggregateReports } from '../agents/aggregator';
import type { FindingReport, PRContext } from '../agents/types';

const mockPRContext: PRContext = {
  pr: {
    number: 42,
    title: 'Add user authentication',
    description: 'Implements JWT auth',
    author: 'devuser',
    sourceBranch: 'feat/auth',
    targetBranch: 'main',
    url: 'https://github.com/org/repo/pull/42',
    owner: 'org',
    repository: 'repo',
    installationId: 999,
    headSha: 'abc123',
  },
  changedFiles: [],
  fullDiff: '',
  commits: [],
};

describe('aggregateReports', () => {
  it('returns empty review when no findings', () => {
    const reports: FindingReport[] = [
      { agentId: 'security', agentName: 'Security', findings: [], skipped: false },
      { agentId: 'type-safety', agentName: 'Type Safety', findings: [], skipped: false },
    ];

    const result = aggregateReports(reports, mockPRContext);

    expect(result.totalCount).toBe(0);
    expect(result.criticalCount).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain('APPROVED');
  });

  it('deduplicates findings with same file, line, and rule', () => {
    const reports: FindingReport[] = [
      {
        agentId: 'security',
        agentName: 'Security',
        skipped: false,
        findings: [
          {
            agentId: 'security',
            rule: 'SEC-1',
            severity: 'HIGH',
            filePath: 'src/auth.ts',
            line: 10,
            title: 'Hardcoded secret',
            body: 'Secret found',
          },
        ],
      },
      {
        agentId: 'constants',
        agentName: 'Constants',
        skipped: false,
        findings: [
          {
            agentId: 'constants',
            rule: 'SEC-1',
            severity: 'MEDIUM',
            filePath: 'src/auth.ts',
            line: 10,
            title: 'Hardcoded secret',
            body: 'Same issue, different agent',
          },
        ],
      },
    ];

    const result = aggregateReports(reports, mockPRContext);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('HIGH');
  });

  it('sorts findings CRITICAL > HIGH > MEDIUM > LOW', () => {
    const reports: FindingReport[] = [
      {
        agentId: 'combined',
        agentName: 'Combined',
        skipped: false,
        findings: [
          { agentId: 'x', rule: 'A', severity: 'LOW', filePath: 'a.ts', title: 'Low', body: '' },
          { agentId: 'x', rule: 'B', severity: 'CRITICAL', filePath: 'b.ts', title: 'Critical', body: '' },
          { agentId: 'x', rule: 'C', severity: 'MEDIUM', filePath: 'c.ts', title: 'Medium', body: '' },
          { agentId: 'x', rule: 'D', severity: 'HIGH', filePath: 'd.ts', title: 'High', body: '' },
        ],
      },
    ];

    const result = aggregateReports(reports, mockPRContext);

    expect(result.findings[0].severity).toBe('CRITICAL');
    expect(result.findings[1].severity).toBe('HIGH');
    expect(result.findings[2].severity).toBe('MEDIUM');
    expect(result.findings[3].severity).toBe('LOW');
  });

  it('counts skipped and error agents correctly', () => {
    const reports: FindingReport[] = [
      { agentId: 'a', agentName: 'Agent A', findings: [], skipped: true, skipReason: 'No TS files' },
      { agentId: 'b', agentName: 'Agent B', findings: [], skipped: false, error: 'OpenAI timeout' },
      { agentId: 'c', agentName: 'Agent C', findings: [], skipped: false },
    ];

    const result = aggregateReports(reports, mockPRContext);

    expect(result.agentsSkipped).toHaveLength(1);
    expect(result.agentErrors).toContain('Agent B');
    expect(result.agentsRun).toContain('Agent C');
  });

  it('requests changes when critical findings are present', () => {
    const reports: FindingReport[] = [
      {
        agentId: 'security',
        agentName: 'Security',
        skipped: false,
        findings: [
          {
            agentId: 'security',
            rule: 'SEC-2',
            severity: 'CRITICAL',
            filePath: 'src/eval.ts',
            title: 'No eval()',
            body: 'eval() usage found',
          },
        ],
      },
    ];

    const result = aggregateReports(reports, mockPRContext);

    expect(result.criticalCount).toBe(1);
    expect(result.summary).toContain('CHANGES REQUESTED');
  });
});
