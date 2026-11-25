# Pitch In: Build Plan

Internal tool for one company. Coworkers post the projects they're building with AI (websites, games, apps, research, automation) as a single task or as a project with milestones, from company repos. Any coworker can pick up as much as they want to take on, start it in their own Claude session, and their agent opens a PR for the owner to review. Most people barely use their weekly Claude usage, so this puts it to work on projects that would otherwise wait, and the company gets more out of the seats it already pays for.

The pitch is "pick up part of a coworker's project", not token sharing. Contributors choose how much work they take on; the site never frames that as donating or moving usage.

Working name: Pitch In (check for clashes before any public version). The folder stays `ShareAt0ken` for now.

**Status:** Milestone 1 is done (2026-11-23, verified live against a test org). Milestone 2 is built and checked live (2026-11-23, see its section for the one step left). Milestone 3 (plan import) is built and checked live (2026-11-24). Milestone 4 (checks and review) is next, and is already posted on the local board from this plan: project "Pitch In checks and review" on `PromptIn-test/pitch-in`, tasks PI-9 to PI-22.

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
| Contributor's part | Ends when their agent opens the PR. They're never asked to answer questions, fix review comments or re-run after failed checks; the owner handles all of that |
| Sizing | Both sides. The owner estimates each task (Small, Medium, Large). The contributor chooses how much they want to take on (a quick run, a session, a big chunk), and the board shows work that fits |
| Deliverables | Always a PR in a GitHub repo. Non-code work is a Markdown report or files in the repo. Links (Google Docs, Figma, hosted demos) are on the Later list |
| Rewards | None. A "helped ship" list on profiles and a monthly report for the admin |
| Agents | Any agent that can work in a repo. "Start in Claude" opens Claude Code on the web with the task filled in; "Copy brief" works for anything else |
| Platform | GitHub.com, through a GitHub App each company registers itself. The site never hosts code |
| Planning | The owner's own agent splits the project into milestones and task briefs ("Plan in Claude"), and the owner pastes the result into the site |
| Review | The owner reviews every PR together with their own agent, and fixes small problems or reopens the task. Nobody else reviews |
| Owner's usage | Kept as low as possible without asking contributors for more: the site's free checks first, then the contributor's agent, and the owner's agent only for planning, the final call and small fixes |
| Merging | Always on GitHub, never from the site |
| Permissions | Taken from GitHub, plus a main admin and a block list |
| Running it | Docker Compose (web app, worker, Postgres). The company trial runs on a free machine picked with IT |
| This project's code | Public repo, MIT license |
| Public version | Parked. A separate product, not part of this build |

### Decided after the Milestone 4 review (2026-11-25)

A bug hunt and a design critique ran after Milestone 4; their fixes are built. These rule changes came out of it:

- **Gates and warnings.** Scope, Secrets, CI and Size are gates: a PR that fails one isn't ready for review. Template, Criteria and Evidence check the PR description's format; they warn instead of block, so one bad pointer no longer hides the review. The owner still gets the review packet, with the warnings at the top.
- **`CI` as a pointer** is only for a criterion about tests or CI passing. Any other criterion needs a `file:line` pointer.
- **Pushes by repo admins** to the default branch don't raise a direct-push alert (owners push their own work), except forced pushes. They're still written to the audit log.
- **Generated files** marked `linguist-generated` in the repo's `.gitattributes` don't count toward the size cap, like the repo settings' ignore list.
- **Kept as they are:** the 48-hour lock with separate Take on and Start; strict milestone order and whole-milestone adoption (revisit with trial data); test lines count fully toward the cap.
- **Deferred:** the contributor's agent re-reading its own check run and fixing the format (less needed now that format only warns; needs a live test that a web session can read check runs); an automatic first-pass review on the owner's account (bends "a person presses start").
- **The monthly admin report** becomes a Trial panel on the admin page, kept current instead of monthly.

## Profiles

At first sign-in the site asks **"Have you worked with a coding agent like Claude Code before?"** Members of the `ai-team` GitHub team (if the company has one) get it pre-answered as yes.

| Profile | Answer | What they get |
| --- | --- | --- |
| Developer | Yes | The full brief, "Start in Claude", "Copy brief" for other agents |
| Guided | No | A step-by-step walkthrough and "Start in Claude". The walkthrough never mentions merging; it ends with "the owner takes it from here" |

Every task is open to both profiles. The profile only changes how much guidance a person gets, not which work they can take. Once started, the agent works on its own, and when it opens the PR the person's part is done: the checks and the owner take it from there, so a guided user never has to judge the result. Anyone can switch profile later, and admins can change it.

The answer only sets the guidance level. Posting needs write access to the repo, whatever someone answers.

