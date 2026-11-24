# Pitch In

An internal board for the projects coworkers build with AI: websites, games, apps, research, automation. Owners post a single task or a project with milestones from a company repo. Any coworker takes on as much as they want, runs it in their own Claude session, and their agent opens a pull request for the owner to review.

One install per company. Everything runs locally with `docker compose`: the web app, a worker, a webhook relay and Postgres. The site never stores Claude tokens, never starts agent runs, never runs contributor code, and never merges. Merging happens on GitHub.

The full plan is in [plan.md](plan.md).

## Status

Milestones 1 (foundation) and 2 (projects, tasks and briefs) are built:

- `docker compose` with the Next.js web app, the worker, the smee webhook relay and Postgres, plus migrations for the data model
- GitHub sign-in limited to one GitHub team, re-checked at every sign-in
- Main admin seeded from `MAIN_ADMIN_GITHUB_LOGIN`, the welcome questions ("Have you worked with a coding agent like Claude Code before?" and "How much do you want to take on?"), the block list and the audit log
- GitHub App registration through GitHub's manifest flow, and webhooks received through smee
- Connecting a repo (repo admins only, refused without CI), with `PROJECT_BRIEF.md` read at connect and refreshed on every push to the default branch
- Posting a single task, or a project with ordered milestones and tasks, through a task form with the brief checker
- The board, filtered by how much each person wants to take on and grouped by project
- Adopting a task or a whole milestone with a 48-hour lock computed on read, handing back, and releasing
- Start in Claude (a pre-filled Claude Code on the web link), Copy brief, a `.md` download, and the Guided walkthrough

PR linking, the five checks, the review page and the unreviewed-merge alert come in Milestone 3.

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

5. Connect a repo under **Repos**. You need admin permission on it in GitHub, and it needs a CI workflow in `.github/workflows/`. The connect screen offers a Markdown-lint starter workflow for docs and research repos. Then anyone with write access to the repo can post work on it.

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
| `npx tsx --env-file=.env src/scripts/sample-adopt.ts --sample-data adopt <milestoneId>` | Live checks with one GitHub account: a sample user (sample data, not a real account) adopts a milestone. `hand-back` undoes it |

## How it fits together

| Part | Where |
| --- | --- |
| Data model (all tables from the plan) | `src/lib/db/schema.ts`, migrations in `drizzle/` |
| Permission rules (pure functions) | `src/lib/permissions.ts` |
| Brief checker (pure) | `src/lib/brief.ts`, globs in `src/lib/glob.ts` |
| Estimates, line caps and the "work that fits" filter | `src/lib/sizing.ts`, `src/lib/board-rules.ts` |
| Adoption lock and who can take on what (pure) | `src/lib/lock.ts`, `src/lib/adoption-rules.ts` |
| Adopting, handing back, releasing | `src/lib/adoption.ts` |
| Repos: connect, refresh, settings, remove | `src/lib/repos.ts`, GitHub calls in `src/lib/github/repos.ts` and `src/lib/github/app.ts` |
| Posting tasks and projects | `src/lib/work.ts`, forms in `src/components/task-form.tsx` and `src/components/project-form.tsx` |
| Read-time views (lock applied on read) | `src/lib/views.ts` |
| Start in Claude prompt, link and Guided steps | `src/lib/prompt.ts`, `src/lib/start.ts` |
| Pages and server actions | `src/app/`, `src/app/work-actions.ts` |
| Sign-in: team check, block list, main admin seeding | `src/lib/auth/signin.ts` |
| Session cookie (signed, 12 hours, user re-loaded on every request) | `src/lib/auth/session.ts`, `src/lib/auth/current-user.ts` |
| Admin actions: block, unblock, hand over, profile changes | `src/lib/admin.ts`, `src/app/actions.ts` |
| GitHub App manifest flow | `src/lib/github/manifest.ts`, `src/app/setup/` |
| Webhook receiver: checks the signature, queues a job | `src/lib/github/webhook.ts`, `src/app/api/github/webhooks/route.ts` |
| Job queue in Postgres (`FOR UPDATE SKIP LOCKED`) | `src/lib/jobs.ts` |
| Worker | `src/worker/` |
| smee relay | `src/scripts/relay.ts` |

Roles come from GitHub. Org owners are admins. Posting work needs write access to the repo, connecting it needs admin permission, both checked fresh on GitHub each time. `ai-team` membership only pre-picks the Developer profile. The site only adds a main admin and a block list, and every role change, block and admin action is written to `audit_log`.

Sign-in uses the Pitch In GitHub App's own OAuth credentials, so there's one registration to manage. Team membership is checked with the App's installation token, which is why the App must be installed on the org before anyone can sign in.

## License

MIT, see [LICENSE](LICENSE).
