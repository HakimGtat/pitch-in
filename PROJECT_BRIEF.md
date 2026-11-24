# Pitch In: Project Brief

## What it is

Pitch In is an internal board for one company. Coworkers post the projects they build with AI as single tasks or as projects with milestones, any coworker takes on as much as they want in their own Claude session, and every task ends as a PR the owner reviews. The site only builds links and reads GitHub; it never stores Claude tokens, starts agent runs, runs contributor code or merges.

## Built with

- Node 24, TypeScript 5, Next.js 16.4 (App Router, React 19.3), Tailwind CSS 4
- PostgreSQL 17 through Drizzle ORM 0.45; tests use PGlite (in-memory Postgres)
- Octokit for the GitHub App and OAuth; Vitest 5 for tests
- Docker Compose runs the web app, a worker, the smee webhook relay and Postgres

Next.js 16 differs from older versions. Check `node_modules/next/dist/docs/` before using an API you're unsure of.

## Setup and check commands

```sh
npm ci
npm test            # all tests; no Docker or database needed
npm run typecheck
npm run lint
```

One test file: `npx vitest run tests/brief.test.ts`. After changing `src/lib/db/schema.ts`, run `npm run db:generate` to write a new migration in `drizzle/`.

## Repo map

- `plan.md`: the source of truth for decisions, the data model, the checks and the milestones
- `src/lib/`: the core rules as plain functions (brief checker, plan import, prompts, adoption lock, permissions, sizing)
- `src/lib/db/`: the Drizzle schema and database client
- `src/lib/github/`: the GitHub App, OAuth and webhook code, behind small interfaces tests can fake
- `src/app/`: Next.js pages, routes and server actions; actions only read the form and call `src/lib`
- `src/components/`: React components shared by the pages
- `src/worker/`: the background worker that polls the `jobs` table
- `src/scripts/`: migrate, the smee relay, and a sample-data helper
- `tests/`: Vitest tests, one file per area; `tests/helpers/` has the PGlite database and a fake GitHub
- `drizzle/`: SQL migrations (never edit one that has been applied)

## Conventions

- Core rules are pure functions, or take a `Db` and an injectable `now`, so tests need no Docker or real clock. GitHub calls go through small interfaces that tests fake.
- Write tests first for core rules.
- Every role change, block and admin action writes `audit_log` (`src/lib/audit.ts`).
- Server actions that change roles, blocks or profiles call `revalidatePath("/", "layout")`.
- All config is environment variables, with fake values in `.env.example`. Never commit secrets.
- Product wording: contributors "take on" work; never say donate, share or transfer usage.
- UI copy is plain and short, in sentence case. Commits are short imperative sentences.

## Definition of done

`npm test`, `npm run typecheck` and `npm run lint` pass; new rules have tests; nothing outside the task's allowed paths changed; and the PR follows the template in its task's prompt.
