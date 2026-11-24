# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Milestones 1 (foundation), 2 (projects, tasks and briefs) and 3 (plan import) are built; Milestone 4 (checks and review) is next, posted on the local board from `plan.md` as tasks PI-9 to PI-22 on `PromptIn-test/pitch-in`. **Pitch In** is an internal board where coworkers post the projects they build with AI (websites, games, apps, research, automation) as single tasks or projects with milestones, and any coworker takes on as much as they want, runs it in their own Claude session, and opens a PR for the owner to review. Every task ends as a PR in a company GitHub repo, code or not.

- `plan.md` is the source of truth: decisions, data model, checks, milestones, and the prompt for the next milestone.
- `plan-v1.md` is the pre-review version, kept locally for reference only and ignored by git (the repo is public). It is out of date (Vercel, 72-hour locks, token-sharing pitch); never build from it or commit it.
- A formatted copy of the plan lives at https://claude.ai/artifact/KsJQZQF2ksRtUbVzaYJACB. When `plan.md` changes in a way that affects it, mention that the doc is now stale.
- The repo is public at https://github.com/HakimGtat/pitch-in (branch `main`). Commits use this repo's local identity `HakimGtat <71414445+HakimGtat@users.noreply.github.com>`.
- `PromptIn-test/pitch-in` is a public test copy of this repo that the Pitch In App can see, connected on the local install so Pitch In's own work can be posted on it. It only gets new commits when they're pushed there on purpose.
- `AGENTS.md` is written by `next dev` (Next.js 16.4 agent rules). Next 16 differs from older versions: check `node_modules/next/dist/docs/` before using an API you are unsure of.

Build one milestone at a time, in the order `plan.md` lists them, and stop when that milestone's "Done when" is met.

## Commands

- Run everything: `docker compose up -d --build` (needs `.env`, copied from `.env.example`), then http://localhost:3000/setup
- All tests: `npm test` (Vitest; database tests use PGlite in memory, no Docker needed)
- One file: `npx vitest run tests/signin.test.ts`; one test: add `-t "name substring"`
- Typecheck and lint: `npm run typecheck`, `npm run lint`
- Build: `npm run build` (Next.js standalone build, then esbuild bundles `dist/worker.mjs`, `dist/migrate.mjs`, `dist/relay.mjs`)
- After changing `src/lib/db/schema.ts`: `npm run db:generate` writes a new SQL migration in `drizzle/`. Never edit applied migrations.
- Docker isn't on the Bash tool's PATH on this machine. Run `docker` from PowerShell after refreshing PATH from the Machine and User environment variables.
- Lockfile gotcha: npm 11.6 on Windows drops the optional `node_modules/@emnapi/runtime` entry whenever it rewrites `package-lock.json`, and then `npm ci` in the Docker build fails ("Missing: @emnapi/runtime from lock file"). Fix: copy `package.json` into an empty folder, run `npm install --package-lock-only --ignore-scripts` there, and copy the fresh lockfile back without running `npm install` in the project afterwards.

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
- **Permissions come from GitHub.** Sign-in is limited to one configured GitHub team; posting and reviewing need write access to the repo (checked fresh each time). `ai-team` membership only pre-picks the Developer profile. The only site-side controls are the main admin (seeded from `MAIN_ADMIN_GITHUB_LOGIN`) and a block list. The site never grants more than GitHub does.
- **All config is environment variables** with a `.env.example` of fake values.
- **Wording:** the product is "Pitch In" and the pitch is "pick up part of a coworker's project". Contributors "take on" work; never say donate, share or transfer usage, and don't use token-sharing language in UI copy or docs.

## Architecture (planned)

One Docker image (Next.js + TypeScript web app, a worker, the smee relay, and the gitleaks binary from Milestone 4) plus Postgres, run with `docker compose`.

- **Web app:** board (projects, milestones and tasks, filtered by how much the person wants to take on), task and project forms with the brief checker, plan import (Milestone 3), the review packet with Review in Claude, admin screen, GitHub OAuth sign-in, and the GitHub App webhook receiver.
- **Worker:** polls a `jobs` table in Postgres (no extra queue service), fetches PR diffs, runs the seven checks (template, size, scope, secrets via gitleaks, CI status, criteria, evidence) as plain code with no AI, and posts one GitHub check run per linked PR.
- **GitHub App:** each company registers its own through GitHub's manifest flow. Webhooks reach a machine with no public address through a smee.io relay, in development and during the trial.

Behaviour that spans several parts of the code:

- **Adoption lock** (48 hours) is computed on read from `expires_at`. There is no expiry job. Adopting a whole milestone locks its open tasks; the lock renews on each of the adopter's PRs, and they can hand back any time none of their PRs is open.
- **A contributor's part ends at the PR.** Once someone takes a job and starts the run, nothing asks them for anything again: no questions to answer, no fix rounds, no re-runs after failed checks. Planning settles questions up front; the owner (with their own agent or by hand) handles questions, small fixes, failed checks and reopening. Never add a step that needs the contributor to come back.
- **PR linking:** a PR links to a task through a `Task: <id>` first line in its body, or through a link the adopter or the task owner pastes. Only the current adopter's PR links; anyone else's gets a failing check. PRs that don't target the default branch are ignored (the owner's fix PRs into a contributor's branch).
- **Unreviewed-merge alert:** free GitHub orgs can't protect branches on private repos, so the site flags any merge not done by the task owner or a repo admin, and any push to the default branch that didn't come through an owner-merged PR.
- **Repos without CI can't be connected.** The CI check ignores the site's own check run.
- **Owner's usage comes first:** work runs at the cheapest layer that can do it (the site's free checks, then the contributor's agent, then the owner's agent on a prepared review packet). Contributor usage is never the thing to save: their prompts ask for thoroughness, full test runs and a second review pass. The owner reviews every PR with their own agent and fixes small problems in that same session rather than sending them back; nobody else reviews. Anything the site can work out for free never goes in a prompt or a PR body.
- **Questions for the owner:** only when a wrong guess would waste the run, the contributor's agent opens a draft PR with a comment starting `Question for owner:` and ends the run; it never waits. The site flags it from the `issue_comment` webhook, and the owner finishes the work or reopens the task with the answer in its brief. Agents never talk live.

Write tests first for the core rules: the brief checker, the seven PR checks, the review packet, plan import, the adoption lock (with an injectable clock), milestone adoption and hand-back, the "work that fits" filter, the permission rules, PR linking and the unreviewed-merge alert.
