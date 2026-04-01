# PR Review Agent

An automated GitHub PR review system powered by 11 parallel OpenAI agents. Reviews code against your engineering standards and posts actionable comments directly on pull requests.

## How It Works

On every PR event (opened, reopened, synchronize, ready_for_review), the system:

1. **Fetches** all changed files and their diffs from the GitHub API
2. **Dispatches** 11 specialized review agents in parallel via `Promise.all()`
3. **Aggregates** findings with deduplication, severity sorting (CRITICAL → HIGH → MEDIUM → LOW)
4. **Posts** a structured review comment on the PR with inline annotations

## Review Agents

| Agent | Rule Set | Trigger |
|-------|----------|---------|
| `type-safety` | TS-1–7: no `any`, discriminated unions, type guards | Any `.ts/.tsx` file |
| `constants` | C-1–5: no magic numbers/strings, UPPER_SNAKE_CASE | Any `.ts/.tsx` file |
| `single-responsibility` | SR-1–4: one class/function per file, layer separation | Service/listener/view files |
| `async-patterns` | AP-1–5: `async/await` only, no `.then()` mixing | Any `.ts/.tsx` file |
| `security` | SEC-1–10: OWASP Top 10, no eval, no hardcoded secrets | **All files** |
| `react-standards` | RX-1–7: functional components, hooks rules, RTK | `.tsx/.jsx` files |
| `object-calisthenics` | OC-1–9: one indent level, no else, small classes | Service/listener non-test files |
| `naming-conventions` | NC-1–6: PascalCase types, camelCase fns, UPPER_SNAKE constants | Any `.ts/.tsx` file |
| `documentation` | DOC-1–5: JSDoc on public methods, no stale comments | Any `.ts/.tsx` file |
| `code-flow` | CF-1–6: guard clauses, max 2 indent levels | Any `.ts/.tsx` file |
| `error-handling` | EH-1–6: structured errors, no console.log, dispose resources | Non-test `.ts` files |

## Setup

### GitHub Actions (Recommended)

Add `OPENAI_API_KEY` to your repository secrets, then the workflow at `.github/workflows/pr-review.yml` will automatically trigger on all PR events.

No GitHub App needed — uses `GITHUB_TOKEN` for GitHub API access.

### GitHub App Server (Production)

For self-hosted webhook deployment:

```bash
cp .env.example .env
# Fill in: OPENAI_API_KEY, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET
npm install
npm run build
npm start
```

## Development

```bash
npm install
npm run build          # Compile TypeScript
npm run test:unit      # 17 unit tests (no API calls)
npm run test:integration  # Live OpenAI API tests (requires OPENAI_API_KEY)
npm run typecheck      # TypeScript type check only
```

## Architecture

```
src/
  config.ts                    Zod-validated environment config
  logger.ts                    Structured logger
  app.ts                       Express webhook server entry point
  agents/
    types.ts                   All TypeScript types
    prompts.ts                 11 review agent system prompts + shouldRun filters
    classifier.ts              Classifies PR files by type
    runner.ts                  OpenAI chat completions runner
    aggregator.ts              Deduplication + severity sort + summary
    orchestrator.ts            Promise.all() parallel dispatch
  github/
    client.ts                  Webhooks singleton + GitHub App JWT auth
    webhook-handler.ts         PR event handler
    comment-publisher.ts       Posts review via GitHub PR Reviews API
  scripts/
    review-pr-action.ts        GitHub Actions entry point
```

## Requirements

- Node.js 18+
- OpenAI API key with `gpt-4.1-mini` (or other chat model) access
- For GitHub App mode: a registered GitHub App with PR read/write permissions
