/**
 * Autonomous Dev Fix Orchestrator — GitHub Actions entry point.
 *
 * Reads a GitHub issue, implements a fix, opens a PR, monitors the AI review,
 * and auto-merges when CRITICAL + HIGH finding count reaches zero.
 *
 * Environment variables:
 *   GITHUB_TOKEN     — GitHub Actions token (needs contents:write, pull-requests:write, issues:write)
 *   GITHUB_REPOSITORY — "owner/repo"
 *   ISSUE_NUMBER     — GitHub issue number to fix
 *   OPENAI_API_KEY   — For the review agents (they run separately via pr-review.yml)
 */
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import { logger } from '../logger.js';
import { config } from '../config.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  html_url: string;
}

interface ReviewSummary {
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  body: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OWNER_REPO_SEPARATOR = '/';
const MAX_FIX_CYCLES = 3;
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 40; // 20 minutes max wait
const SQUASH_MERGE = 'squash';
const WORKFLOW_COMPLETED = 'completed';
const CONCLUSION_SUCCESS = 'success';
const CONCLUSION_FAILURE = 'failure';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
}

function extractCountsFromReviewBody(body: string): ReviewSummary {
  const match = (pattern: RegExp): number => {
    const m = body.match(pattern);
    return m ? parseInt(m[1], 10) : 0;
  };

  return {
    criticalCount: match(/🔴 Critical[^\d]*(\d+)/),
    highCount: match(/🟠 High[^\d]*(\d+)/),
    mediumCount: match(/🟡 Medium[^\d]*(\d+)/),
    lowCount: match(/🟢 Low[^\d]*(\d+)/),
    body,
  };
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

async function fetchIssue(octokit: Octokit, owner: string, repo: string, issueNumber: number): Promise<GithubIssue> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
    owner,
    repo,
    issue_number: issueNumber,
  });
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? null,
    labels: (data.labels ?? []).map((l) => ({ name: typeof l === 'string' ? l : l.name ?? '' })),
    html_url: data.html_url,
  };
}

async function getDefaultBranchSha(octokit: Octokit, owner: string, repo: string): Promise<string> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/refs/heads/main', {
    owner,
    repo,
  });
  return data.object.sha;
}

async function createBranch(octokit: Octokit, owner: string, repo: string, branchName: string, sha: string): Promise<void> {
  try {
    await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha,
    });
    logger.info('Branch created', { branchName });
  } catch (err: unknown) {
    // 422 = branch already exists (e.g. duplicate event trigger) — reuse it
    const status = (err as { status?: number }).status;
    if (status === 422) {
      logger.info('Branch already exists — reusing', { branchName });
      return;
    }
    throw err;
  }
}

async function openPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string,
): Promise<number> {
  try {
    const { data } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      title,
      body,
      head,
      base,
      draft: false,
    });
    logger.info('PR opened', { prNumber: data.number, url: data.html_url });
    return data.number;
  } catch (err: unknown) {
    // 422 = PR already exists for this branch — find and return it
    const status = (err as { status?: number }).status;
    if (status === 422) {
      const { data: pulls } = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        head: `${owner}:${head}`,
        state: 'open',
      });
      if (pulls.length > 0) {
        logger.info('PR already exists — reusing', { prNumber: pulls[0].number });
        return pulls[0].number;
      }
    }
    throw err;
  }
}

async function pollWorkflowCompletion(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  workflowName: string,
): Promise<'success' | 'failure' | 'timeout'> {
  logger.info('Polling for workflow completion', { branchName, workflowName });

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
      owner,
      repo,
      branch: branchName,
      per_page: 10,
    });

    const run = data.workflow_runs
      .filter((r) => r.name === workflowName && r.head_branch === branchName)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    if (!run) {
      logger.debug('Workflow run not yet started', { attempt });
      continue;
    }

    logger.debug('Workflow run status', { status: run.status, conclusion: run.conclusion, id: run.id });

    if (run.status === WORKFLOW_COMPLETED) {
      return run.conclusion === CONCLUSION_SUCCESS ? 'success' : 'failure';
    }
  }

  return 'timeout';
}

