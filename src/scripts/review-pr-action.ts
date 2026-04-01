/**
 * GitHub Actions entry point.
 * Reads PR context from environment variables set by the workflow,
 * runs the 11-agent parallel review pipeline, and posts results via GITHUB_TOKEN.
 */
import { Octokit } from '@octokit/rest';
import { logger } from '../logger.js';
import { classifyFiles } from '../agents/classifier.js';
import { orchestrateReview } from '../agents/orchestrator.js';
import { publishReview } from '../github/comment-publisher.js';
import type { PRContext, PRMetadata, Commit } from '../agents/types.js';

interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface RawCommit {
  sha: string;
  commit: { message: string; author: { name: string } | null };
}

async function run(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumberStr = process.env.PR_NUMBER;
  const headSha = process.env.HEAD_SHA ?? '';

  if (!token || !repo || !prNumberStr) {
    logger.error('Missing required env vars', { GITHUB_TOKEN: !!token, GITHUB_REPOSITORY: repo, PR_NUMBER: prNumberStr });
    process.exit(1);
  }

  const [owner, repository] = repo.split('/');
  const pullNumber = parseInt(prNumberStr, 10);

  if (!owner || !repository || isNaN(pullNumber)) {
    logger.error('Invalid GITHUB_REPOSITORY or PR_NUMBER', { repo, prNumberStr });
    process.exit(1);
  }

  const octokit = new Octokit({ auth: token });

  logger.info('Fetching PR data', { owner, repository, pullNumber });

  const [prResponse, filesResponse, commitsResponse] = await Promise.all([
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo: repository,
      pull_number: pullNumber,
    }),
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner,
      repo: repository,
      pull_number: pullNumber,
      per_page: 100,
    }),
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
      owner,
      repo: repository,
      pull_number: pullNumber,
      per_page: 50,
    }),
  ]);

  const pr = prResponse.data;
  const rawFiles = filesResponse.data as RawFile[];
  const rawCommits = commitsResponse.data as RawCommit[];

  const changedFiles = classifyFiles(rawFiles);

  if (changedFiles.length === 0) {
    logger.info('No changed files in PR — skipping review');
    return;
  }

  const commits: Commit[] = rawCommits.map((c) => ({
    hash: c.sha.slice(0, 8),
    message: c.commit.message.split('\n')[0],
    author: c.commit.author?.name ?? 'Unknown',
  }));

  const fullDiff = changedFiles
    .filter((f) => f.patch)
    .map((f) => `diff --git a/${f.path} b/${f.path}\n${f.patch}`)
    .join('\n\n');

  const metadata: PRMetadata = {
    number: pullNumber,
    title: pr.title,
    description: pr.body ?? '',
    author: pr.user?.login ?? 'unknown',
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    url: pr.html_url,
    owner,
    repository,
    installationId: 0,
    headSha: headSha || pr.head.sha,
  };

  const prContext: PRContext = { pr: metadata, changedFiles, fullDiff, commits };

  logger.info('Starting parallel review with 11 agents', { fileCount: changedFiles.length });

  const review = await orchestrateReview(prContext);

  logger.info('Review complete — posting to GitHub', {
    totalFindings: review.totalCount,
    critical: review.criticalCount,
    high: review.highCount,
  });

  await publishReview(
    octokit,
    owner,
    repository,
    pullNumber,
    metadata.headSha,
    review,
  );

  logger.info('PR review agent finished successfully');
}

run().catch((err) => {
  logger.error('PR review action failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
