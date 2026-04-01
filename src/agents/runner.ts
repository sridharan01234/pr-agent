import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ChangedFile, FindingReport, ReviewAgentConfig, ReviewFinding } from './types.js';

const MAX_DIFF_CHARS = 80000;
const OPENAI_TIMEOUT_MS = 90000;

interface RawFinding {
  rule: unknown;
  severity: unknown;
  filePath: unknown;
  line: unknown;
  endLine: unknown;
  title: unknown;
  body: unknown;
  suggestion: unknown;
}

function buildClient(): OpenAI {
  return new OpenAI({
    apiKey: config.openai.apiKey,
    timeout: OPENAI_TIMEOUT_MS,
  });
}

function buildUserPrompt(files: ChangedFile[]): string {
  const diffSections = files
    .filter((f) => f.patch.length > 0)
    .map((f) => `### File: ${f.path} (${f.status}, +${f.linesAdded}/-${f.linesRemoved})\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join('\n\n');

  const truncated = diffSections.slice(0, MAX_DIFF_CHARS);
  const wasTruncated = diffSections.length > MAX_DIFF_CHARS;

  return wasTruncated
    ? `${truncated}\n\n[DIFF TRUNCATED — review what is shown above only]`
    : truncated;
}

function parseFinding(raw: RawFinding, agentId: string): ReviewFinding | null {
  if (typeof raw.rule !== 'string' || typeof raw.title !== 'string' || typeof raw.body !== 'string') {
    return null;
  }

  const validSeverities = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  const severity = typeof raw.severity === 'string' && validSeverities.has(raw.severity)
    ? (raw.severity as ReviewFinding['severity'])
    : 'MEDIUM';

  return {
    agentId,
    rule: raw.rule,
    severity,
    filePath: typeof raw.filePath === 'string' ? raw.filePath : 'unknown',
    line: typeof raw.line === 'number' && raw.line > 0 ? raw.line : undefined,
    endLine: typeof raw.endLine === 'number' && raw.endLine > 0 ? raw.endLine : undefined,
    title: raw.title,
    body: raw.body,
    suggestion: typeof raw.suggestion === 'string' ? raw.suggestion : undefined,
  };
}

function parseFindings(content: string, agentId: string): ReviewFinding[] {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as { findings?: unknown[] };
    if (!Array.isArray(parsed.findings)) return [];

    return parsed.findings
      .map((f) => parseFinding(f as RawFinding, agentId))
      .filter((f): f is ReviewFinding => f !== null);
  } catch {
    logger.warn('Failed to parse agent findings JSON', { agentId, contentPreview: content.slice(0, 200) });
    return [];
  }
}

export async function runReviewAgent(
  agent: ReviewAgentConfig,
  files: ChangedFile[],
): Promise<FindingReport> {
  if (!agent.shouldRun(files)) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      findings: [],
      skipped: true,
      skipReason: 'No applicable files in this PR',
    };
  }

  const client = buildClient();
  const userPrompt = buildUserPrompt(files);

  if (!userPrompt.trim()) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      findings: [],
      skipped: true,
      skipReason: 'No diff content available for applicable files',
    };
  }

  try {
    logger.debug('Running review agent', { agentId: agent.id, fileCount: files.length });

    const response = await client.chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: agent.systemPrompt },
        { role: 'user', content: `Review the following PR diff:\n\n${userPrompt}` },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content ?? '{"findings":[]}';
    const findings = parseFindings(content, agent.id);

    logger.info('Review agent completed', { agentId: agent.id, findingCount: findings.length });

    return {
      agentId: agent.id,
      agentName: agent.name,
      findings,
      skipped: false,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('Review agent failed', { agentId: agent.id, error: errorMessage });

    return {
      agentId: agent.id,
      agentName: agent.name,
      findings: [],
      skipped: false,
      error: errorMessage,
    };
  }
}
