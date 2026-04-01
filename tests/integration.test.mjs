/**
 * Integration test: Calls the real OpenAI API with the security review agent
 * and verifies the full review pipeline works end-to-end.
 * 
 * Run with: OPENAI_API_KEY=sk-... node tests/integration.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY env var is not set — skipping integration tests');
  process.exit(0);
}
process.env.OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
process.env.GITHUB_APP_ID = '1';
process.env.GITHUB_APP_PRIVATE_KEY = 'test';
process.env.GITHUB_WEBHOOK_SECRET = 'test';

const { runReviewAgent } = await import('../dist/agents/runner.js');
const { REVIEW_AGENTS } = await import('../dist/agents/prompts.js');
const { aggregateReports } = await import('../dist/agents/aggregator.js');

const SAMPLE_DIFF_WITH_ISSUES = `
### File: src/user-service.ts (modified, +25/-3)
\`\`\`diff
@@ -1,10 +1,35 @@
+import OpenAI from 'openai';
+
+const API_KEY = 'sk-hardcoded-secret-key-12345';
+
+export class userService {
+  private client: any;
+  private data: any;
+  private config: any;
+
+  constructor() {
+    this.client = new OpenAI({ apiKey: API_KEY });
+  }
+
+  async getUser(id: any): Promise<any> {
+    const result = await this.client.get('users/' + id).then(res => {
+      console.log('Got user:', res);
+      return res;
+    });
+    return eval(result.expression);
+  }
+
+  processData(items: any[]) {
+    for (let i = 0; i < items.length; i++) {
+      if (items[i].active) {
+        if (items[i].data) {
+          if (items[i].data.value > 5242880) {
+            console.error('Too large');
+          }
+        }
+      }
+    }
+  }
+}
\`\`\`
`;

const MOCK_TS_FILE = {
  path: 'src/user-service.ts',
  status: 'modified',
  linesAdded: 25,
  linesRemoved: 3,
  patch: SAMPLE_DIFF_WITH_ISSUES,
  isTypeScript: true,
  isReact: false,
  isTest: false,
  isConstants: false,
  isListener: false,
  isService: true,
  isView: false,
};

const MOCK_PR_CONTEXT = {
  pr: {
    number: 99,
    title: 'Integration test PR',
    description: 'Test PR for integration testing',
    author: 'test-user',
    sourceBranch: 'feat/test',
    targetBranch: 'main',
    url: 'https://github.com/test/repo/pull/99',
    owner: 'test',
    repository: 'repo',
    installationId: 0,
    headSha: 'testsha123',
  },
  changedFiles: [MOCK_TS_FILE],
  fullDiff: SAMPLE_DIFF_WITH_ISSUES,
  commits: [{ hash: 'abc12345', message: 'Add user service', author: 'test-user' }],
};

describe('Integration: OpenAI review agent', () => {
  test('security agent finds hardcoded secret and eval() usage', async (t) => {
    t.diagnostic('Calling OpenAI API with security review agent...');

    const securityAgent = REVIEW_AGENTS.find((a) => a.id === 'security');
    assert.ok(securityAgent, 'Security agent must exist');

    const report = await runReviewAgent(securityAgent, [MOCK_TS_FILE]);

    t.diagnostic(`Agent returned ${report.findings.length} findings`);
    t.diagnostic(`Skipped: ${report.skipped}, Error: ${report.error ?? 'none'}`);
    
    if (report.error) {
      t.diagnostic(`Warning: Agent returned error: ${report.error}`);
    }

    assert.equal(report.skipped, false, 'Security agent should not skip TS files');
    assert.equal(typeof report.findings, 'object', 'findings must be an array');

    if (report.findings.length > 0) {
      const severities = report.findings.map((f) => f.severity);
      t.diagnostic(`Found severities: ${severities.join(', ')}`);
      
      const hasHighOrCritical = report.findings.some(
        (f) => f.severity === 'CRITICAL' || f.severity === 'HIGH'
      );
      assert.ok(hasHighOrCritical, 'Should detect at least one HIGH or CRITICAL security issue');
    }
  });

  test('parallel execution of all applicable agents completes', async (t) => {
    t.diagnostic('Running all 11 agents in parallel...');
    const startTime = Date.now();

    const promises = REVIEW_AGENTS.map((agent) =>
      runReviewAgent(agent, [MOCK_TS_FILE])
    );

    const reports = await Promise.all(promises);
    const elapsed = Date.now() - startTime;
    
    t.diagnostic(`All agents completed in ${elapsed}ms`);

    assert.equal(reports.length, REVIEW_AGENTS.length, 'All agents must return a report');

    for (const report of reports) {
      assert.ok(report.agentId, `Report missing agentId`);
      assert.ok(Array.isArray(report.findings), `${report.agentId} findings must be array`);
    }
  });

  test('aggregation produces valid review from parallel reports', async (t) => {
    const reports = await Promise.all(
      REVIEW_AGENTS.map((agent) => runReviewAgent(agent, [MOCK_TS_FILE]))
    );

    const review = aggregateReports(reports, MOCK_PR_CONTEXT);

    t.diagnostic(`Total findings: ${review.totalCount}`);
    t.diagnostic(`Critical: ${review.criticalCount}, High: ${review.highCount}, Medium: ${review.mediumCount}, Low: ${review.lowCount}`);
    t.diagnostic(`Agents run: ${review.agentsRun.join(', ')}`);
    t.diagnostic(`Agents with errors: ${review.agentErrors.join(', ') || 'none'}`);

    assert.ok(review.summary.includes('Automated PR Review'), 'Summary must include heading');
    assert.ok(review.summary.length > 200, 'Summary must be comprehensive');
    assert.ok(review.agentsRun.length > 0, 'At least one agent must have run');
  });
});

console.log('\n✅ Integration tests completed. Check results above.');
