# Pitch In: Build Plan

Internal tool for one company. Coworkers post the projects they're building with AI (websites, games, apps, research, automation) as a single task or as a project with milestones, from company repos. Any coworker can pick up as much as they want to take on, start it in their own Claude session, and their agent opens a PR for the owner to review. Most people barely use their weekly Claude usage, so this puts it to work on projects that would otherwise wait, and the company gets more out of the seats it already pays for.

The pitch is "pick up part of a coworker's project", not token sharing. Contributors choose how much work they take on; the site never frames that as donating or moving usage.

Working name: Pitch In (check for clashes before any public version). The folder stays `ShareAt0ken` for now.

**Status:** Milestone 1 is done (2026-11-23, verified live against a test org). This version widens Pitch In from coding tasks to any AI project, adds projects with milestones, and lets contributors choose how much they take on. Milestone 2 is next.

## Constraints

- **No upfront costs.** The trial runs locally or on free tiers only. Anything that costs money goes on the [pitch list](#pitch-list-paid-upgrades-after-the-trial) for after the trial.
- **One install per company.** No multi-company support.
- **People start every run.** The site never stores Claude tokens and never starts a run on anyone's account. A person always presses start in their own session.
- **The site never runs contributor code.** Checks only read diffs through the GitHub API.
- **Work lands in GitHub.** Every task ends as a PR in a company repo, code or not: research and design arrive as Markdown or files. Links to work outside GitHub come later.

## Decisions

| Topic | Choice |
| --- | --- |
| Audience | One company per install. Only members of one named GitHub team can sign in |
| What gets posted | Any company project people build with AI: websites, games, apps, research, automation. A single task, or a project with ordered milestones split into tasks |
| Who posts | Any signed-in coworker with write access to the project's repo |
| Who picks up work | Anyone signed in, with a Developer or Guided profile |
| Who does the work | The contributor's own agent, in their own Claude session, on their own seat |
| Sizing | Both sides. The owner estimates each task (Small, Medium, Large). The contributor chooses how much they want to take on (a quick run, a session, a big chunk), and the board shows work that fits |
| Deliverables | Always a PR in a GitHub repo. Non-code work is a Markdown report or files in the repo. Links (Google Docs, Figma, hosted demos) are on the Later list |
| Rewards | None. A "helped ship" list on profiles and a monthly report for the admin |
| Agents | Any agent that can work in a repo. "Start in Claude" opens Claude Code on the web with the task filled in; "Copy brief" works for anything else |
| Platform | GitHub.com, through a GitHub App each company registers itself. The site never hosts code |
| Merging | Always on GitHub, never from the site |
| Permissions | Taken from GitHub, plus a main admin and a block list |
| Running it | Docker Compose (web app, worker, Postgres). The company trial runs on a free machine picked with IT |
| This project's code | Public repo, MIT license |
| Public version | Parked. A separate product, not part of this build |

## Profiles

At first sign-in the site asks **"Have you worked with a coding agent like Claude Code before?"** Members of the `ai-team` GitHub team (if the company has one) get it pre-answered as yes.

| Profile | Answer | What they get |
| --- | --- | --- |
| Developer | Yes | The full brief, "Start in Claude", "Copy brief" for other agents |
| Guided | No | A step-by-step walkthrough and "Start in Claude". The walkthrough never mentions merging; it ends with "the owner takes it from here" |

Every task is open to both profiles. The profile only changes how much guidance a person gets, not which work they can take. Once started, the agent works on its own and the automatic checks must pass before the PR reaches the owner, so a guided user never has to judge the result. Anyone can switch profile later, and admins can change it.

The answer only sets the guidance level. Posting needs write access to the repo, whatever someone answers.

Each person also sets **"How much do you want to take on?"** on their profile (see [Sizing](#sizing)). It's a default for the board filter and can be changed any time.

> Milestone 1 shipped the question as "Are you on the AI team?". Milestone 2 rewords it.

## Core flow

1. The company does the one-time [setup checklist](#company-setup-checklist).
2. A coworker connects their project's repo (it must have CI) and commits a `PROJECT_BRIEF.md`.
3. The owner posts a single task, or a project with ordered milestones split into tasks. Each task has a Task Brief, an estimate and allowed paths. The brief checker runs.
4. A coworker picks how much they want to take on. The board shows work that fits, and they adopt one task or a whole milestone (48-hour lock).
5. They click **Start in Claude**. Claude Code on the web opens with the repo and prompt filled in. They press Enter and wait. Claude Code on the web opens the PR itself, as a **draft** (the prototype saw this; there was no Create PR step to click). They come back to the site and click **Check for my PR**. Developers can instead copy the brief into any agent.
6. The PR body starts with `Task: <task id>` so the site links it. In the prototype the PR kept that first line and all six template sections, so the paste-the-link fallback is kept but was not needed. The PR is authored by the contributor's own GitHub account, which is what "only the adopter's PR links" relies on (the account Claude is connected to must match the username they signed in with). If it doesn't link, the contributor pastes the PR link into the task page.
7. The GitHub App runs five automatic checks.
8. The owner reviews on the review page, then merges on GitHub, requests changes, or rejects.
9. On a milestone, the contributor moves on to its next task, or hands back after any merged PR. Whatever is left goes back on the board for someone else to continue.

## Roles and permissions

| Role | Who | Can |
| --- | --- | --- |
| Main admin | One person. Set by `MAIN_ADMIN_GITHUB_LOGIN` on first start, handed over in the admin screen after that | Everything admins can do, plus hand over the main admin role |
| Admin | Owners of the company's GitHub org | Remove repos, change any repo's settings, close any task or project, release stuck adoptions, block and unblock users |
| Repo admin | People with admin permission on that repo in GitHub | Connect the repo, change its settings |
| Owner | Members with write access to the repo | Post tasks and projects on that repo, review PRs on their own tasks |
| Member | Members of the sign-in team (e.g. `wishlist-users`) | Adopt tasks and milestones |
| Blocked | Set by an admin | Nothing |

Per-repo settings (repo admins and admins): largest estimate allowed, off-limits paths, files the size cap ignores (lockfiles, generated files).

Rules:
- Sign-in is GitHub OAuth, limited to members of the configured GitHub team. Team membership is re-checked at every sign-in, so people who leave lose access.
- Posting and reviewing follow GitHub: you need write access to that repo, checked fresh each time. The site never grants more power than GitHub does. (Milestone 1's rule also required `ai-team` membership; Milestone 2 drops that.)
- Only the task owner or a repo admin should merge. Anything else sets off the [unreviewed-merge alert](#unreviewed-merge-alert).
- Every role change, block and admin action goes into `audit_log` with actor and time.

## Sizing

Two sides, because the site can't see anyone's Claude usage: the owner estimates the work, and the contributor decides how much of it to take on.

### The owner's estimate (per task)

| Estimate | Typical work | Line cap (code and docs in the PR) | Rough effort |
| --- | --- | --- | --- |
| Small | A bug fix, a small addition, a short doc or research note | 300 lines (proposed) | A quick run |
| Medium | A contained feature, a page or screen, a design note, a research summary | 1,000 lines (proposed) | A solid chunk of one session |
| Large | A bigger feature, a full report, several connected files | 2,000 lines (proposed) | Most of a session or more |

Work bigger than Large is a project with milestones, split into tasks. Every PR keeps a cap, so nothing large lands unreviewed.

The cap numbers are placeholders. The prototype only tested 100 lines and found that tiny. After each PR the contributor can note roughly how much usage it took (`usage_note`), so caps and estimates can be calibrated.

The size cap counts lines added plus lines removed. It skips lockfiles and the generated files listed in repo settings. Tests count.

### The contributor's choice: "How much do you want to take on?"

| Choice | The board shows |
| --- | --- |
| A quick run | Small tasks |
| A session | Small and Medium tasks |
| A big chunk | Everything, including whole milestones |

It's set on the profile as a default and can be changed on the board any time. It's the contributor's own call; the site only uses it to filter. UI copy says "take on", never "donate" or "share usage".

## Projects and milestones

- A project lives in one connected repo. A repo can hold several projects and loose single tasks.
- A project has a title, a short goal, and ordered milestones. Each milestone has a goal and ordered tasks. Every task has its own brief, estimate and allowed paths, and ends in one PR.
- **Adopting a task:** as before, one task, one PR.
- **Adopting a whole milestone:** the contributor takes its open tasks in order. Each task gets its own Start in Claude run and its own PR, and the owner reviews it before the next one starts. The prompt for each run adds the project and milestone goals and a one-line note on what the earlier tasks in the milestone did.
- **Handing back:** after any merged PR, the contributor can stop. The milestone's remaining tasks go back on the board, and anyone can continue.
- **Locks:** a milestone adoption locks its open tasks for 48 hours, renewed each time one of the contributor's PRs is opened or merged.
- A milestone is done when all its tasks are merged. A project is done when its last milestone finishes or the owner marks it done.
- This replaces the earlier "Open-ended tier with checkpoints": a checkpoint is now just the next task in a milestone.

## Brief guideline

Every task ships with a brief written so an agent with no prior knowledge of the repo can finish it in one pass. Two layers, plus the project's goal when the task belongs to one:

- **Project Brief:** `PROJECT_BRIEF.md`, committed once per repo. The site reads it when the repo is connected and refreshes it on every push to the default branch.
- **Task Brief:** written on the site, per task.
- **Project and milestone goals:** written on the site when posting a project, added to every task's prompt.

### How the brief reaches the agent

- **Start in Claude:** the task page builds a link to Claude Code on the web: `https://claude.ai/code?prompt=<url-encoded prompt>&repositories=<owner>/<repo>`. Nothing is sent until the person presses Enter. The prompt stays short (the prototype's links ran about 3,200 to 3,600 characters and worked; `prompt_url` is the fallback if a longer brief breaks): the project and milestone goals if any, the Task Brief, "read PROJECT_BRIEF.md first" (it's already in the repo), the off-limits paths from repo settings, and "open the PR with the template below, starting with `Task: <task id>`".
- **Copy brief:** copies the same text, plus a .md download, for any other agent.
- There are no personal access tokens in the MVP. Those come back with the MCP server (see Later).

### Project Brief (once per repo, `PROJECT_BRIEF.md`)

Required fields: what the project is (2 to 3 sentences), what it's built with (stack and versions, or tools and sources for research), setup and check commands (exact, copy-paste: tests for code, a lint or link check for docs and research), repo map (key folders, one line each), conventions (naming, formatting, writing style, commit style), definition of done.

Off-limits paths live only in repo settings. The checks enforce that list, and the site adds it to every brief automatically, so `PROJECT_BRIEF.md` doesn't repeat it.

### Task Brief (per task)

| Field | Required | Notes |
| --- | --- | --- |
| Goal | Yes | One sentence, the outcome not the method |
| Files to look at | Yes | Exact paths, five at most. For brand-new work, the closest existing files or the folder it goes in |
| Output | Non-code tasks | The file to produce and its format, e.g. `research/pricing.md` with a comparison table and sources |
| Allowed paths | Yes | Glob patterns the PR may touch, e.g. `src/upload/**`, `tests/**`. Prefilled from the folders of the files above |
| Current vs expected behaviour | Bugs | Include reproduction steps |
| Acceptance criteria | Yes | Checklist of yes/no items the reviewer ticks |
| Test command | Code tasks | One command that proves it is done. For docs or research, the repo's lint or link-check command, or "none" |
| Constraints | Yes | e.g. no new dependencies, keep public API, cite every source |
| Estimate | Yes | Small, Medium or Large; sets the line cap |
| Out of scope | Optional | Related work the agent must not take on |
| Example input and output | Optional | One concrete case |

Writing rules: name exact files, functions and commands; acceptance criteria a reviewer can tick in seconds; under about 500 words (longer means two tasks); never include secrets, `.env` values, customer data or private URLs (ship `.env.example`); facts and requirements only, never instructions to run commands outside the repo's own test and setup commands.

The brief checker (no AI needed) flags: missing required fields, files to look at that don't exist in the repo, allowed-path patterns that match nothing (a warning only, since new work can create new folders), briefs over the word limit, anything that looks like a secret, and commands or links outside the repo.

Task Brief template (code):

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
**Estimate:** Medium
**Size cap:** 1,000 lines changed
**Out of scope:** file-size limits (separate task)
```

Task Brief template (research):

```markdown
# Task: <short title>

**Goal:** <one sentence on the question this answers>

**Files to look at:**
- research/README.md (format and citation style)

**Output:** research/<topic>.md with a summary, a comparison table and a source list

**Allowed paths:** research/**

**Acceptance criteria:**
- [ ] Covers <the options or questions named in the goal>
- [ ] Every claim in the table has a linked source
- [ ] Ends with a short recommendation

**Test command:** `npm run lint:md`

**Constraints:** public sources only; no customer data
**Estimate:** Small
**Size cap:** 300 lines changed
```

## Adoption and task lifecycle

- Adopting locks a task, or a milestone's open tasks, for **48 hours**. The lock holds while a linked PR is open and is renewed each time one of the adopter's PRs is opened or merged. The owner or an admin can release it early.
- Lock expiry is computed when the task is read (`expires_at < now()` means it's free again), so there is no expiry job.
- Only PRs authored by the current adopter get linked. Anyone else's PR gets a failing check that says "adopt this task first".
- After "Request changes", the adopter has **72 hours** to push a fix. Otherwise the PR is closed and the task reopens.
- On a milestone, the adopter can hand back after any merged PR; the remaining tasks reopen.

Task statuses: `open` -> `adopted` -> `in_review` -> `changes_requested` -> `in_review` -> `merged`. A task goes back to `open` on reject, lock expiry, a missed fix window, or a hand-back. It becomes `closed` when the owner withdraws it.

Milestone statuses: `open` -> `in_progress` (any task adopted or merged) -> `done` (all tasks merged). Project statuses: `open` -> `done` or `closed`.

## Review-friendly PRs

A PR only reaches the owner's review page when it is small, tied to one task, and passes the checks. PRs with failing checks show on the task page for the contributor, not on the review page.

PR rules:
- One task, one PR. Body starts with `Task: <task id>` so the site links it. A milestone is several tasks, so several PRs.
- Stay under the task's size cap.
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
| Size | Lines changed exceed the task's cap (see the counting rules under Sizing) |
| Scope | Files outside the brief's allowed paths, or any off-limits file, changed |
| Secrets | A key, token or password pattern appears in the diff (gitleaks) |
| CI | The repo's own checks fail (tests for code, a lint or link check for docs and research). The site's own check run is ignored here |

A repo without CI can't be connected at all. Docs and research repos need at least a Markdown lint or link-check workflow; the connect screen offers a copy-paste starter workflow for them.

### Review page

One page per PR: a plain-language "what to check" taken from the PR's Summary and Risks sections, acceptance criteria next to the contributor's evidence, check results, scope warning if any, diff size. A draft shows a "mark Ready for review on GitHub first" note. For non-code tasks, the page links straight to the rendered output file on GitHub. Three actions:

- **Open on GitHub to merge:** merging happens on GitHub. When GitHub reports the merge, the task closes, the milestone moves on, and the contributor gets a "helped ship" entry.
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
| Database | PostgreSQL in a Docker container | Projects, tasks, adoptions and PRs are relational; free and local |
| Login | GitHub OAuth through the Pitch In GitHub App, limited to one GitHub team | Matches repo permissions; one registration |
| GitHub integration | GitHub App using Octokit, registered by each company through GitHub's manifest flow | The company holds its own App keys |
| Background jobs | Job table in Postgres, polled by a worker container | Checks run outside web requests, no extra service |
| Secret scanning | gitleaks binary inside the worker image | Proven and free |
| Packaging | One Docker image (web app + worker + relay + gitleaks) plus Postgres, run with `docker compose` | The same image can later run on a company server or cloud account without code changes |
| Webhooks without a public address | smee.io relay, in development and during the trial | GitHub can reach a machine that has no public address |
| Config | Environment variables, with a `.env.example` of fake values | No code changes between machines |

Hosting:
- **Now:** everything runs locally with `docker compose`. No paid services or hosted dependencies.
- **Company trial:** a free machine picked with the company's IT (a spare office computer, or my laptop if IT agrees). Coworkers open it in a browser on the office network.
- Don't pick a host or write deployment config for one yet.

**smee trade-off:** anyone with the channel URL can see what passes through it: PR titles and descriptions, file names and commit messages, but not the code itself. smee doesn't keep events for a relay that's offline, so webhooks sent while the machine is off are missed (GitHub can redeliver them). That's acceptable for a trial on low-stakes repos. Direct webhooks on a real host are on the pitch list.

GitHub App permissions: read contents, metadata, commit statuses and organization members; read and write pull requests (comments, closing); write checks. Listen for `installation`, `pull_request`, `check_suite` and `push` events.

```
Coworkers -> Web app (Next.js) <-> PostgreSQL
Coworker clicks Start in Claude -> Claude Code on the web (their own seat) -> opens PR on GitHub
GitHub -> webhooks -> smee relay -> web app
Worker reads diffs from GitHub, runs checks, posts the check run, saves results to PostgreSQL
Owner merges on GitHub -> webhook -> task closes, milestone moves on
```

### Data model

Milestone 1 created users, repos, tasks, adoptions, submissions, reviews, jobs, alerts and audit_log. Milestone 2 adds projects and milestones and the new columns marked below.

| Table | Key fields |
| --- | --- |
| users | github_id, handle, profile (developer or guided), take_on (quick, session or big; new), is_main_admin, is_org_owner, in_ai_team, blocked, membership_checked_at |
| repos | github_repo_id, installation_id, project_brief, has_ci, settings (largest estimate, off-limits paths, size-cap ignore list) |
| projects (new) | repo_id, owner_id, title, goal, status (open, done, closed) |
| milestones (new) | project_id, position, title, goal, status (open, in_progress, done) |
| tasks | repo_id, project_id and milestone_id (new, optional), position (new), owner_id, title, brief_md, size_tier (small, medium, large), allowed_paths, status |
| adoptions | task_id, milestone_id (new, set for whole-milestone adoptions), user_id, expires_at, status (active, released, expired, completed) |
| submissions | task_id, pr_number, head_sha, author_id, check_results, usage_note, fix_round, status |
| reviews | submission_id, reviewer_id, decision, comments |
| jobs | type, payload, status, attempts, run_after, dedupe_key |
| alerts | repo_id, kind (unreviewed_merge or direct_push), details, created_at, resolved_at |
| audit_log | actor_id, action, target, details, created_at |

## Company setup checklist

The app ships this as a setup page. For the trial, everything here is free.

1. Someone at the company creates a free GitHub org and is its owner. I'm added as an admin for setup and step back afterwards.
2. Create the sign-in team (e.g. `wishlist-users`, everyone in the trial). Optionally create `ai-team`: its members get the Developer profile pre-picked.
3. Every trial user gets a GitHub account, joins the sign-in team, and gets write access to the trial repos (contributors push branches; forks aren't supported).
4. Move two or three low-stakes project repos into the org, ideally of different kinds (a small website or app, an automation script, a research repo). Add CI (tests for code, a Markdown lint or link check for docs and research) and a `PROJECT_BRIEF.md`. Setting these up can be the first tasks, done by developers.
5. Install Claude's GitHub App on the org.
6. A Claude Team Owner turns on the GitHub connector and allows Claude Code on the web (remote sessions) in Claude's admin settings.
7. Each user connects their GitHub account in Claude.
8. Pick the trial machine with IT, fill in `.env`, run `docker compose up`.
9. Create the smee channel and register the Pitch In GitHub App through the setup page (GitHub's manifest flow), then install it on the trial repos.

## Build milestones

Work through these in order. Finish each one (tests passing) before starting the next. No week estimates: this is a side project, and the company's setup timing isn't in my control.

### Milestone 1: Foundation (done 2026-11-23)
- `docker compose` with the Next.js + TypeScript web app, the worker and Postgres; `.env.example`; migrations for the data model.
- GitHub OAuth limited to the configured GitHub team, re-checked at each sign-in.
- Main admin from `MAIN_ADMIN_GITHUB_LOGIN`; the profile question; block list; audit log.
- Register the GitHub App through the manifest flow and receive webhooks via smee.
- Done when: a team member can sign in, an outsider can't, a block by the main admin shows up in `audit_log`, and a webhook from GitHub reaches the local app. All four verified live against the `PromptIn-test` org.

### Milestone 2: Projects, tasks and briefs
- Connect a repo through the GitHub App (repo admins; refused without CI, with a starter workflow offered for docs repos); read and refresh `PROJECT_BRIEF.md`.
- Post a single task, or a project with milestones and tasks. Task form with the brief template, output, allowed paths, estimate and the brief checker.
- "How much do you want to take on?" on the profile and the board; the board shows work that fits, grouped by project.
- Adopt a task or a whole milestone, with the 48-hour lock computed on read; hand back a milestone.
- "Start in Claude" link (with the project and milestone goals), "Copy brief", and the guided walkthrough ("wait for the PR, then click Check for my PR", no Create PR step).
- Update Milestone 1 pieces: posting needs write access only (no `ai-team` requirement), and the welcome question becomes "Have you worked with a coding agent like Claude Code before?".
- Done when: a coworker with write access posts a project with two milestones; someone who picked "a quick run" sees only Small tasks; a different member adopts a whole milestone; adopting any of its tasks again is blocked; the lock lapses at 48 hours (tested with a fake clock); and "Start in Claude" opens a session with the repo and brief filled in.

### Milestone 3: Checks and review
- Link PRs from the `Task: <id>` line, with the paste-the-link fallback; only the adopter's PRs link. Drafts link and get checked.
- The five checks posted as one GitHub check run.
- Review page (with "what to check" and a link to rendered non-code output); request changes and reject as GitHub comments; the task closes and the milestone moves on when GitHub reports the merge; milestone adoptions renew their lock on each PR.
- The 72-hour fix window; one fix round with "Continue in Claude" for guided users.
- Unreviewed-merge alert, using GitHub's collaborator permission API to recognise repo admins.
- Done when: an oversized PR is flagged, a clean one reaches the review page, merging on GitHub closes the task and moves its milestone to the next task, and a merge by the wrong person sets off the alert.

### Milestone 4: Demo-org trial
- A free GitHub org I own, with public sample repos of different kinds (a small website, an automation script, a research repo) and sample projects and tasks, clearly labeled as sample data. Public repos get branch protection for free.
- Individual testers use it as both Developer and Guided users.
- "Helped ship" list on profiles; monthly admin report (work done for others, by estimate and kind, with contributors' usage notes).
- Done when: at least one Developer PR and one Guided PR are merged end to end, at least one of them non-code, and one milestone is finished by two different people.

### Milestone 5: Company trial
- The setup checklist page, then the company's free org with two or three repos.
- Run for four weeks against the success targets below.

## Trial success targets

These are targets to aim for, not predictions. Over four weeks of the company trial:
- At least 5 tasks merged, including at least 2 from Guided users and at least 1 that isn't code.
- At least one milestone finished with help from someone other than its owner.
- Owners' median review time under 15 minutes per PR.
- Fewer than half of PRs rejected, tracked separately for Developer and Guided PRs.
- Project owners say they'd keep using it.

Hitting them is the case for the pitch list.

## Pitch list (paid upgrades after the trial)

- **GitHub Team**, so the default branch is protected on private repos and only reviewed PRs can merge. Every member, guided users included, becomes a paid GitHub seat.
- **A real host with a public address**, so GitHub's webhooks go straight to the app instead of through smee.

## Later (not in the MVP)

- Submit a link for work that doesn't live in GitHub (Google Docs, Figma, hosted demos), marked done by the owner, with no automatic checks.
- MCP server so agents can adopt and submit directly (brings back per-user access tokens).
- Weekly reminder of open work (Slack or email).
- Estimate and cap calibration from logged `usage_note` data.
- A "suggest an idea" box for people without write access to a repo.
- Support for forks.
- The public version, where people trade usage for credits. Parked. Check Anthropic's terms before any work on it: trading usage between strangers looks hard to fit with per-seat rules.

## Risks

| Risk | Mitigation |
| --- | --- |
| Anthropic's per-seat rules. Team seats belong to one person, limits can't be moved between people, and "Users can't route their work through another user's account" | The pitch is "pick up part of a coworker's project". Every run is started by the person in their own session, on company projects in the company's GitHub org (not personal side projects). The site never stores Claude tokens or starts runs, and its copy talks about taking on work, never donating usage. The company, as Anthropic's customer, decides whether to ask Anthropic |
| The company moves to pay-per-use Enterprise billing | There'd be no leftover usage: a guided user's run would cost the same as the owner's. Revisit the pitch if that happens |
| No branch protection on a free GitHub org | Unreviewed-merge alert, a guided walkthrough that never shows merging, low-stakes repos, GitHub Team on the pitch list |
| The smee relay exposes webhook contents and drops events while offline | Unguessable channel URL, low-stakes repos, redelivery from GitHub, direct webhooks on the pitch list |
| Low-quality PRs waste reviewers' time | Per-task caps, big work split into milestone tasks, CI required, PR template, failing PRs kept off the review page, one fix round for guided users, admins can block |
| Guided users can't judge the result, and the owner may not be able to either (the prototype review took 30 seconds on code the reviewer couldn't read) | Checks gate every PR, the owner reviews, the review page leads with a plain-language "what to check", and rejections are tracked by profile |
| Non-code work (research, design) is hard to check automatically | Yes/no acceptance criteria, an Output field naming the file and format, a lint or link-check CI, "cite every source" constraints, and the owner reviews the rendered output |
| Owners post work too big for one run | Estimates with caps, the 500-word brief limit, and milestones to split big work |
| Secrets leaking through briefs or PRs | Secret scanning on both; `.env.example` instead of real values |
| Prompt injection in a brief aimed at contributors' agents. More people can post now | Only coworkers with write access post; the brief checker flags commands and links outside the repo; admins can block |
| Two people adopting the same work | 48-hour adoption lock, covering a milestone's open tasks too |
| Nobody picks up work | The board shows work that fits each person's choice, a "helped ship" list, a monthly report to the admin; the trial measures it |
| Main admin leaves the company | The role is handed over in the admin screen; GitHub org owners are admins too |

## Open items (to settle with the company)

- [ ] Who at the company owns the GitHub org and becomes main admin?
- [ ] Which two or three repos go first, and of which kinds?
- [ ] Which machine runs the trial (decided with IT)?
- [ ] Are trial users mostly on the same office network? If most work remotely, the trial needs a free tunnel instead.
- [ ] From Milestone 2 on, live checks need a second GitHub account or a second tester.

## Notes for Claude Code

- Keep it minimal: one Next.js app, one worker, Postgres, all in `docker compose`. No paid services, no hosted dependencies, no multi-company support, no deployment config.
- Never run contributor code on the site's machine. Checks only read diffs through the GitHub API.
- Never store Claude tokens and never start agent runs. The site only builds links that a person opens.
- Write tests first for the brief checker, the five PR checks, the adoption lock (with a fake clock), milestone adoption and hand-back, the "work that fits" filter, the permission rules, the PR linking rules and the unreviewed-merge alert. Those are the core of the product.
- Never commit secrets. Provide `.env.example` with fake values for the GitHub App credentials, OAuth secrets, database URL, smee URL, `MAIN_ADMIN_GITHUB_LOGIN` and the team names.

## Prompt for the next milestone

> Read plan.md. Start Milestone 2 only. Before writing code, interview me on anything the plan leaves open (with a recommendation for each), then show me a short plan. Add projects and milestones to the data model, connect repos through the GitHub App (refused without CI), the task and project forms with the brief checker, the "How much do you want to take on?" choice and the board that shows work that fits, adopting a task or a whole milestone with the 48-hour lock, and the Start in Claude and Copy brief links. Update Milestone 1's posting rule and welcome question as the plan says. Write tests first for the brief checker, the lock, milestone adoption and the fit filter. Stop when Milestone 2's "Done when" is met and summarize what you built.

## Sources

Checked 2026-11-23:
- Claude Code on the web, including pre-fill links: https://code.claude.com/docs/en/web-quickstart
- Team seat rules: https://support.claude.com/en/articles/12004354
- Team usage limits (per seat, weekly reset): https://support.claude.com/en/articles/9266767
- Claude Code included in every Team seat: https://support.claude.com/en/articles/11845131
- Enterprise usage-based billing: https://support.claude.com/en/articles/9797531
- Using Claude subscriptions in other tools: https://code.claude.com/docs/en/legal-and-compliance

Prototype findings (2026-11-23): `prototype/FINDINGS.md` on the `prototype` branch.

Similar projects:
- Rainshare: https://www.everydev.ai/tools/rainshare (open-source focused)
- opub: https://dev.to/goodroot/introducing-open-public-opub-2hpf
- CleverCrow: https://frontpage-app.vercel.app/news/48621645

Older formatted plan (out of date since this rewrite): https://claude.ai/artifact/KsJQZQF2ksRtUbVzaYJACB

The pre-rewrite version of this plan is kept locally as `plan-v1.md` (not in git).
