# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Milestone 1 (foundation) is built; Milestone 2 is next. **Pitch In** is an internal board where an AI team posts small wishlist tasks from company repos and any coworker picks one up, runs it in their own Claude session, and opens a PR for the task owner to review.

- `plan.md` is the source of truth: decisions, data model, checks, milestones, and the first prompt to start building.
- `plan-v1.md` is the pre-review version, kept for reference only. It is out of date (Vercel, 72-hour locks, token-sharing pitch); never build from it.
- A formatted copy of the plan lives at https://claude.ai/artifact/KsJQZQF2ksRtUbVzaYJACB. When `plan.md` changes in a way that affects it, mention that the doc is now stale.
- The folder is a local git repo with no remote yet.
- `AGENTS.md` is written by `next dev` (Next.js 16.4 agent rules). Next 16 differs from older versions: check `node_modules/next/dist/docs/` before using an API you are unsure of.

Build one milestone at a time, in the order `plan.md` lists them, and stop when that milestone's "Done when" is met.

## Commands

- Run everything: `docker compose up -d --build` (needs `.env`, copied from `.env.example`), then http://localhost:3000/setup
- All tests: `npm test` (Vitest; database tests use PGlite in memory, no Docker needed)
- One file: `npx vitest run tests/signin.test.ts`; one test: add `-t "name substring"`
- Typecheck and lint: `npm run typecheck`, `npm run lint`
- Build: `npm run build` (Next.js standalone build, then esbuild bundles `dist/worker.mjs`, `dist/migrate.mjs`, `dist/relay.mjs`)
- After changing `src/lib/db/schema.ts`: `npm run db:generate` writes a new SQL migration in `drizzle/`. Never edit applied migrations.

## Code conventions

- Core rules are pure functions or take a `Db` (works with node-postgres and PGlite) plus an injectable `now`, so tests run without Docker or a real clock. GitHub calls go through small interfaces (e.g. `SignInGitHub`) that tests fake.
- Next.js runs with Cache Components off and `dynamic = "force-dynamic"` in the root layout: every page reads the session.
- Server actions that change roles, blocks or profiles call `revalidatePath("/", "layout")` so the header updates.
- Every role change, block and admin action writes `audit_log` (`src/lib/audit.ts`).

## Hard rules (apply to every milestone)

- **No upfront costs.** Everything runs locally with `docker compose` (web app, worker, Postgres). No paid services, no hosted dependencies, no host or deployment config. Paid upgrades go on the plan's pitch list instead.
- **One install per company.** No multi-company or tenant support.
- **The site never stores Claude tokens and never starts agent runs.** It only builds "Start in Claude" links (`https://claude.ai/code?prompt=...&repositories=owner/repo`) that a person opens and runs in their own session.
- **The site never runs contributor code.** The worker only reads diffs through the GitHub API.
- **Merging happens on GitHub, never from the site.** The site learns about merges from webhooks.
- **Permissions come from GitHub.** Sign-in is limited to one configured GitHub team; posting and reviewing need `ai-team` membership plus write access to the repo. The only site-side controls are the main admin (seeded from `MAIN_ADMIN_GITHUB_LOGIN`) and a block list. The site never grants more than GitHub does.
- **All config is environment variables** with a `.env.example` of fake values.
- **Wording:** the product is "Pitch In" and the pitch is "pick up a coworker's wishlist task". Don't use token-sharing language in UI copy or docs.

## Architecture (planned)

One Docker image (Next.js + TypeScript web app, a worker, and the gitleaks binary) plus Postgres, run with `docker compose`.

- **Web app:** task board, task form with the brief checker, review page, admin screen, GitHub OAuth sign-in, and the GitHub App webhook receiver.
- **Worker:** polls a `jobs` table in Postgres (no extra queue service), fetches PR diffs, runs the five checks (template, size, scope, secrets via gitleaks, CI status), and posts one GitHub check run per linked PR.
- **GitHub App:** each company registers its own through GitHub's manifest flow. Webhooks reach a machine with no public address through a smee.io relay, in development and during the trial.

Behaviour that spans several parts of the code:

- **Adoption lock** (48 hours) is computed on read from `expires_at`. There is no expiry job.
- **PR linking:** a PR links to a task through a `Task: <id>` first line in its body, or through a link the contributor pastes. Only the current adopter's PR links; anyone else's gets a failing check.
- **Unreviewed-merge alert:** free GitHub orgs can't protect branches on private repos, so the site flags any merge not done by the task owner or a repo admin, and any push to the default branch that didn't come through an owner-merged PR.
- **Repos without CI can't be connected.** The CI check ignores the site's own check run.

Write tests first for the core rules: the brief checker, the five PR checks, the adoption lock (with an injectable clock), the permission rules, PR linking and the unreviewed-merge alert.
