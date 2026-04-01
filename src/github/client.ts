import { Webhooks } from '@octokit/webhooks';
import { Octokit } from '@octokit/rest';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

let webhooksInstance: Webhooks | null = null;

export function getWebhooks(): Webhooks {
  if (!webhooksInstance) {
    webhooksInstance = new Webhooks({ secret: config.github.webhookSecret });
  }
  return webhooksInstance;
}

function createAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 600, iss: String(config.github.appId) },
    config.github.privateKey,
    { algorithm: 'RS256' },
  );
}

export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  const appOctokit = new Octokit({ auth: `Bearer ${createAppJwt()}` });

  const { data } = await appOctokit.request(
    'POST /app/installations/{installation_id}/access_tokens',
    { installation_id: installationId },
  );

  return new Octokit({ auth: (data as { token: string }).token });
}