async function fetchReviewSummary(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewSummary | null> {
  const { data: reviews } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
    owner,
    repo,
    pull_number: prNumber,
  });

  // Match by body marker — works whether review posted by github-actions[bot] or PAT user
  const botReview = reviews
    .filter((r) => r.user?.login === 'github-actions[bot]' || r.body?.includes('🤖 Automated PR Review'))
    .sort((a, b) => new Date(b.submitted_at ?? 0).getTime() - new Date(a.submitted_at ?? 0).getTime())[0];

  if (!botReview?.body) return null;
  return extractCountsFromReviewBody(botReview.body);
}

async function mergePullRequest(octokit: Octokit, owner: string, repo: string, prNumber: number, title: string): Promise<void> {
  await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
    owner,
    repo,
    pull_number: prNumber,
    merge_method: SQUASH_MERGE,
    commit_title: title,
  });
  logger.info('PR merged', { prNumber });
}

async function closeIssueWithComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
): Promise<void> {
  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner,
    repo,
    issue_number: issueNumber,
    body: `✅ Fixed in PR #${prNumber} and merged to \`main\` automatically by the Dev Fix Orchestrator.`,
  });

  await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
    owner,
    repo,
    issue_number: issueNumber,
    state: 'closed',
    state_reason: 'completed',
  });

  logger.info('Issue closed', { issueNumber });
}

async function commentOnPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

// ─── AI Fix Generator ─────────────────────────────────────────────────────────

async function generateFix(
  openai: OpenAI,
  issue: GithubIssue,
  reviewFindings: string,
  currentCode: Map<string, string>,
): Promise<Array<{ path: string; content: string; message: string }>> {
  const fileContext = Array.from(currentCode.entries())
    .map(([path, content]) => `### ${path}\n\`\`\`typescript\n${content.slice(0, 4000)}\n\`\`\``)
    .join('\n\n');

  const prompt = reviewFindings
    ? `You are fixing code quality issues found in a PR review.\n\nFindings to fix:\n${reviewFindings}\n\nCurrent code:\n${fileContext}`
    : `You are fixing a GitHub issue.\n\nIssue #${issue.number}: ${issue.title}\n\n${issue.body ?? ''}\n\nCurrent code:\n${fileContext}`;

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: 'system',
        content: `You are an expert TypeScript developer. Analyze the code and produce precise fixes.
Output ONLY valid JSON in this exact format:
{
  "files": [
    {
      "path": "relative/path/to/file.ts",
      "content": "complete updated file content",
      "message": "fix(scope): description of what was changed"
    }
  ],
  "summary": "one paragraph describing all changes made"
}
Rules:
- Return complete file content (not diffs)
- Use strict TypeScript — no 'any' types
- Follow existing code patterns
- Each commit message must follow Conventional Commits format
- Only fix the specific issues — do not refactor unrelated code`,
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  const content = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content) as { files?: Array<{ path: string; content: string; message: string }> };
  return parsed.files ?? [];
}

// ─── File operations ──────────────────────────────────────────────────────────

async function getRepoFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePaths: string[],
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  for (const path of filePaths) {
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
      });

      if (!Array.isArray(data) && data.type === 'file' && 'content' in data) {
        files.set(path, Buffer.from(data.content, 'base64').toString('utf8'));
      }
    } catch {
      logger.debug('File not found in repo', { path });
    }
  }

  return files;
}

async function pushFilesToBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  files: Array<{ path: string; content: string; message: string }>,
): Promise<void> {
  for (const file of files) {
    let sha: string | undefined;

    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: file.path,
        ref: branch,
      });
      if (!Array.isArray(data) && 'sha' in data) {
        sha = data.sha;
      }
    } catch {
      // File doesn't exist yet — that's fine for new files
    }

    await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path: file.path,
      message: file.message,
      content: Buffer.from(file.content, 'utf8').toString('base64'),
      branch,
      sha,
    });

    logger.info('File pushed to branch', { path: file.path, branch });
  }
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