Each person also sets **"How much do you want to take on?"** on their profile (see [Sizing](#sizing)). It's a default for the board filter and can be changed any time.

> Milestone 1 shipped the question as "Are you on the AI team?". Milestone 2 reworded it and added "How much do you want to take on?" to the welcome page.

## Core flow

1. The company does the one-time [setup checklist](#company-setup-checklist).
2. A coworker connects their project's repo (it must have CI) and commits a `PROJECT_BRIEF.md`. A repo without one connects with a warning, so writing it can be the repo's first task.
3. The owner plans the project with their own agent (**Plan in Claude**), pastes the result into the site, and the brief checker runs on every task. Single tasks and small changes go through the task form. Each task has a Task Brief, an estimate and allowed paths.
4. A coworker picks how much they want to take on. The board shows work that fits, and they adopt one task or a whole milestone (48-hour lock).
5. They click **Start in Claude**. Claude Code on the web opens with the repo and prompt filled in. They press Enter and wait. Their agent builds the work, reviews its own diff against the brief, and opens the PR in the [token-saving format](#review-friendly-prs). If a wrong guess would waste the run, it [leaves a question for the owner](#questions-for-the-owner) on a draft PR and ends the run. Claude Code on the web opens the PR itself, as a **draft** (the prototype saw this; there was no Create PR step to click). Their part is done there; they don't need to come back. Developers can instead copy the brief into any agent.
6. The PR body starts with `Task: <task id>` so the site links it. In the prototype the PR kept that first line and all six template sections, so the paste-the-link fallback is kept but was not needed. The PR is authored by the contributor's own GitHub account, which is what "only the adopter's PR links" relies on (the account Claude is connected to must match the username they signed in with). If it doesn't link, the owner (or the contributor, if they happen to look) pastes the PR link into the task page.
7. The GitHub App runs seven automatic checks: plain code, no AI. A PR that fails a gate (scope, secrets, CI, size) isn't ready for review; format problems (template, criteria, evidence) only warn. The owner fixes what's free to fix (a PR body edit, say) or reopens the task. The contributor sees the result but isn't asked to do anything.
8. The owner reviews with their own agent (**Review in Claude**, from a prepared review packet), then accepts and merges on GitHub, has their agent fix small problems first, or reopens the task with notes for the next person.
9. On a milestone, the contributor moves on to its next task, or hands back any time none of their PRs is open. Whatever is left goes back on the board for someone else to continue.

## A contributor's part ends at the PR

People help only if helping stays easy, so once someone takes a job and starts the run, Pitch In never asks them for anything else:

- Open questions are settled before the job starts: the owner's planning agent writes the simplest reading into each brief's constraints.
- During the run, the contributor's agent never waits. It notes its assumptions in the PR, and when a wrong guess would waste the run it ends early with a draft PR and a [question for the owner](#questions-for-the-owner).
- After the PR opens, everything is the owner's: answering questions, fixing small problems, handling failed checks, and reopening the task when the work isn't right. The contributor sees what happened but is never asked to fix, answer or re-run.
- Someone who took a whole milestone starts each next task when they want. That's part of the job they chose, not a follow-up.

The trade is a little more of the owner's usage (small fixes in their own review session instead of a fix round). Contributor goodwill matters more: without contributors there's nothing to review.

## Keeping the owner's usage low

The owner's Claude usage is the scarcest thing in the loop, so every step runs at the cheapest layer that can do it:

1. **The site's checks:** plain code with fixed rules, no AI and no tokens. They catch everything that can be checked mechanically, before the owner sees anything.
2. **The contributor's agent:** builds the work with no limit on its own usage, reviews it twice, and writes the PR so the owner's agent can verify it by following pointers instead of searching. Contributor usage is never the thing to save.
3. **The owner's agent:** plans each project once, then makes the final call on each PR from a review packet the site prepares, never from the whole repo, and fixes small problems itself instead of sending them back.

The owner always reviews with their own agent; nobody else reviews. There are no re-review rounds, and contributors' agents leave the owner a question only when a wrong guess would waste the run.

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
- Posting and reviewing follow GitHub: you need write access to that repo, checked fresh each time. The site never grants more power than GitHub does. (Milestone 1's rule also required `ai-team` membership; Milestone 2 dropped that.)
- Owners can't take on their own work, since they review it.
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

The size cap counts lines added plus lines removed. It skips lockfiles, the generated files listed in repo settings, and files marked `linguist-generated` in `.gitattributes`. Tests count.

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
- **Adopting a task:** as before, one task, one PR. Inside a milestone, tasks go in order: only the milestone's next unfinished task can be adopted on its own. Milestones in the same project can run side by side.
- **Adopting a whole milestone:** the contributor takes its open tasks in order. Each task gets its own Start in Claude run and its own PR, and the owner reviews it before the next one starts. The prompt for each run adds the project and milestone goals and a one-line note on what the earlier tasks in the milestone did.
- **Handing back:** any time none of their PRs is open, the contributor can stop. Merged tasks stay done; the milestone's remaining tasks go back on the board, and anyone can continue.
- **Locks:** a milestone adoption locks its open tasks for 48 hours, renewed each time one of the contributor's PRs is opened or merged.
- A milestone is done when all its tasks are merged. A project is done when its last milestone finishes or the owner marks it done.
- This replaces the earlier "Open-ended tier with checkpoints": a checkpoint is now just the next task in a milestone.

## Brief guideline

Every task ships with a brief written so an agent with no prior knowledge of the repo can finish it in one pass. Two layers, plus the project's goal when the task belongs to one:

- **Project Brief:** `PROJECT_BRIEF.md`, committed once per repo. The site reads it when the repo is connected and refreshes it on every push to the default branch.
- **Task Brief:** written on the site, per task.
- **Project and milestone goals:** written on the site when posting a project, added to every task's prompt.

### Planning a project with the owner's agent (Milestone 3)

- **Plan in Claude:** the "Post a project" page has a link, built like Start in Claude, plus a copy-paste version. It opens the owner's own Claude Code session on the repo with a fixed planning prompt. The prompt is the same for every project, so the link stays well inside the tested length.
- **It starts from a plan the owner already has.** The owner names a plan file and a section (for example "Milestone 4 of `plan.md`"), or describes the goal in the session when there's no plan. Splitting is the one step the owner's agent does, on purpose: it's a small, one-time cost, it saves a separate review of someone else's breakdown, and the acceptance criteria it writes are what every later review checks against.
- To keep that cost small, the agent reformats the plan rather than redesigning it: it reads that section, `PROJECT_BRIEF.md` and the repo map, and opens a file only to confirm a path, or the schema behind a constraint (PI-9's brief asked for unlinked PRs in a table whose task and author can't be empty). It never reads the whole codebase; contributors do that.
- It splits the work into milestones and tasks by these rules: one task is one PR and one session; each estimate is within the repo's largest; files to look at are real paths; acceptance criteria are ones a single pointer can meet ("Tests cover X", not "tests for X are written and pass": CI proves they pass); briefs stay under 500 words; tasks are in dependency order; each milestone ends at something usable.
- It answers with one JSON block in the import format: the project's title and goal, each milestone's title and goal, and every Task Brief field for each task.
- **Import:** the owner pastes the block into the site. The site parses it, runs the brief checker on every task (free), and shows one preview page with all the flags. The owner fixes them (by hand or by asking their agent), then posts the whole project at once. Tasks stay editable until someone takes them on.
- JSON rather than Markdown because it parses exactly; the preview page shows it to the owner as readable briefs.

```json
{
  "project": { "title": "Text utilities v2", "goal": "Safer inputs and two new helpers" },
  "milestones": [
    {
      "title": "Safer inputs",
      "goal": "Every helper rejects bad arguments with a clear error",
      "tasks": [
        {
          "title": "Make slugify reject non-string input",
          "kind": "code",
          "estimate": "small",
          "goal": "slugify throws a TypeError for anything that isn't a string",
          "files": ["src/slugify.js", "tests/slugify.test.js"],
          "allowedPaths": ["src/slugify.js", "tests/**"],
          "acceptance": ["slugify(null) throws a TypeError", "A new test covers non-string input"],
          "testCommand": "npm test",
          "constraints": "No new dependencies"
        }
      ]
    }
  ]
}
```

### How the brief reaches the agent

- **Start in Claude:** the task page builds a link to Claude Code on the web: `https://claude.ai/code?prompt=<url-encoded prompt>&repositories=<owner>/<repo>`. Nothing is sent until the person presses Enter. The prompt stays short (the prototype's links ran about 3,200 to 3,600 characters; on 2026-11-24 links of 6,636 and 8,858 characters filled in completely, the second from a brief over the word limit, so any brief that passes the checker fits. Past 8,858 the task page also points to Copy brief; `prompt_url` stays untested): the project and milestone goals if any, the Task Brief, "read PROJECT_BRIEF.md first" (it's already in the repo), the off-limits paths from repo settings, and "open the PR with the template below, starting with `Task: <task id>`".
- **Contributors trade their own usage for quality.** Only the owner's usage is kept low; the contributor's agent is told to spend whatever it takes to get the work right: read as much of the repo as it needs, write thorough tests, run the full test suite (not only the brief's test command), and before opening the PR do a second, independent review pass of its own diff against every acceptance criterion (for example a fresh subagent asked to find problems). Then it fills in the PR template with evidence pointers, so the owner's agent checks lines instead of searching.
- When something is unclear, it writes down an assumption and carries on. Only when a wrong guess would waste the run does it end early with a draft PR whose description ends with a `## Question for owner` section; it never waits for the answer. Before opening the PR it also checks the PR's shape against the rules the site's checks use, so failed checks are rare. Once the PR is open, the contributor's part is done.
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

The brief checker (no AI needed) flags: missing required fields, files to look at that don't exist in the repo, allowed-path patterns that match nothing (a warning only, since new work can create new folders), briefs over the word limit, anything that looks like a secret, and commands or links outside the repo. Every flag blocks posting except the allowed-path warning, which asks for a "Post anyway". The test command must be one plain command (no `;`, `&&`, `|`, `$(`). Project and milestone goals get the secret, link and command checks too, since they go into every prompt.

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
- A question on a draft PR puts the task in the owner's hands. The contributor doesn't wait for the answer, and the open draft PR holds the task until the owner settles it.
- The adopter can hand back a task or a milestone any time none of their PRs is open; the remaining tasks reopen.

Task statuses: `open` -> `adopted` -> `in_review` -> `merged`. A task goes back to `open` when the owner reopens it, the lock expires, or it's handed back. It becomes `closed` when the owner withdraws it. (Milestone 1's schema also has `changes_requested` and `fix_round`; they're no longer used, since contributors don't do fix rounds.)

Milestone statuses: `open` -> `in_progress` (any task adopted or merged) -> `done` (all tasks merged). Project statuses: `open` -> `done` or `closed`.

## Review-friendly PRs

A PR only reaches review when it is small, tied to one task, and passes every gate (scope, secrets, CI, size). Format problems (template, criteria, evidence) show as warnings in the review packet instead of holding the PR back. A PR with failing checks shows its results on the task page and the owner's pages; the owner fixes what's free to fix (a PR body edit, say) or reopens the task, without spending agent usage on it. The contributor is never asked to fix it.

PR rules:
- One task, one PR. Body starts with `Task: <task id>` so the site links it. A milestone is several tasks, so several PRs.
- Stay under the task's size cap.
- Touch only the brief's allowed paths. No unrelated reformatting or renaming.
- All CI checks pass before it shows up for review.
- Self-review first: the agent re-reads its own diff against every acceptance criterion, runs the test command, and checks the PR's shape against these rules before it finishes.
- Leave out what the site can work out for free: the files changed, commits, line counts and CI results come from GitHub.
- State which agent and model wrote it.
- Branches only, no forks.
- Draft PRs are fine: the checks run on them. The owner's first step on a draft is **Ready for review**, because GitHub won't merge a draft.

Required PR template. Every acceptance criterion from the brief, word for word, ticked, with exactly one pointer to where it's met, so the owner's agent checks lines instead of searching. A pointer is `file:line` or `file:start-end` with the full path, on lines the diff changed, or `CI` for a criterion that says all tests pass; anything else worth reading goes under Where to look. How it was tested ends with one line on what the second review pass found:

```markdown
Task: PI-12

## Summary
- slugify throws a TypeError for anything that isn't a string

## Acceptance criteria
- [x] slugify(null) throws a TypeError -> src/slugify.js:8
- [x] A new test covers non-string input -> tests/slugify.test.js:41
- [x] All existing tests pass -> CI

## Where to look
- src/slugify.js:6-10: the new type check; everything else is tests

## How it was tested
`npm test` -> 12 passed, 0 failed
Second review pass: <what it found and fixed, or "nothing new">

## Not done or assumed
- Numbers are rejected, not converted (the brief didn't say which)

## Agent
<agent and model used>
```

Automatic checks, posted as one GitHub check run per linked PR. They are plain code with fixed rules, no AI and no tokens: the worker reads the PR body, the changed files and the CI results through the GitHub API, and the same PR always gets the same result. They prove the PR's shape, not whether the code is right; that judgement is the owner's agent's.

| Check | Fails when |
| --- | --- |
| Template | The first line isn't `Task: <task id>`, or a required section is missing or empty |
| Size | Lines changed exceed the task's cap (see the counting rules under Sizing) |
| Scope | Files outside the brief's allowed paths, or any off-limits file, changed |
| Secrets | A key, token or password pattern appears in the diff (gitleaks, a rules-based scanner) |
| CI | The repo's own checks fail (tests for code, a lint or link check for docs and research). The site's own check run is ignored here |
| Criteria | The PR doesn't list every acceptance criterion from the brief, word for word, all ticked |
| Evidence | A criterion's pointer (`file:line`) isn't inside a changed part of the diff. "CI" is a valid pointer only for a criterion about tests or CI passing |

Scope, Secrets, CI and Size are gates; Template, Criteria and Evidence warn.

A contributor sees the result as one check run, for example:

```
Pitch In checks: 6 passed, 1 failed
✓ Template   all sections filled
✓ Size       142 of 300 lines
✗ Scope      README.md is outside the allowed paths
✓ Secrets    nothing found
✓ CI         test: success
✓ Criteria   3 of 3 listed and ticked
✓ Evidence   3 of 3 pointers found in the diff
```

A repo without CI can't be connected at all. Docs and research repos need at least a Markdown lint or link-check workflow; the connect screen offers a copy-paste starter workflow for them.

### Review with the owner's agent

The owner reviews every PR with their own agent. The site prepares a **review packet** for free from the PR and the diff: the Summary, each acceptance criterion with its evidence, Where to look, Not done or assumed, the check results, and only the changed lines around each pointer. For non-code tasks it links straight to the rendered output file on GitHub. A draft shows a "mark Ready for review on GitHub first" note.

**Review in Claude** opens the owner's own session with the PR link, the brief's acceptance criteria and the packet filled in, plus reading rules that keep it cheap: start from the packet; open only the PR's own files, and only where a pointer needs context; never browse the rest of the repo; never re-run tests or re-check what the checks already proved (size, scope, secrets, template, CI). How the packet reaches the agent when it's longer than a link holds (copy and .md download as with Copy brief, or the check run's summary on GitHub) is settled in Milestone 4.

The owner's agent answers with one of three outcomes, which the owner carries out:

- **Accept:** the owner merges on GitHub. When GitHub reports the merge, the task closes, the milestone moves on, and the contributor gets a "helped ship" entry.
- **Fix, then accept:** for small problems, the owner's agent fixes them in the same review session instead of sending the PR back: on the PR's branch if the session can work on it (unconfirmed), otherwise as a small PR into that branch. Then the owner merges, and the contributor still gets the "helped ship" entry. PR linking and the checks ignore PRs that don't target the default branch, so a fix PR into a contributor's branch isn't flagged.
- **Reopen:** for work that isn't worth fixing. The owner gives a short reason; the App closes the PR with it, the reason is added to the task's brief so the next person doesn't repeat it, and the task goes back on the board. The owner can mark it for developers only (say, after a guided user's try). The contributor isn't asked to do anything.

### Questions for the owner

Agents can't talk live: each one runs in its own person's session, the site never runs one, and a stopped session can't be woken up. So a question never waits for its answer:

- **Ask rarely.** Planning settles most questions ahead of time in each brief. By default the contributor's agent writes down an assumption under "Not done or assumed" and carries on; the owner corrects it at review if needed.
- **Ask and end the run.** Only when a wrong guess would waste the whole run, the agent opens a draft PR with what it has, ending its description with a `## Question for owner` section (one question, the options it sees, and the one it would take), then ends the run. A PR comment starting `Question for owner:` works too. The contributor's part is done.
- **The site flags it.** It picks the question up when it checks the PR (and from the `issue_comment` webhook, or the five-minute catch-up sweep, for a comment), marks the task "waiting on owner" on the task page and the owner's pages, and offers **Answer in Claude** (the question, the brief and the draft PR filled in).
- **The owner settles it,** with their agent or by hand: finish the work on the draft PR (as in Fix, then accept), or write the answer into the brief and reopen the task for anyone to take on. The contributor is never asked to come back, though they're welcome to take the reopened task again.
- A direct agent-to-site channel comes later, with the MCP server.

### Unreviewed-merge alert

Free GitHub orgs can't protect branches on private repos, so anyone with push access could merge their own PR. Until the company upgrades:
- The site watches every merge and every push to the default branch.
- If a PR is merged by anyone other than the task owner or a repo admin (admin status comes from GitHub's collaborator permission API, so legitimate merges don't set off the alert), or the default branch changes without an owner-merged PR (pushes by repo admins don't count, except forced pushes), the admin page shows an alert, the task page shows a warning, and an `alerts` row and an `audit_log` row are written.

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

GitHub App permissions: read contents, metadata, commit statuses and organization members; read and write pull requests (comments, closing); write checks. Listen for `installation`, `pull_request`, `check_suite`, `check_run`, `push` and `issue_comment` events (`issue_comment` for agents' questions and `check_run` for CI finishing, from Milestone 4). An App registered before Milestone 4 needs `issue_comment` and `check_run` switched on in its GitHub settings, a one-time step for an org owner. Without `check_run`, the checks still finish: the worker checks again while CI runs.

```
Coworkers -> Web app (Next.js) <-> PostgreSQL
Coworker clicks Start in Claude -> Claude Code on the web (their own seat) -> opens PR on GitHub
GitHub -> webhooks -> smee relay -> web app
Worker reads diffs from GitHub, runs checks, posts the check run, saves results to PostgreSQL
Owner merges on GitHub -> webhook -> task closes, milestone moves on
```

### Data model

Milestone 1 created users, repos, tasks, adoptions, submissions, reviews, jobs, alerts and audit_log. Milestone 2 added projects and milestones and the columns marked new below.

| Table | Key fields |
| --- | --- |
| users | github_id, handle, profile (developer or guided), take_on (quick, session or big; new), is_main_admin, is_org_owner, in_ai_team, blocked, membership_checked_at |
| repos | github_repo_id, installation_id, project_brief, has_ci, refreshed_at (new), settings (largest estimate, off-limits paths, size-cap ignore list) |
| projects (new) | repo_id, owner_id, title, goal, status (open, done, closed) |
| milestones (new) | project_id, position, title, goal, status (open, in_progress, done) |
| tasks | repo_id, project_id and milestone_id (new, optional), position (new), owner_id, title, kind (code or other; new), brief (the structured fields; new), brief_md, size_tier (small, medium, large), allowed_paths, status |
| adoptions | task_id, milestone_id (new, set for whole-milestone adoptions), user_id, expires_at, status (active, released, expired, completed) |
| submissions | task_id, pr_number, head_sha, author_id, check_results, usage_note, fix_round (unused: contributors don't do fix rounds), status |
| questions (planned, Milestone 4) | submission_id, github_comment_id, asked_at, answered_at |
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

### Milestone 2: Projects, tasks and briefs (built 2026-11-23)
- Connect a repo through the GitHub App (repo admins; refused without CI, with a starter workflow offered for docs repos); read and refresh `PROJECT_BRIEF.md`.
- Post a single task, or a project with milestones and tasks. Task form with the brief template, output, allowed paths, estimate and the brief checker.
- "How much do you want to take on?" on the profile and the board; the board shows work that fits, grouped by project.
- Adopt a task or a whole milestone, with the 48-hour lock computed on read; hand back a milestone.
- "Start in Claude" link (with the project and milestone goals), "Copy brief", and the guided walkthrough (no Create PR step; since Milestone 3 it ends when the PR opens, with no Check for my PR step).
- Update Milestone 1 pieces: posting needs write access only (no `ai-team` requirement), and the welcome question becomes "Have you worked with a coding agent like Claude Code before?".
- Done when: a coworker with write access posts a project with two milestones; someone who picked "a quick run" sees only Small tasks; a different member adopts a whole milestone; adopting any of its tasks again is blocked; the lock lapses at 48 hours (tested with a fake clock); and "Start in Claude" opens a session with the repo and brief filled in.
- How it was checked (2026-11-23): 169 tests, plus a live run against the `PromptIn-test` org with `PromptIn-test/pitch-in-sample` (a public copy of the prototype's sample repo, sample data). The repo connected with CI and `PROJECT_BRIEF.md` read. A project with two milestones and four tasks was posted through the forms, and the brief checker caught a bad brief. "A quick run" showed only the two Small tasks. A sample user (`src/scripts/sample-adopt.ts`, sample data, standing in for a second person) adopted milestone 1, and its tasks then showed as taken with no way to adopt them. The 48-hour lapse is covered by fake-clock tests. Start in Claude opened Claude Code on the web with the full prompt filled in, but the org repo wasn't preselected because Claude's GitHub App isn't installed on `PromptIn-test` yet (setup checklist step 5); the same link format did preselect a repo that Claude's App can see. Since done (2026-11-24): Claude's GitHub App is installed on `PromptIn-test`, and Start in Claude opened with the repo selected.

### Milestone 3: Plan import (built 2026-11-24)
Comes before checks and review, so that Milestone 4 itself can be posted on the board from `plan.md` instead of through the task forms.
- Plan in Claude on the "Post a project" page: the fixed planning prompt for the owner's own session (and a copy-paste version), taking a plan file and a section ("Milestone 4 of `plan.md`"), with the splitting rules and the import format.
- Import: paste the agent's JSON; the site parses it, runs the brief checker on every task, shows one preview with all the flags, and posts the project, its milestones and tasks together.
- Start in Claude's prompt switches to the contributor rules under [How the brief reaches the agent](#how-the-brief-reaches-the-agent): thoroughness over economy, a second review pass, and the new PR template (the checks that enforce the template come in Milestone 4).
- Done when: the owner's agent turns the Milestone 4 section of this `plan.md` into a project with tasks in the import format; the import flags a task whose files don't exist in the repo; after the fix, the whole project posts in one go on a connected repo; and a task from it opens in Start in Claude with the new contributor rules.
- To post Pitch In's own work, its repo must be one the Pitch In App can see: a copy in the `PromptIn-test` org (like the sample repo) or the App installed on the account that holds it. The copy is `PromptIn-test/pitch-in` (public), which needed a CI workflow and `PROJECT_BRIEF.md`; both are now in this repo. Until Milestone 4 is built, PRs for those tasks are reviewed on GitHub with the owner's agent.
- How it was checked (2026-11-24): 225 tests, plus a live run on `PromptIn-test/pitch-in` with Claude's GitHub App installed on the org. Plan in Claude (a 3,173-character link) opened the owner's session on the repo with "Milestone 4: Checks and review" of `plan.md`; the agent answered with one JSON block of 3 milestones and 14 tasks. The import flagged 11 problems: three files that an earlier task creates (`src/lib/checks/types.ts` twice, `src/lib/review-packet.ts`), seven tasks without a test command, and one link outside the repo; plus 29 warnings for allowed paths the tasks will create. After fixing the JSON by hand, the whole project posted in one go (PI-9 to PI-22). A sample user (sample data) took on milestone 1, and PI-9's Start in Claude link (6,636 characters) opened Claude Code on the repo with the full prompt and the contributor rules filled in. The run led to two prompt changes (fill in every field, testCommand included; files must exist now, not be created by an earlier task) and to folding long warning lists in the preview.

### Milestone 4: Checks and review (built 2026-11-24)
Reworked on 2026-11-24 so a contributor's part ends at the PR (see [A contributor's part ends at the PR](#a-contributors-part-ends-at-the-pr)); its tasks on the board were rewritten to match.
- Link PRs from the `Task: <id>` line, with the paste-the-link fallback (for the adopter or the task owner); only the adopter's PRs link. Drafts link and get checked. PRs that don't target the default branch are ignored.
- The seven checks (template, size, scope, secrets, CI, criteria, evidence) as plain code, posted as one GitHub check run; gitleaks joins the image.
- The review packet and Review in Claude for the owner's agent: accept (merge on GitHub), fix then accept (the owner's agent fixes small problems itself), or reopen with the reason added to the brief.
- Questions for the owner: the contributor's agent asks on a draft PR and ends the run; the site shows "waiting on owner" and Answer in Claude; the owner finishes the work or reopens the task with the answer in its brief.
- The task closes and the milestone moves on when GitHub reports the merge; milestone adoptions renew their lock on each PR.
- Failed checks go to the owner: the task page and the owner's pages show them, with free ways out (edit the PR on GitHub, or reopen). The contributor isn't asked to fix anything.
- Unreviewed-merge alert, using GitHub's collaborator permission API to recognise repo admins.
- Done when: an oversized PR and a PR with a dangling evidence pointer are flagged; a clean one reaches the owner, whose agent reviews it through Review in Claude; a PR with a small problem is fixed by the owner's agent and merged; a reopened task goes back on the board with the reason in its brief; a question on a draft PR shows as waiting on the owner; nothing asks the contributor for anything after their PR opens; merging on GitHub closes the task and moves its milestone to the next task; and a merge by the wrong person sets off the alert.
- How it was built (2026-11-24): PI-9 through a dogfood contributor run; PI-10 to PI-22 directly in the owner's session, each from its brief on the board, with tests first, then recorded as done on the board. Two things beyond the briefs: pasting a PR link checks the PR right away, and while the repo's CI is still running the check run stays in progress and the worker checks again every minute (up to an hour), so it doesn't depend on a CI webhook. A push is judged by its own job half a minute later, asking GitHub which PR made the commit, so the order webhooks arrive in doesn't matter.
- How it was checked (2026-11-24): 385 tests, plus a live run on `PromptIn-test/pitch-in-sample` (sample data). A PR naming PI-1 that a non-adopter opened got a failing "Not linked to a task" check run; once the owner pasted its link, it showed Size (352 of 300 lines) and Evidence (a pointer to an unchanged line) failing, with gitleaks and CI really run. The owner's fix (a commit on the PR's branch and a PR body edit) made it pass, with the check run waiting for CI and finishing when the CI suite completed; Review in Claude and the packet appeared for the owner; merging on GitHub closed PI-1, moved milestone 1 on to PI-2 and renewed the holder's lock, with no alert. Reopening PI-3 closed its PR with the reason as an App comment, put the reason in the brief and released PI-3 and PI-4. A draft PR on PI-5 linked from its `Task:` line, passed all seven checks and showed its adopter "your part is done" with no button; a repo admin's merge raised no alert and gave a "Helped ship" entry. A direct push to `main` raised a direct_push alert, which the main admin resolved. **Not checked live:** the question pickup (the App isn't subscribed to `issue_comment` yet, so the real comment's delivery was replayed to the local webhook endpoint, and it then showed "Waiting on the owner"); Review in Claude opening in Claude Code (the browser pane's claude.ai sign-in had expired; the same link format filled in earlier); and an unreviewed merge by someone who isn't the owner or a repo admin (needs a second GitHub account; covered by tests).

### Milestone 5: Demo-org trial
- A free GitHub org I own, with public sample repos of different kinds (a small website, an automation script, a research repo) and sample projects and tasks, clearly labeled as sample data. Public repos get branch protection for free.
- Individual testers use it as both Developer and Guided users.
- "Helped ship" list on profiles; a Trial panel on the admin page (work done for others by estimate, kind and profile, review wait, reopen rate, first-pass rate per check).
- Done when: at least one Developer PR and one Guided PR are merged end to end, at least one of them non-code, and one milestone is finished by two different people.

### Milestone 6: Company trial
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
- MCP server so agents can adopt, submit, and ask or answer questions through the site directly (brings back per-user access tokens).
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
| Low-quality PRs waste owners' time and usage | Per-task caps, big work split into milestone tasks, CI required, the criteria and evidence checks, PRs failing a gate never reach review, the owner reopens with notes for the next person, admins can block |
| Planning and reviews use up the owner's Claude usage | Free checks first; contributors self-review and write the pointer-based PR format; the owner's agent reads a review packet, not the repo; small fixes happen once, in the owner's own review session; planning settles questions up front |
| A contributor's agent writes evidence pointers that look right but aren't | The evidence check proves each pointer lands in the diff; the owner's agent checks what it points at |
| Guided users can't judge the result, and the owner may not be able to either (the prototype review took 30 seconds on code the reviewer couldn't read) | Checks gate every PR, the owner reviews every PR with their own agent from a review packet, and rejections are tracked by profile |
| Non-code work (research, design) is hard to check automatically | Yes/no acceptance criteria, an Output field naming the file and format, a lint or link-check CI, "cite every source" constraints, and the owner reviews the rendered output |
| Owners post work too big for one run | Estimates with caps, the 500-word brief limit, and milestones to split big work |
| Secrets leaking through briefs or PRs | Secret scanning on both; `.env.example` instead of real values |
| Prompt injection in a brief aimed at contributors' agents. More people can post now | Only coworkers with write access post; the brief checker flags commands and links outside the repo; admins can block |
| Contributors stop helping because of follow-up chores | Their part ends at the PR: no questions to answer, no fix rounds, no re-runs after failed checks. Planning settles questions up front, the contributor's agent checks its own PR's shape, and the owner handles everything after the PR opens |
| Two people adopting the same work | 48-hour adoption lock, covering a milestone's open tasks too |
| Nobody picks up work | The board shows work that fits each person's choice, a "helped ship" list, a monthly report to the admin; the trial measures it |
| Main admin leaves the company | The role is handed over in the admin screen; GitHub org owners are admins too |

## Open items (to settle with the company)

- [ ] Who at the company owns the GitHub org and becomes main admin?
- [ ] Which two or three repos go first, and of which kinds?
- [ ] Which machine runs the trial (decided with IT)?
- [ ] Are trial users mostly on the same office network? If most work remotely, the trial needs a free tunnel instead.
- [ ] From Milestone 2 on, live checks need a second GitHub account or a second tester. A tester is lined up; bring them in only when a step truly needs a second real account (PR linking in Milestone 4 will).

## Notes for Claude Code

- Keep it minimal: one Next.js app, one worker, Postgres, all in `docker compose`. No paid services, no hosted dependencies, no multi-company support, no deployment config.
- Never run contributor code on the site's machine. Checks only read diffs through the GitHub API.
- Never store Claude tokens and never start agent runs. The site only builds links that a person opens.
- Write tests first for the brief checker, the seven PR checks, the review packet, plan import, the adoption lock (with a fake clock), milestone adoption and hand-back, the "work that fits" filter, the permission rules, the PR linking rules and the unreviewed-merge alert. Those are the core of the product.
- Keep the owner's usage low: anything the site can work out for free (files changed, line counts, CI results, the diff around a pointer) never goes in a prompt or a PR body.
- Never commit secrets. Provide `.env.example` with fake values for the GitHub App credentials, OAuth secrets, database URL, smee URL, `MAIN_ADMIN_GITHUB_LOGIN` and the team names.

## Prompt for the next milestone

Milestone 5 (demo-org trial) is next. Before it, an org owner switches on the `issue_comment` and `check_run` events for the existing Pitch In App (see GitHub App permissions above). Questions in a PR's description already arrive live without it; comment questions otherwise wait for the five-minute catch-up sweep. The second tester is needed from Milestone 5 on, for a merge by someone who isn't the owner or a repo admin and for the "finished by two different people" milestone.

Milestone 4 itself was posted on the board as project "Pitch In checks and review" (PI-9 to PI-22, on `PromptIn-test/pitch-in`, now done). PI-9 went through a dogfood contributor run, which led to the pointer, second-review and schema rules in the prompts. Pitch In's own repo can now be checked by Pitch In: work merged in the `PromptIn-test/pitch-in` copy comes back to `HakimGtat/pitch-in` fast-forward only, and both repos stay identical.

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

Formatted copy of this plan (updated 2026-11-23, after Milestone 2): https://claude.ai/artifact/KsJQZQF2ksRtUbVzaYJACB

The pre-rewrite version of this plan is kept locally as `plan-v1.md` (not in git).
