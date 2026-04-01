import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.string().default('3000'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  GITHUB_APP_ID: z.string().default(''),
  GITHUB_APP_PRIVATE_KEY: z.string().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().default(''),
  MAX_PARALLEL_AGENTS: z.string().default('11'),
  REVIEW_TIMEOUT_MS: z.string().default('120000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

function loadConfig() {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join('.'));
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const env = result.data;

  return {
    port: parseInt(env.PORT, 10),
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
    },
    github: {
      appId: env.GITHUB_APP_ID ? parseInt(env.GITHUB_APP_ID, 10) : 0,
      privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    },
    review: {
      maxParallelAgents: parseInt(env.MAX_PARALLEL_AGENTS, 10),
      timeoutMs: parseInt(env.REVIEW_TIMEOUT_MS, 10),
    },
    isDevelopment: env.NODE_ENV === 'development',
  } as const;
}

export const config = loadConfig();
