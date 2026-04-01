import express from 'express';
import { createNodeMiddleware } from '@octokit/webhooks';
import { config } from './config.js';
import { logger } from './logger.js';
import { getWebhooks } from './github/client.js';
import { registerWebhookHandlers } from './github/webhook-handler.js';

const WEBHOOK_PATH = '/webhook';
const HEALTH_PATH = '/health';

async function main(): Promise<void> {
  const app = express();
  const webhooks = getWebhooks();

  registerWebhookHandlers(webhooks);

  const webhookMiddleware = createNodeMiddleware(webhooks, {
    path: WEBHOOK_PATH,
  });

  app.use(webhookMiddleware);

  app.get(HEALTH_PATH, (_req, res) => {
    res.json({
      status: 'ok',
      service: 'pr-review-agent',
      timestamp: new Date().toISOString(),
    });
  });

  app.listen(config.port, () => {
    logger.info('PR Review Agent webhook server started', {
      port: config.port,
      webhookPath: WEBHOOK_PATH,
      healthPath: HEALTH_PATH,
    });
  });
}

main().catch((err) => {
  logger.error('Server startup failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
