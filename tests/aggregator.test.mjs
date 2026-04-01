import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReports } from '../dist/agents/aggregator.js';

const mockPRContext = {
  pr: {
    number: 42,
    title: 'Add user auth',
    description: 'JWT auth',
    author: 'dev',
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
  test('returns empty review when no findings', () => {
    const result = aggregateReports(
      [{ agentId: 'security', agentName: 'Security', findings: [], skipped: false }],
      mockPRContext,
    );
    assert.equal(result.totalCount, 0);
    assert.ok(result.summary.includes('APPROVED'));
  });

  test('deduplicates findings with same file+line+rule (keeps higher severity)', () => {
    const reports = [
      {
        agentId: 'security', agentName: 'Security', skipped: false,
        findings: [{ agentId: 'security', rule: 'SEC-1', severity: 'HIGH', filePath: 'a.ts', line: 10, title: 'Issue', body: 'body' }],
      },
      {
        agentId: 'constants', agentName: 'Constants', skipped: false,
        findings: [{ agentId: 'constants', rule: 'SEC-1', severity: 'MEDIUM', filePath: 'a.ts', line: 10, title: 'Issue', body: 'body2' }],
      },
    ];
    const result = aggregateReports(reports, mockPRContext);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'HIGH');
  });

  test('sorts CRITICAL > HIGH > MEDIUM > LOW', () => {
    const reports = [{
      agentId: 'x', agentName: 'X', skipped: false,
      findings: [
        { agentId: 'x', rule: 'A', severity: 'LOW', filePath: 'a.ts', title: 'Low', body: '' },
        { agentId: 'x', rule: 'B', severity: 'CRITICAL', filePath: 'b.ts', title: 'Crit', body: '' },
        { agentId: 'x', rule: 'C', severity: 'MEDIUM', filePath: 'c.ts', title: 'Med', body: '' },
        { agentId: 'x', rule: 'D', severity: 'HIGH', filePath: 'd.ts', title: 'High', body: '' },
      ],
    }];
    const result = aggregateReports(reports, mockPRContext);
    assert.equal(result.findings[0].severity, 'CRITICAL');
    assert.equal(result.findings[1].severity, 'HIGH');
    assert.equal(result.findings[2].severity, 'MEDIUM');
    assert.equal(result.findings[3].severity, 'LOW');
  });

  test('marks skipped agents correctly', () => {
    const reports = [
      { agentId: 'a', agentName: 'Agent A', findings: [], skipped: true, skipReason: 'No TS' },
      { agentId: 'b', agentName: 'Agent B', findings: [], skipped: false, error: 'Timeout' },
      { agentId: 'c', agentName: 'Agent C', findings: [], skipped: false },
    ];
    const result = aggregateReports(reports, mockPRContext);
    assert.equal(result.agentsSkipped.length, 1);
    assert.ok(result.agentErrors.includes('Agent B'));
    assert.ok(result.agentsRun.includes('Agent C'));
  });

  test('summary shows CHANGES REQUESTED for critical findings', () => {
    const reports = [{
      agentId: 'sec', agentName: 'Security', skipped: false,
      findings: [{ agentId: 'sec', rule: 'SEC-2', severity: 'CRITICAL', filePath: 'eval.ts', title: 'eval()', body: 'desc' }],
    }];
    const result = aggregateReports(reports, mockPRContext);
    assert.equal(result.criticalCount, 1);
    assert.ok(result.summary.includes('CHANGES REQUESTED'));
  });
});

console.log('✅ aggregator tests passed');
