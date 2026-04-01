import type { Octokit } from '@octokit/rest';
import { logger } from '../logger.js';
import type { AggregatedReview, ReviewFinding } from '../agents/types.js';

const SEVERITY_EMOJI: Record<string, string> = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
  LOW: '🟢',
};

const MAX_INLINE_COMMENTS = 30;

function buildFindingBody(finding: ReviewFinding): string {
  const emoji = SEVERITY_EMOJI[finding.severity] ?? '⚪';
  const lines: string[] = [
    `${emoji} **[${finding.severity}]** \`${finding.rule}\` — ${finding.title}`,
    '',
    finding.body,
  ];

  if (finding.suggestion) {
    lines.push('', `**Suggestion:** ${finding.suggestion}`);
  }

  lines.push('', `*Agent: ${finding.agentId}*`);
  return lines.join('\n');
}

function buildDetailedFindingsSection(findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return '';
  }

  const grouped = new Map<string, ReviewFinding[]>();
  for (const finding of findings) {
    const existing = grouped.get(finding.filePath) ?? [];
    existing.push(finding);
    grouped.set(finding.filePath, existing);
  }

  const sections: string[] = ['## Findings by File', ''];

  for (const [filePath, fileFindings] of grouped) {
    sections.push(`### \`${filePath}\``);
    sections.push('');

    for (const finding of fileFindings) {
      const emoji = SEVERITY_EMOJI[finding.severity] ?? '⚪';
      const lineRef = finding.line ? ` (line ${finding.line})` : '';
      sections.push(
        `#### ${emoji} [${finding.severity}] \`${finding.rule}\` — ${finding.title}${lineRef}`,
        '',
        finding.body,
      );
      if (finding.suggestion) {
        sections.push('', `> **Suggestion:** ${finding.suggestion}`);
      }
      sections.push('');
    }
  }

  return sections.join('\n');
}

interface PullRequestFile {
  filename: string;
  patch?: string;
}

async function fetchPRFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestFile[]> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return data as PullRequestFile[];
}

function buildDiffPositionMap(patch: string): Map<number, number> {
  const lineToPosition = new Map<number, number>();
  let fileLineNumber = 0;
  let diffPosition = 0;

  for (const line of patch.split('\n')) {
    diffPosition++;
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (match) {
        fileLineNumber = parseInt(match[1], 10) - 1;
      }
      continue;
    }
    if (!line.startsWith('-')) {
      fileLineNumber++;
      lineToPosition.set(fileLineNumber, diffPosition);
    }
  }

  return lineToPosition;
}

export async function publishReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  review: AggregatedReview,
): Promise<void> {
  const prFiles = await fetchPRFiles(octokit, owner, repo, pullNumber);

  const patchMap = new Map<string, Map<number, number>>();
  for (const file of prFiles) {
    if (file.patch) {
      patchMap.set(file.filename, buildDiffPositionMap(file.patch));
    }
  }

  const inlineFindings = review.findings
    .filter((f) => f.line !== undefined)
    .slice(0, MAX_INLINE_COMMENTS);

  const reviewComments = inlineFindings
    .map((finding) => {
      const filePositions = patchMap.get(finding.filePath);
      const position = filePositions?.get(finding.line!);
      if (!position) return null;

      return {
        path: finding.filePath,
        position,
        body: buildFindingBody(finding),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const findingsWithoutInline = review.findings.filter(
    (f) => !inlineFindings.some((i) => i === f),
  );

  const detailedSection = buildDetailedFindingsSection(findingsWithoutInline);
  const fullBody = detailedSection
    ? `${review.summary}\n\n${detailedSection}`
    : review.summary;

  // Always use COMMENT — REQUEST_CHANGES is blocked on self-authored PRs and
  // on GitHub Actions GITHUB_TOKEN which has limited reviewer permissions.
  // The severity verdict is clearly communicated in the review body text.
  const reviewEvent = 'COMMENT';

  try {
    await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitSha,
      body: fullBody,
      event: reviewEvent,
      comments: reviewComments,
    });

    logger.info('PR review posted', {
      owner,
      repo,
      pullNumber,
      event: reviewEvent,
      inlineComments: reviewComments.length,
      totalFindings: review.totalCount,
    });
  } catch (err) {
    logger.error('Failed to post PR review', {
      owner,
      repo,
      pullNumber,
      error: err instanceof Error ? err.message : String(err),
    });

    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner,
      repo,
      issue_number: pullNumber,
      body: fullBody,
    });

    logger.info('Fell back to issue comment for PR review', { owner, repo, pullNumber });
  }
}
