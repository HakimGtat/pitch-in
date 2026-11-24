# Pitch In

An internal board for the projects coworkers build with AI: websites, games, apps, research, automation. Owners post a single task or a project with milestones from a company repo. Any coworker takes on as much as they want, runs it in their own Claude session, and their agent opens a pull request for the owner to review.

One install per company. Everything runs locally with `docker compose`: the web app, a worker, a webhook relay and Postgres. The site never stores Claude tokens, never starts agent runs, never runs contributor code, and never merges. Merging happens on GitHub.

The full plan is in [plan.md](plan.md).

## Status

Milestone 1 (foundation) is built:

- `docker compose` with the Next.js web app, the worker, the smee webhook relay and Postgres, plus migrations for the whole data model
- GitHub sign-in limited to one GitHub team, re-checked at every sign-in
- Main admin seeded from `MAIN_ADMIN_GITHUB_LOGIN`, the "Are you on the AI team?" question, the block list and the audit log
- GitHub App registration through GitHub's manifest flow, and webhooks received through smee

Projects, milestones, tasks, briefs and the board come in Milestone 2.

## Running it

You need Docker (Docker Desktop on Windows or Mac, Docker Engine on Linux).

1. Copy the example config and fill it in. The comments in the file explain each value.

   ```powershell
   Copy-Item .env.example .env
   ```

   At minimum: `SESSION_SECRET`, `POSTGRES_PASSWORD` (and the same password in `DATABASE_URL`), `GITHUB_ORG`, `GITHUB_SIGNIN_TEAM`, `GITHUB_AI_TEAM`, `MAIN_ADMIN_GITHUB_LOGIN`, and a `SMEE_URL` from [smee.io/new](https://smee.io/new).

2. Start everything:

   ```powershell
   docker compose up -d --build
   ```

3. Open http://localhost:3000/setup and follow the steps. You need to be an owner of the GitHub org. The setup page registers the Pitch In GitHub App on the org, then shows six `GITHUB_APP_` lines to paste into `.env`. Run `docker compose up -d` again so the containers pick them up, then install the App on the org.

4. Sign in. Members of the sign-in team get in; everyone else is turned away. The first time `MAIN_ADMIN_GITHUB_LOGIN` signs in, they become the main admin.

Logs: `docker compose logs -f web worker relay`.

## Development

Needs Node 24.

| Command | What it does |
| --- | --- |
| `npm test` | All tests (Vitest). Database tests use PGlite, an in-memory Postgres, so Docker isn't needed |
| `npx vitest run tests/permissions.test.ts` | One test file. Add `-t "blocking"` to run matching tests only |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run build` | Production build of the web app, then bundles the worker, migrate and relay scripts into `dist/` |
| `npm run dev` | Web app with hot reload. Start Postgres first with `docker compose up -d db` |
| `npm run worker` | Worker outside Docker |
| `npm run db:generate` | Writes a new SQL migration in `drizzle/` after you change `src/lib/db/schema.ts` |
| `npm run db:migrate` | Applies migrations to `DATABASE_URL` |

## How it fits together

| Part | Where |
| --- | --- |
| Data model (all tables from the plan) | `src/lib/db/schema.ts`, migrations in `drizzle/` |
| Permission rules (pure functions) | `src/lib/permissions.ts` |
| Sign-in: team check, block list, main admin seeding | `src/lib/auth/signin.ts` |
| Session cookie (signed, 12 hours, user re-loaded on every request) | `src/lib/auth/session.ts`, `src/lib/auth/current-user.ts` |
| Admin actions: block, unblock, hand over, profile changes | `src/lib/admin.ts`, `src/app/actions.ts` |
| GitHub App manifest flow | `src/lib/github/manifest.ts`, `src/app/setup/` |
| Webhook receiver: checks the signature, queues a job | `src/lib/github/webhook.ts`, `src/app/api/github/webhooks/route.ts` |
| Job queue in Postgres (`FOR UPDATE SKIP LOCKED`) | `src/lib/jobs.ts` |
| Worker | `src/worker/` |
| smee relay | `src/scripts/relay.ts` |

Roles come from GitHub. Org owners are admins. Posting and reviewing (from Milestone 2) need write access to the repo. The site only adds a main admin and a block list, and every role change, block and admin action is written to `audit_log`.

Sign-in uses the Pitch In GitHub App's own OAuth credentials, so there's one registration to manage. Team membership is checked with the App's installation token, which is why the App must be installed on the org before anyone can sign in.

## License

MIT, see [LICENSE](LICENSE).
