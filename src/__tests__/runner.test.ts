import type { ChangedFile, ReviewAgentConfig } from '../agents/types';

const mockCreate = jest.fn();

jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
  };
});

jest.mock('../config', () => ({
  config: {
    openai: { apiKey: 'test-key', model: 'gpt-4.1-mini' },
    github: { appId: 1, privateKey: 'pk', webhookSecret: 'secret' },
    review: { maxParallelAgents: 11, timeoutMs: 120000 },
    port: 3000,
    isDevelopment: false,
  },
}));

import { runReviewAgent } from '../agents/runner';

const mockTsFile: ChangedFile = {
  path: 'src/user.service.ts',
  status: 'modified',
  linesAdded: 10,
  linesRemoved: 2,
  patch: '@@ -1,5 +1,10 @@\n+const secret = "hardcoded";\n+console.log("test");',
  isTypeScript: true,
  isReact: false,
  isTest: false,
  isConstants: false,
  isListener: false,
  isService: true,
  isView: false,
};

const mockAgent: ReviewAgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  systemPrompt: 'You are a test reviewer. Output JSON.',
  shouldRun: (files) => files.some((f) => f.isTypeScript),
};

describe('runReviewAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns skipped when no applicable files', async () => {
    const noTsFiles: ChangedFile[] = [
      { ...mockTsFile, isTypeScript: false, path: 'README.md' },
    ];

    const agentThatNeedsTs: ReviewAgentConfig = {
      ...mockAgent,
      shouldRun: (files) => files.some((f) => f.isTypeScript),
    };

    const result = await runReviewAgent(agentThatNeedsTs, noTsFiles);

    expect(result.skipped).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('calls OpenAI and parses valid findings', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  rule: 'SEC-1',
                  severity: 'HIGH',
                  filePath: 'src/user.service.ts',
                  line: 1,
                  title: 'Hardcoded secret',
                  body: 'API key hardcoded in source',
                  suggestion: 'Use environment variables instead',
                },
              ],
            }),
          },
        },
      ],
    });

    const result = await runReviewAgent(mockAgent, [mockTsFile]);

    expect(result.skipped).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].rule).toBe('SEC-1');
    expect(result.findings[0].severity).toBe('HIGH');
    expect(result.findings[0].agentId).toBe('test-agent');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('returns empty findings when OpenAI returns empty array', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"findings":[]}' } }],
    });

    const result = await runReviewAgent(mockAgent, [mockTsFile]);

    expect(result.findings).toHaveLength(0);
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('returns error report when OpenAI throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Rate limit exceeded'));

    const result = await runReviewAgent(mockAgent, [mockTsFile]);

    expect(result.skipped).toBe(false);
    expect(result.error).toContain('Rate limit exceeded');
    expect(result.findings).toHaveLength(0);
  });

  it('handles malformed JSON gracefully', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'This is not JSON' } }],
    });

    const result = await runReviewAgent(mockAgent, [mockTsFile]);

    expect(result.findings).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it('normalizes unknown severity to MEDIUM', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  rule: 'X-1',
                  severity: 'UNKNOWN_LEVEL',
                  filePath: 'src/file.ts',
                  title: 'Some issue',
                  body: 'Description',
                },
              ],
            }),
          },
        },
      ],
    });

    const result = await runReviewAgent(mockAgent, [mockTsFile]);

    expect(result.findings[0].severity).toBe('MEDIUM');
  });
});
