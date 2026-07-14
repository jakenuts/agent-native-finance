# Finance

Finance is an Agent Native personal and business finance template. It syncs
banking data from Plaid, models recurring obligations and payment plans, tracks
projected income, and exposes the same operations to the UI and in-app agent
through Agent Native actions.

<img width="1655" height="1358" alt="image" src="https://github.com/user-attachments/assets/ec51eb21-9431-46d4-b0f5-c16a8567b0c9" />

## Local Setup

Use Node 22.22+ and pnpm 11.10.0.

```bash
corepack enable
corepack prepare pnpm@11.10.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Local development defaults to `file:./data/app.db`. Set
`AUTH_DISABLED=true` only in local or disposable preview environments if you
need to bypass login while building.

To scaffold from this public template:

```bash
npx @agent-native/core@latest create my-finance --template github:jakenuts/agent-native-finance
```

## Useful Commands

```bash
pnpm typecheck
pnpm build
pnpm action finance-summary '{}'
pnpm action profile-audit '{}'
pnpm action db-check-scoping '{}'
```

For profile-scoped work, `profile-audit` should return an empty
`violations` array before the change is considered complete.

## Environment

Copy `.env.example` for local values. Real secrets belong in local `.env`,
GitHub Actions secrets, and your deployment provider's environment variables.
Do not commit real keys or token values.

Common production variables:

- `DATABASE_URL` and provider-specific `DATABASE_AUTH_TOKEN` if needed.
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `OAUTH_STATE_SECRET`,
  `A2A_SECRET`, and `SECRETS_ENCRYPTION_KEY`.
- `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, and optional Plaid webhook
  or redirect URLs.
- Optional projection automation: `RECURLY_API_KEY` and optional
  `RECURLY_SUBDOMAIN`. Manual projected entries and Recurly CSV import work
  without the API key.
- One agent LLM provider key such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
- Optional single-tenant signup lock: `FINANCE_BLOCK_SIGNUP=true` after the
  owner account has been created.

Finance also registers app-specific setup steps in the Agent Native sidebar.
Keys saved there are stored as scoped encrypted secrets and read by the same
runtime helpers as deployment environment variables.

## Deployment

Agent Native builds through Nitro and can deploy to Node.js, Railway, Netlify,
Vercel, Cloudflare, and other Nitro presets. Set `DATABASE_URL` to a persistent
SQL database before production use.

This repo includes:

- `railway.json` for a Node/Railway deployment.
- `.github/workflows/deploy.yml` as a manual Railway deploy workflow. Add your
  own push trigger after configuring `RAILWAY_TOKEN`.
- `netlify.toml` for Netlify builds.
