# Pitch In: Build Plan

Internal tool for one company. AI-team members post small wishlist tasks from company repos. Any coworker can pick one up, start it in their own Claude session, and their agent opens a PR for the task owner to review. Most people barely use their weekly Claude usage, so this puts it to work on tasks the AI team never gets to, and the company gets more out of the seats it already pays for.

The pitch is "pick up a coworker's wishlist task", not token sharing.

Working name: Pitch In (check for clashes before any public version). The folder stays `ShareAt0ken` for now.

## Constraints

- **No upfront costs.** The trial runs locally or on free tiers only. Anything that costs money goes on the [pitch list](#pitch-list-paid-upgrades-after-the-trial) for after the trial.
- **One install per company.** No multi-company support.
- **People start every run.** The site never stores Claude tokens and never starts a run on anyone's account. A person always presses start in their own session.
- **The site never runs contributor code.** Checks only read diffs through the GitHub API.

## Decisions

| Topic | Choice |
| --- | --- |
| Audience | One company per install. Only members of one named GitHub team can sign in |
| Who posts tasks | AI-team members (a GitHub team called `ai-team`) |
| Who picks up tasks | Anyone signed in, with a Developer or Guided profile |
| Who does the work | The contributor's own agent, in their own Claude session, on their own seat |
| Rewards | None. A "helped ship" list on profiles and a monthly report for the admin |
| Task sizing | Three tiers by effort: Small, Medium and Open-ended. Small and Medium have line caps; Open-ended has none and runs in checkpoints. Tasks can be code, docs, plans or whole milestones |
| Agents | Any agent that can work in a repo. "Start in Claude" opens Claude Code on the web with the task filled in; "Copy brief" works for anything else |
| Platform | GitHub.com, through a GitHub App each company registers itself. The site never hosts code |
| Merging | Always on GitHub, never from the site |
| Permissions | Taken from GitHub, plus a main admin and a block list |
| Running it | Docker Compose (web app, worker, Postgres). The company trial runs on a free machine picked with IT |
| This project's code | Public repo, MIT license |
| Public version | Parked. A separate product, not part of this build |

## Profiles

At first sign-in the site asks **"Are you on the AI team?"** Members of the `ai-team` GitHub team get it pre-answered as yes.

| Profile | Answer | What they get |
| --- | --- | --- |
| Developer | Yes | The full brief, "Start in Claude", "Copy brief" for other agents |
| Guided | No | A step-by-step walkthrough and "Start in Claude". The walkthrough never mentions merging; it ends with "the owner takes it from here" |

Every task is open to both profiles. The profile only changes how much guidance a person gets, not which tasks they can take. Once started, the agent works on its own and the automatic checks must pass before the PR reaches the owner, so a guided user never has to judge the code. Anyone can switch profile later, and admins can change it.

The answer only sets the guidance level. Posting tasks needs membership in the `ai-team` GitHub team, whatever someone answers.

## Core flow

1. The company does the one-time [setup checklist](#company-setup-checklist).
2. An AI-team member connects a repo (it must have CI with tests) and commits a `PROJECT_BRIEF.md`.
3. An AI-team member posts a task with a Task Brief, a tier and allowed paths. The brief checker runs.
4. A coworker filters the board by tier and adopts a task (48-hour lock).
5. They click **Start in Claude**. Claude Code on the web opens with the repo and prompt filled in. They press Enter and wait. Claude Code on the web opens the PR itself, as a **draft** (the prototype saw this; there was no Create PR step to click). They come back to the site and click **Check for my PR**. Developers can instead copy the brief into any agent.
6. The PR body starts with `Task: <task id>` so the site links it. In the prototype the PR kept that first line and all six template sections, so the paste-the-link fallback is kept but was not needed. The PR is authored by the contributor's own GitHub account, which is what "only the adopter's PR links" relies on (the account Claude is connected to must match the username they signed in with). If it doesn't link, the contributor pastes the PR link into the task page.
7. The GitHub App runs five automatic checks.
8. The owner reviews on the review page, then merges on GitHub, requests changes, or rejects.

## Roles and permissions

| Role | Who | Can |
| --- | --- | --- |
| Main admin | One person. Set by `MAIN_ADMIN_GITHUB_LOGIN` on first start, handed over in the admin screen after that | Everything admins can do, plus hand over the main admin role |
| Admin | Owners of the company's GitHub org | Connect or remove repos, change repo settings, close any task, release stuck adoptions, block and unblock users |
| AI team | Members of the `ai-team` GitHub team who have write access to the repo | Post tasks on that repo, review PRs on their own tasks |
| Member | Members of the sign-in team (e.g. `wishlist-users`) | Adopt tasks |
| Blocked | Set by an admin | Nothing |

Per-repo settings (admins): largest tier allowed, off-limits paths, files the size cap ignores (lockfiles, generated files).

Rules:
- Sign-in is GitHub OAuth, limited to members of the configured GitHub team. Team membership is re-checked at every sign-in, so people who leave lose access.
- Posting and reviewing follow GitHub: you need `ai-team` membership and write access to that repo. The site never grants more power than GitHub does.
- Only the task owner or a repo admin should merge. Anything else sets off the [unreviewed-merge alert](#unreviewed-merge-alert).
- Every role change, block and admin action goes into `audit_log` with actor and time.

## Usage tiers

Tasks are not only code. A task can be a bug fix, a feature, a design note, a project plan, or a whole milestone. Tiers describe how much of someone's usage the work takes, not what kind of work it is.

| Tier | Typical work | Line cap (code and docs in the PR) | Rough effort |
| --- | --- | --- | --- |
| Small | A bug, a small addition, a short doc | 300 lines (proposed) | A quick run |
| Medium | A contained feature, a design note, a handful of files | 1,000 lines (proposed) | A solid chunk of one session |
| Open-ended | A milestone, a project plan, a large piece of work | None | As much usage as the person is willing to put in, up to a whole week's |

The cap numbers are placeholders. The prototype only tested 100 and found them tiny; calibrate with `usage_note` data.

The owner picks the tier when posting. After each PR the contributor can note roughly how much usage it took (`usage_note`), so tiers can be calibrated later.

The size cap counts lines added plus lines removed. It skips lockfiles and the generated files listed in repo settings. Tests count. Open-ended tasks have no size cap; they are controlled with checkpoints instead (below).

### Open-ended tasks: milestones with stops

- The brief lists checkpoints: ordered, each with its own acceptance criteria.
- The agent finishes one checkpoint, opens a PR for it (first line `Task: <id>`, plus `Checkpoint: <n>`), and the owner reviews it before the next one starts.
- Each checkpoint PR is held to the usual checks except size. Scope, secrets, CI and template all apply, and the scope is the brief's allowed paths.
- The adoption lock is renewed for 48 hours each time a checkpoint PR is opened or merged. The task closes when the owner marks it done or the last checkpoint merges.
- Nothing large lands unreviewed: the caps used to guard against that, and the checkpoints now do.

## Brief guideline

Every task ships with a brief written so an agent with no prior knowledge of the repo can finish it in one pass. Two layers:

- **Project Brief:** `PROJECT_BRIEF.md`, committed once per repo. The site reads it when the repo is connected and refreshes it on every push to the default branch.
- **Task Brief:** written on the site, per task.

### How the brief reaches the agent

- **Start in Claude:** the task page builds a link to Claude Code on the web: `https://claude.ai/code?prompt=<url-encoded prompt>&repositories=<owner>/<repo>`. Nothing is sent until the person presses Enter. The prompt stays short (the prototype's links ran about 3,200 to 3,600 characters and worked; `prompt_url` is the fallback if a longer brief breaks):  the Task Brief, "read PROJECT_BRIEF.md first" (it's already in the repo), the off-limits paths from repo settings, and "open the PR with the template below, starting with `Task: <task id>`".
- **Copy brief:** copies the same text, plus a .md download, for any other agent.
- There are no personal access tokens in the MVP. Those come back with the MCP server (see Later).

### Project Brief (once per repo, `PROJECT_BRIEF.md`)

Required fields: what the project does (2 to 3 sentences), stack and versions, setup and test commands (exact, copy-paste), repo map (key folders, one line each), conventions (naming, formatting, errors, commit style), definition of done.

Off-limits paths live only in repo settings. The checks enforce that list, and the site adds it to every brief automatically, so `PROJECT_BRIEF.md` doesn't repeat it.

### Task Brief (per task)

| Field | Required | Notes |
| --- | --- | --- |
| Goal | Yes | One sentence, the outcome not the method |
| Files to look at | Yes | Exact paths, five at most |
| Allowed paths | Yes | Glob patterns the PR may touch, e.g. `src/upload/**`, `tests/**`. Prefilled from the folders of the files above |
| Current vs expected behaviour | Bugs | Include reproduction steps |
| Acceptance criteria | Yes | Checklist of yes/no items the reviewer ticks |
| Test command | Code tasks | One command that proves it is done. For docs or planning tasks, the repo's lint command, or "none" |
| Checkpoints | Open-ended | Ordered list of stops, each with its own acceptance criteria. The agent opens one PR per checkpoint |
| Constraints | Yes | e.g. no new dependencies, keep public API |
| Size tier | Yes | Small, Medium or Open-ended; sets the line cap (none for Open-ended) |
| Out of scope | Optional | Related work the agent must not take on |
| Example input and output | Optional | One concrete case |

Writing rules: name exact files, functions and commands; acceptance criteria a reviewer can tick in seconds; under about 500 words (longer means two tasks); never include secrets, `.env` values, customer data or private URLs (ship `.env.example`); facts and requirements only, never instructions to run commands outside the repo's own test and setup commands.

The brief checker (no AI needed) flags: missing required fields, paths that don't exist in the repo, allowed-path patterns that match nothing, briefs over the word limit, anything that looks like a secret, and commands or links outside the repo.

Task Brief template:

```markdown
# Task: <short title>

**Goal:** <one sentence on the outcome>

**Files to look at:**
- src/upload.py (validate_file)
- tests/test_upload.py

**Allowed paths:** src/upload.py, tests/**

**Current behaviour:** <what happens now>
**Expected behaviour:** <what should happen>

**Acceptance criteria:**
- [ ] Empty files are rejected with a 400 error
- [ ] A new test covers the empty-file case
- [ ] All existing tests pass

**Test command:** `pytest tests/test_upload.py`

**Constraints:** no new dependencies; do not change the public API
**Size tier:** Medium
**Size cap:** 1,000 lines changed
**Out of scope:** file-size limits (separate task)
```

## Adoption and task lifecycle

- Adopting locks a task for **48 hours**. The lock holds while a linked PR is open. The owner or an admin can release it early.
- Lock expiry is computed when the task is read (`expires_at < now()` means it's free again), so there is no expiry job.
- Only PRs authored by the current adopter get linked. Anyone else's PR gets a failing check that says "adopt this task first".
- After "Request changes", the adopter has **72 hours** to push a fix. Otherwise the PR is closed and the task reopens.

Task statuses: `open` -> `adopted` -> `in_review` -> `changes_requested` -> `in_review` -> `merged`. A task goes back to `open` on reject, lock expiry, or a missed fix window. It becomes `closed` when the owner withdraws it.

## Review-friendly PRs

A PR only reaches the owner's review page when it is small, tied to one task, and passes the checks. PRs with failing checks show on the task page for the contributor, not on the review page.

PR rules:
- One task, one PR. Body starts with `Task: <task id>` so the site links it.
- Stay under the tier's size cap (Open-ended tasks have none; each checkpoint is its own PR).
- Touch only the brief's allowed paths. No unrelated reformatting or renaming.
- All CI checks pass before it shows up for review.
- State which agent and model wrote it.
- Branches only, no forks.
- Draft PRs are fine: the checks run on them. The owner's first step on a draft is **Ready for review**, because GitHub won't merge a draft.

Required PR template:

```markdown
Task: <task id>

## Summary
- <what changed, three bullets at most>

## Files changed
- src/upload.py: reject empty files in validate_file()
- tests/test_upload.py: add empty-file test

## Acceptance criteria
- [x] Empty files are rejected with a 400 error
- [x] A new test covers the empty-file case
- [x] All existing tests pass

## How it was tested
`pytest tests/test_upload.py` -> 14 passed

## Risks or notes
<anything the reviewer should look at closely>

## Agent
<agent and model used>
```

Automatic checks (one GitHub check run per linked PR; they only read the diff, the site never runs contributor code):

| Check | Fails when |
| --- | --- |
| Template | A required section is missing or empty |
| Size | Lines changed exceed the tier's cap (see the counting rules under Usage tiers). Skipped for Open-ended tasks |
| Scope | Files outside the brief's allowed paths, or any off-limits file, changed |
| Secrets | A key, token or password pattern appears in the diff (gitleaks) |
| CI | The repo's own tests or linter fail. The site's own check run is ignored here |

A repo without CI can't be connected at all.

### Review page

One page per PR: a plain-language "what to check" taken from the PR's Summary and Risks sections, acceptance criteria next to the contributor's evidence, check results, scope warning if any, diff size. A draft shows a "mark Ready for review on GitHub first" note. Three actions:

- **Open on GitHub to merge:** merging happens on GitHub. When GitHub reports the merge, the task closes and the contributor gets a "helped ship" entry.
- **Request changes:** the App posts a structured GitHub comment (criterion, problem, expected fix) that the contributor's agent can read and act on.
  - **Guided users get one round of fixes.** They get a **Continue in Claude** button with the PR link and the reviewer's comments filled in. If the second try still isn't right, the PR closes and the task goes back on the board, marked for developers. Unconfirmed: whether a new web session can pick up the existing PR's branch. If it can't, the fix arrives as a new PR that replaces the old one.
- **Reject:** the App closes the PR with a reason and the task reopens for others.

### Unreviewed-merge alert

Free GitHub orgs can't protect branches on private repos, so anyone with push access could merge their own PR. Until the company upgrades:
- The site watches every merge and every push to the default branch.
- If a PR is merged by anyone other than the task owner or a repo admin (admin status comes from GitHub's collaborator permission API, so legitimate merges don't set off the alert), or the default branch changes without an owner-merged PR, the admin page shows an alert, the task page shows a warning, and an `alerts` row and an `audit_log` row are written.

## Architecture and stack

| Part | Choice | Why |
| --- | --- | --- |
| Frontend and API | Next.js + TypeScript | One codebase |
| Database | PostgreSQL in a Docker container | Tasks, adoptions and PRs are relational; free and local |
| Login | GitHub OAuth, limited to one GitHub team | Matches repo permissions |
| GitHub integration | GitHub App using Octokit, registered by each company through GitHub's manifest flow | The company holds its own App keys |
| Background jobs | Job table in Postgres, polled by a worker container | Checks run outside web requests, no extra service |
| Secret scanning | gitleaks binary inside the worker image | Proven and free |
| Packaging | One Docker image (web app + worker + gitleaks) plus Postgres, run with `docker compose` | The same image can later run on a company server or cloud account without code changes |
| Webhooks without a public address | smee.io relay, in development and during the trial | GitHub can reach a machine that has no public address |
| Config | Environment variables, with a `.env.example` of fake values | No code changes between machines |

Hosting:
- **Now:** everything runs locally with `docker compose`. No paid services or hosted dependencies.
- **Company trial:** a free machine picked with the company's IT (a spare office computer, or my laptop if IT agrees). Coworkers open it in a browser on the office network.
- Don't pick a host or write deployment config for one yet.

**smee trade-off:** anyone with the channel URL can see what passes through it: PR titles and descriptions, file names and commit messages, but not the code itself. That's acceptable for a trial on low-stakes repos. Direct webhooks on a real host are on the pitch list.

GitHub App permissions: read contents, metadata, commit statuses and organization members; read and write pull requests (comments, closing); write checks. Listen for `installation`, `pull_request`, `check_suite` and `push` events.

```
Coworkers -> Web app (Next.js) <-> PostgreSQL
Coworker clicks Start in Claude -> Claude Code on the web (their own seat) -> opens PR on GitHub
GitHub -> webhooks -> smee relay -> web app
Worker reads diffs from GitHub, runs checks, posts the check run, saves results to PostgreSQL
Owner merges on GitHub -> webhook -> task closes
```

### Data model

| Table | Key fields |
| --- | --- |
| users | github_id, handle, profile (developer or guided), is_main_admin, blocked, membership_checked_at |
| repos | github_repo_id, installation_id, project_brief, has_ci, settings (largest tier, off-limits paths, size-cap ignore list) |
| tasks | repo_id, owner_id, title, brief_md, size_tier, allowed_paths, status |
| adoptions | task_id, user_id, expires_at, status (active, released, expired, completed) |
| submissions | task_id, pr_number, head_sha, author_id, check_results, usage_note, fix_round, status |
| reviews | submission_id, decision, comments |
| jobs | type, payload, status, attempts, run_after |
| alerts | repo_id, kind (unreviewed_merge or direct_push), details, created_at, resolved_at |
| audit_log | actor_id, action, target, created_at |

## Company setup checklist

The app ships this as a setup page. For the trial, everything here is free.

1. Someone at the company creates a free GitHub org and is its owner. I'm added as an admin for setup and step back afterwards.
2. Create two GitHub teams: the sign-in team (e.g. `wishlist-users`, everyone in the trial) and `ai-team`.
3. Every trial user gets a GitHub account, joins the sign-in team, and gets write access to the trial repos. AI-team members also join `ai-team`.
4. Move two or three low-stakes repos into the org. Add a basic test setup, CI (GitHub Actions) and a `PROJECT_BRIEF.md`. These can be the first wishlist tasks, done by developers.
5. Install Claude's GitHub App on the org.
6. A Claude Team Owner turns on the GitHub connector and allows Claude Code on the web (remote sessions) in Claude's admin settings.
7. Each user connects their GitHub account in Claude.
8. Pick the trial machine with IT, fill in `.env`, run `docker compose up`.
9. Create the smee channel and register the Pitch In GitHub App through the setup page (GitHub's manifest flow), then install it on the trial repos.

## Build milestones

Work through these in order. Finish each one (tests passing) before starting the next. No week estimates: this is a side project, and the company's setup timing isn't in my control.

### Milestone 1: Foundation
- `docker compose` with the Next.js + TypeScript web app, the worker and Postgres; `.env.example`; migrations for the data model.
- GitHub OAuth limited to the configured GitHub team, re-checked at each sign-in.
- Main admin from `MAIN_ADMIN_GITHUB_LOGIN`; the "Are you on the AI team?" question; block list; audit log.
- Register the GitHub App through the manifest flow and receive webhooks via smee.
- Done when: a team member can sign in, an outsider can't, a block by the main admin shows up in `audit_log`, and a webhook from GitHub reaches the local app.

### Milestone 2: Tasks and briefs
- Connect a repo through the GitHub App (refused without CI); read and refresh `PROJECT_BRIEF.md`.
- Task form with the brief template, allowed paths, usage tier and the brief checker.
- Wishlist board with tier filters.
- Adopting with the 48-hour lock (computed on read).
- "Start in Claude" link, "Copy brief", and the guided walkthrough.
- Done when: an AI-team member posts a task, a different member adopts it, a second adoption is blocked, the lock lapses at 48 hours (tested with a fake clock), and "Start in Claude" opens a session with the repo and brief filled in.

### Milestone 3: Checks and review
- Link PRs from the `Task: <id>` line, with the paste-the-link fallback; only the adopter's PRs link.
- The five checks posted as one GitHub check run.
- Review page; request changes and reject as GitHub comments; the task closes when GitHub reports the merge.
- The 72-hour fix window; one fix round with "Continue in Claude" for guided users.
- Unreviewed-merge alert.
- Done when: an oversized PR is flagged, a clean one reaches the review page, merging on GitHub closes the task, and a merge by the wrong person sets off the alert.

### Milestone 4: Demo-org trial
- A free GitHub org I own, with public sample repos and sample tasks (clearly labeled as sample data). Public repos get branch protection for free.
- Individual testers use it as both Developer and Guided users.
- "Helped ship" list on profiles; monthly admin report (tasks done for others, by tier, with contributors' usage notes).
- Done when: at least one Developer PR and one Guided PR are merged end to end.

### Milestone 5: Company trial
- The setup checklist page, then the company's free org with two or three repos.
- Run for four weeks against the success targets below.

## Trial success targets

These are targets to aim for, not predictions. Over four weeks of the company trial:
- At least 5 wishlist tasks merged, including at least 2 from Guided users.
- Owners' median review time under 15 minutes per PR.
- Fewer than half of PRs rejected, tracked separately for Developer and Guided PRs.
- The AI team says they'd keep using it.

Hitting them is the case for the pitch list.

## Pitch list (paid upgrades after the trial)

- **GitHub Team**, so the default branch is protected on private repos and only reviewed PRs can merge. Every member, guided users included, becomes a paid GitHub seat.
- **A real host with a public address**, so GitHub's webhooks go straight to the app instead of through smee.

## Later (not in the MVP)

- MCP server so agents can adopt and submit directly (brings back per-user access tokens).
- Weekly reminder of open wishlist tasks (Slack or email).
- Tier calibration from logged `usage_note` data.
- A "suggest a wishlist idea" box for people outside the AI team.
- Support for forks.
- The public version, where people trade usage for credits. Parked. Check Anthropic's terms before any work on it: trading usage between strangers looks hard to fit with per-seat rules.

## Risks

| Risk | Mitigation |
| --- | --- |
| Anthropic's per-seat rules. Team seats belong to one person, limits can't be moved between people, and "Users can't route their work through another user's account" | The pitch is "pick up a coworker's task". Every run is started by the person in their own session. The site never stores Claude tokens or starts runs. The company, as Anthropic's customer, decides whether to ask Anthropic |
| The company moves to pay-per-use Enterprise billing | There'd be no leftover usage: a guided user's run would cost the same as the AI team's. Revisit the pitch if that happens |
| No branch protection on a free GitHub org | Unreviewed-merge alert, a guided walkthrough that never shows merging, low-stakes repos, GitHub Team on the pitch list |
| The smee relay exposes webhook contents | Unguessable channel URL, low-stakes repos, direct webhooks on the pitch list |
| Low-quality PRs waste reviewers' time | Tier caps, CI required, PR template, failing PRs kept off the review page, one fix round for guided users, admins can block |
| Guided users can't judge the code, and the owner may not be able to either (the prototype review took 30 seconds on code the reviewer couldn't read) | Checks gate every PR, the owner reviews, the review page leads with a plain-language "what to check", and rejections are tracked by profile |
| Secrets leaking through briefs or PRs | Secret scanning on both; `.env.example` instead of real values |
| Prompt injection in a brief aimed at contributors' agents | Only AI-team members post; the brief checker flags commands and links outside the repo |
| Two people adopting the same task | 48-hour adoption lock |
| Nobody picks up tasks | "Helped ship" list, monthly report to the admin; the trial measures it |
| Main admin leaves the company | The role is handed over in the admin screen; GitHub org owners are admins too |

## Open items (to settle with the company)

- [ ] Who at the company owns the GitHub org and becomes main admin?
- [ ] Which two or three repos go first?
- [ ] Which machine runs the trial (decided with IT)?
- [ ] Are trial users mostly on the same office network? If most work remotely, the trial needs a free tunnel instead.

## Notes for Claude Code

- Keep it minimal: one Next.js app, one worker, Postgres, all in `docker compose`. No paid services, no hosted dependencies, no multi-company support, no deployment config.
- Never run contributor code on the site's machine. Checks only read diffs through the GitHub API.
- Never store Claude tokens and never start agent runs. The site only builds links that a person opens.
- Write tests first for the brief checker, the five PR checks, the adoption lock (with a fake clock), the permission rules, the PR linking rules and the unreviewed-merge alert. Those are the core of the product.
- Never commit secrets. Provide `.env.example` with fake values for the GitHub App credentials, OAuth secrets, database URL, smee URL, `MAIN_ADMIN_GITHUB_LOGIN` and the team names.

## First prompt to give Claude Code

> Read plan.md. Start Milestone 1 only. Set up docker compose with the Next.js + TypeScript web app, the worker and Postgres, plus migrations for the data model. Add GitHub OAuth limited to the configured GitHub team, the main admin from `MAIN_ADMIN_GITHUB_LOGIN`, the "Are you on the AI team?" question, the block list and the audit log. Register the GitHub App through the manifest flow and receive webhooks via smee. Add tests for the permission rules. Stop when Milestone 1's "Done when" is met and summarize what you built.

## Sources

Checked 2026-11-23:
- Claude Code on the web, including pre-fill links: https://code.claude.com/docs/en/web-quickstart
- Team seat rules: https://support.claude.com/en/articles/12004354
- Team usage limits (per seat, weekly reset): https://support.claude.com/en/articles/9266767
- Claude Code included in every Team seat: https://support.claude.com/en/articles/11845131
- Enterprise usage-based billing: https://support.claude.com/en/articles/9797531
- Using Claude subscriptions in other tools: https://code.claude.com/docs/en/legal-and-compliance

Similar projects:
- Rainshare: https://www.everydev.ai/tools/rainshare (open-source focused)
- opub: https://dev.to/goodroot/introducing-open-public-opub-2hpf
- CleverCrow: https://frontpage-app.vercel.app/news/48621645

Older formatted plan (out of date since this rewrite): https://claude.ai/artifact/KsJQZQF2ksRtUbVzaYJACB

The pre-rewrite version of this plan is saved as `plan-v1.md`.
