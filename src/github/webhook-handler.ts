import type { Webhooks } from '@octokit/webhooks';
import { Octokit } from '@octokit/rest';
import { logger } from '../logger.js';
import { classifyFiles } from '../agents/classifier.js';
import { orchestrateReview } from '../agents/orchestrator.js';
import { publishReview } from './comment-publisher.js';
import { getInstallationOctokit } from './client.js';
import type { PRContext, PRMetadata, Commit } from '../agents/types.js';

const DRAFT_SKIP_EVENTS = new Set(['opened', 'reopened']);

interface PullRequestPayload {
  action: string;
  number: number;
  pull_request: {
    title: string;
    body: string | null;
    user: { login: string };
    head: { ref: string; sha: string };
    base: { ref: string };
    html_url: string;
    draft: boolean;
    state: string;
  };
  repository: {
    name: string;
    owner: { login: string };
    full_name: string;
  };
  installation?: { id: number };
}

interface RawCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string } | null;
  };
}

interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

async function fetchPRContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  pr: PullRequestPayload['pull_request'],
  installationId: number,
): Promise<PRContext> {
  const [pagedFiles, commitsResponse] = await Promise.all([
    octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    }),
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 50,
    }),
  ]);

  const rawFiles = pagedFiles as RawFile[];
  const rawCommits = commitsResponse.data as RawCommit[];

  const changedFiles = classifyFiles(rawFiles);

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
    author: pr.user.login,
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    url: pr.html_url,
    owner,
    repository: repo,
    installationId,
    headSha: pr.head.sha,
  };

  return {
    pr: metadata,
    changedFiles,
    fullDiff,
    commits,
  };
}

export function registerWebhookHandlers(webhooks: Webhooks): void {
  const handlePREvent = async (payload: PullRequestPayload): Promise<void> => {
    const { action, number: pullNumber, pull_request: pr, repository } = payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const installationId = payload.installation?.id ?? 0;

    if (pr.draft && DRAFT_SKIP_EVENTS.has(action)) {
      logger.info('Skipping draft PR', { owner, repo, pullNumber, action });
      return;
    }

    logger.info('PR event received', { owner, repo, pullNumber, action, author: pr.user.login });

    try {
      const octokit = await getInstallationOctokit(installationId);

      const prContext = await fetchPRContext(
        octokit,
        owner,
        repo,
        pullNumber,
        pr,
        installationId,
      );

      if (prContext.changedFiles.length === 0) {
        logger.info('PR has no changed files — skipping review', { owner, repo, pullNumber });
        return;
      }

      const review = await orchestrateReview(prContext);

      await publishReview(
        octokit,
        owner,
        repo,
        pullNumber,
        pr.head.sha,
        review,
        prContext.changedFiles,
      );

      logger.info('PR review completed and published', {
        owner,
        repo,
        pullNumber,
        totalFindings: review.totalCount,
      });
    } catch (err) {
      logger.error('Failed to process PR review', {
        owner,
        repo,
        pullNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  webhooks.on(
    ['pull_request.opened', 'pull_request.reopened', 'pull_request.synchronize', 'pull_request.ready_for_review'],
    ({ payload }) => handlePREvent(payload as unknown as PullRequestPayload),
  );

  webhooks.onError((error) => {
    logger.error('Webhook processing error', {
      error: error.message,
    });
  });
}