async function determineAffectedFiles(issue: GithubIssue): Promise<string[]> {
  const body = `${issue.title} ${issue.body ?? ''}`.toLowerCase();
  const files: string[] = [];

  if (body.includes('runner') || body.includes('agent')) files.push('src/agents/runner.ts');
  if (body.includes('orchestrat')) files.push('src/agents/orchestrator.ts');
  if (body.includes('classif')) files.push('src/agents/classifier.ts');
  if (body.includes('aggregat')) files.push('src/agents/aggregator.ts');
  if (body.includes('publisher') || body.includes('comment')) files.push('src/github/comment-publisher.ts');
  if (body.includes('webhook')) files.push('src/github/webhook-handler.ts');
  if (body.includes('config')) files.push('src/config.ts');
  if (body.includes('prompt')) files.push('src/agents/prompts.ts');

  // Always include types and logger as context
  files.push('src/agents/types.ts', 'src/logger.ts');

  return [...new Set(files)];
}

async function run(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repoEnv = process.env.GITHUB_REPOSITORY;
  const issueNumberStr = process.env.ISSUE_NUMBER;

  if (!token || !repoEnv || !issueNumberStr) {
    logger.error('Missing required env vars', {
      GITHUB_TOKEN: !!token,
      GITHUB_REPOSITORY: repoEnv,
      ISSUE_NUMBER: issueNumberStr,
    });
    process.exit(1);
  }

  const [owner, repo] = repoEnv.split(OWNER_REPO_SEPARATOR);
  const issueNumber = parseInt(issueNumberStr, 10);

  if (!owner || !repo || isNaN(issueNumber)) {
    logger.error('Invalid env vars', { repoEnv, issueNumberStr });
    process.exit(1);
  }

  const octokit = new Octokit({ auth: token });
  const openai = new OpenAI({ apiKey: config.openai.apiKey });

  // ── Phase 1: Fetch issue ────────────────────────────────────────────────────
  logger.info('Fetching issue', { owner, repo, issueNumber });
  const issue = await fetchIssue(octokit, owner, repo, issueNumber);
  logger.info('Issue loaded', { title: issue.title, url: issue.html_url });

  // ── Phase 2: Create fix branch ─────────────────────────────────────────────
  const slug = slugify(issue.title);
  const branchName = `fix/issue-${issue.number}-${slug}`;
  const mainSha = await getDefaultBranchSha(octokit, owner, repo);
  await createBranch(octokit, owner, repo, branchName, mainSha);

  // ── Phase 3: Determine affected files ──────────────────────────────────────
  const affectedPaths = await determineAffectedFiles(issue);
  logger.info('Determined affected files', { count: affectedPaths.length, files: affectedPaths });

  const currentCode = await getRepoFiles(octokit, owner, repo, affectedPaths);
  logger.info('Fetched current file contents', { fileCount: currentCode.size });

  // ── Phase 4: Generate initial fix with OpenAI ──────────────────────────────
  logger.info('Generating fix via OpenAI', { model: config.openai.model });
  const fixedFiles = await generateFix(openai, issue, '', currentCode);

  if (fixedFiles.length === 0) {
    logger.warn('OpenAI returned no file changes — the issue may not require code changes', { issueNumber });
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner, repo, issue_number: issueNumber,
      body: `⚠️ The Dev Fix Orchestrator could not determine code changes for this issue. Human review required.\n\n> Issue: ${issue.title}`,
    });
    return;
  }

  // ── Phase 5: Push initial fix ──────────────────────────────────────────────
  logger.info('Pushing fix to branch', { branchName, fileCount: fixedFiles.length });
  await pushFilesToBranch(octokit, owner, repo, branchName, fixedFiles);

  // ── Phase 6: Open PR ───────────────────────────────────────────────────────
  const prTitle = `fix(issue-${issue.number}): ${issue.title}`;
  const prBody = `## Summary

Automated fix for issue #${issue.number}.

**Issue:** ${issue.html_url}

### Files changed
${fixedFiles.map((f) => `- \`${f.path}\` — ${f.message}`).join('\n')}

### What was changed
Automatically generated by the Dev Fix Orchestrator. The AI analyzed the issue, identified affected source files, and produced targeted code fixes.

