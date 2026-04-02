import { logger } from '../logger.js';
import { REVIEW_AGENTS } from './prompts.js';
import { runReviewAgent } from './runner.js';
import { aggregateReports } from './aggregator.js';
import type { AggregatedReview, PRContext } from './types.js';

export async function orchestrateReview(prContext: PRContext): Promise<AggregatedReview> {
  const { changedFiles, pr } = prContext;

  logger.info('Starting parallel review orchestration', {
    prNumber: pr.number,
    repository: pr.repository,
    fileCount: changedFiles.length,
    agentCount: REVIEW_AGENTS.length,
  });

  const applicableAgents = REVIEW_AGENTS.filter((agent) =>
    agent.shouldRun(changedFiles),
  );

  const skippedAgents = REVIEW_AGENTS.filter(
    (agent) => !agent.shouldRun(changedFiles),
  );

  logger.info('Agents selected', {
    applicable: applicableAgents.map((a) => a.id),
    skipped: skippedAgents.map((a) => a.id),
  });

  const agentPromises = applicableAgents.map((agent) =>
    runReviewAgent(agent, changedFiles.filter((f) => agent.shouldRun([f]))),
  );

  const reports = await Promise.all(agentPromises);

  const aggregated = aggregateReports(reports, prContext);

  logger.info('Review orchestration complete', {
    prNumber: pr.number,
    totalFindings: aggregated.totalCount,
    critical: aggregated.criticalCount,
    high: aggregated.highCount,
    agentsRun: aggregated.agentsRun.length,
    agentErrors: aggregated.agentErrors,
  });

  return aggregated;
}