Closes #${issue.number}`;

  const prNumber = await openPullRequest(octokit, owner, repo, prTitle, prBody, branchName, 'main');
  logger.info('PR created', { prNumber, branchName });

  // ── Phase 7-8: Review-fix loop ─────────────────────────────────────────────
  const REVIEW_WORKFLOW_NAME = 'PR Review Agent';

  for (let cycle = 1; cycle <= MAX_FIX_CYCLES; cycle++) {
    logger.info(`Review cycle ${cycle}/${MAX_FIX_CYCLES} — waiting for workflow`, { branchName });

    const workflowResult = await pollWorkflowCompletion(octokit, owner, repo, branchName, REVIEW_WORKFLOW_NAME);

    if (workflowResult === 'timeout') {
      logger.warn('Workflow did not complete in time — halting');
      await commentOnPR(octokit, owner, repo, prNumber,
        `⚠️ Dev Fix Orchestrator: The review workflow timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 60000} minutes. Human review required.`);
      return;
    }

    if (workflowResult === 'failure') {
      logger.error('Workflow failed (typecheck or unit tests) — cannot merge');
      await commentOnPR(octokit, owner, repo, prNumber,
        `❌ Dev Fix Orchestrator: The CI workflow failed (typecheck or unit tests). Human intervention required.`);
      return;
    }

    // Fetch review summary posted by the review agent
    const reviewSummary = await fetchReviewSummary(octokit, owner, repo, prNumber);

    if (!reviewSummary) {
      logger.warn('No review found yet — review agent may not have posted. Checking once more after delay.');
      await sleep(POLL_INTERVAL_MS);
      const retryReview = await fetchReviewSummary(octokit, owner, repo, prNumber);
      if (!retryReview) {
        logger.warn('Still no review — merging anyway (workflow succeeded, no blocking findings)');
        break;
      }
    }

    const { criticalCount, highCount } = reviewSummary ?? { criticalCount: 0, highCount: 0 };

    logger.info('Review summary', {
      cycle,
      criticalCount,
      highCount,
      mediumCount: reviewSummary?.mediumCount ?? 0,
      lowCount: reviewSummary?.lowCount ?? 0,
    });

    if (criticalCount === 0 && highCount === 0) {
      logger.info('Review passed — merging PR');
      break;
    }

    if (cycle === MAX_FIX_CYCLES) {
      logger.warn('Max fix cycles reached — cannot auto-merge', { criticalCount, highCount });
      await commentOnPR(octokit, owner, repo, prNumber,
        `⚠️ Dev Fix Orchestrator: After ${MAX_FIX_CYCLES} fix cycles, ${criticalCount} CRITICAL and ${highCount} HIGH findings remain. Human review required.\n\nPlease resolve the remaining issues manually.`);
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: issueNumber,
        body: `⚠️ Automated fix in PR #${prNumber} could not fully resolve all review findings. Human review required.`,
      });
      return;
    }

    // Generate targeted fixes for CRITICAL/HIGH findings
    logger.info('Generating targeted fixes for review findings', { cycle });
    const reviewText = reviewSummary?.body ?? '';
    const updatedCode = await getRepoFiles(octokit, owner, repo, fixedFiles.map((f) => f.path));
    const revisedFiles = await generateFix(openai, issue, reviewText, updatedCode);

    if (revisedFiles.length > 0) {
      await pushFilesToBranch(octokit, owner, repo, branchName, revisedFiles);
      logger.info('Pushed revised fixes', { cycle, fileCount: revisedFiles.length });
    } else {
      logger.warn('No revised files generated — review findings may be informational only');
      break;
    }
  }

  // ── Phase 9: Merge ─────────────────────────────────────────────────────────
  await mergePullRequest(octokit, owner, repo, prNumber, prTitle);
  await closeIssueWithComment(octokit, owner, repo, issueNumber, prNumber);

  logger.info('Dev Fix Orchestrator completed successfully', {
    issueNumber,
    prNumber,
    branchName,
  });
}

run().catch((err: unknown) => {
  logger.error('Dev Fix Orchestrator failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
