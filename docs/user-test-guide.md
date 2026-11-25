# Pitch In: user test guide

A hands-on test of the whole loop on the local install: taking work on, a contributor's run, the checks, the owner's review, merging, and the admin's view. Everything here uses **sample data** in the `PromptIn-test` org. Each scenario says what to do and what you should see; note anything that doesn't match, or that feels slow, confusing or annoying.

Run the scenarios in order. Later ones use what earlier ones leave behind (scenario 4 needs PI-25 merged, scenario 6 needs scenario 1's or 2's PR still open).

## Before you start

1. Start everything: `docker compose up -d --build` in this folder (Docker Desktop must be running), then open http://localhost:3000 and sign in with GitHub.
2. Be signed in to claude.ai in the same browser, on the account connected to the `HakimGtat` GitHub account.
3. Check that Claude's GitHub access covers `PromptIn-test/pitch-in-sample-scripts`, `pitch-in-sample-research` and `pitch-in-sample-site`. Without it, Start in Claude can't open those repos or push to them.
4. Make sure your profile is **Developer**. Open **Admin**, scroll to **Trial**, and write down the numbers now. The panel counts everything ever recorded, including the earlier dogfood work and Text utilities v2, so at the end you compare against these.
5. Webhooks reach the site through the smee relay. If one is missed, the catch-up sweep picks it up within five minutes. Waiting for CI can take a few minutes too (Pitch In checks again every minute, for up to an hour). If something hasn't updated, wait a few minutes before calling it a bug.

What's prepared (all sample data):

| Repo | Kind | Work on the board | Owner |
| --- | --- | --- | --- |
| `pitch-in-sample-scripts` | Python script | PI-23, Add a --dedupe flag (Small, code) | the sample user |
| `pitch-in-sample-research` | Markdown research | PI-24, Compare free uptime monitors (Small, not code) | the sample user |
| `pitch-in-sample-site` | Static website | Project "Bakery site: phones and contact": PI-25, PI-26 (milestone 1), PI-27 (milestone 2) | you |
| `pitch-in-sample` | JS library | the older "Text utilities v2" project | you |

The sample user (`@sample-contributor`) has no GitHub account. Tasks it owns are there so **you** can take them on as a contributor; it can stand in as a contributor on **your** tasks so you can try the owner's side.

## 1. Contributor, Developer profile (about 15 minutes)

1. On the board, pick "A quick run". PI-23 should be listed under single tasks.
2. Open PI-23 and click **Take this on**. You should see "It's yours for the next 48 hours".
3. Click **Start in Claude**. Claude Code on the web opens on `pitch-in-sample-scripts` with the whole brief filled in. Press Enter and leave it.
4. When the run ends, Claude opens the PR by itself, usually as a draft. You don't click anything there. If no PR shows up on the task page, paste its address into **Link a PR** on PI-23's page.
5. Back on PI-23's page, within a minute or two:
   - a **Pull request** card shows the PR and seven check lines: ✓ passed, red ✗ failed, amber ⚠ a format warning. Only Size, Scope, Secrets and CI can fail a PR; the others only warn;
   - while CI runs, the card says "Checks are running: waiting for the repo's CI to finish.";
   - it says your part is done and the owner handles the rest, with no button asking you to do anything;
   - the Start, Link and Hand back cards are gone, and the board's **Your work** row says the owner has it from here.
6. On GitHub, the PR's **Pitch In checks** run shows the same seven lines. Its Details link opens the task page.

Look for: did the agent's PR link by itself (it starts with `Task: PI-23`)? Did any check fail or warn, and was the reason clear? How long did the run take?

## 2. Contributor, Guided profile, non-code work (about 15 minutes)

1. On your profile, under "How much guidance do you want?", pick **Guided** and click that card's **Save**.
2. Take on PI-24. The "Start the work" card now shows four numbered steps and Start in Claude, with no Copy brief.
3. Click **Start in Claude**, press Enter, and wait. The agent writes `research/uptime-monitoring.md` with sources.
4. Check the PR the same way as in scenario 1. CI here is a Markdown lint.
5. Switch back to **Developer** (same card, Save). The Trial panel keeps counting PI-24 as Guided work, since that was your profile when you took it on.

Look for: are the guided steps enough for someone who has never used a coding agent? Is anything on the page aimed at developers only?

## 3. Owner's side, with the sample user standing in (about 20 minutes)

You own the bakery site project. The sample user takes milestone 1 for you, and you run its contributor link yourself (the PR will be authored by you, so you link it by hand, as the owner would when a PR doesn't link).

1. In a terminal in this folder, have the sample user take milestone 1 (sample data):

   ```
   npx tsx --env-file=.env src/scripts/sample-adopt.ts --sample-data adopt 8
   ```

   (8 is milestone 1, "Readable on phones", of the bakery project.) Open the board on **A big chunk** (http://localhost:3000/?take=big): PI-25 and PI-26 show "Taken by @sample-contributor".
2. Get PI-25's contributor link and open it (this is the link the sample user's task page would show). Adding `| clip` copies the long link straight to the clipboard; the terminal can break it if you copy it by hand:

   ```
   npx tsx --env-file=.env src/scripts/sample-adopt.ts --sample-data start-link 25 | clip
   ```

   Paste it into the browser, press Enter in Claude and wait for the PR.
3. The PR names PI-25 but isn't by the person who took it on, so on GitHub its check run says **Not linked to a task**, and on the board **Needs you** shows "PR #… didn't link" with "@sample-contributor took on PI-25, so only their PR links to it." (Up to five minutes if the webhook is missed.)
4. On PI-25's page, paste the PR's address into **Link a PR**. You should see "PR #… is linked to this task." The checks run within a minute, or longer while CI runs.
5. When they've passed (or only warn), the board's **Needs you** lists it as ready, and PI-25's page shows **Review it**. If Size, Scope, Secrets or CI fail, there's no Review it card ("Checks failed on PR #…"): fix it on GitHub, or use scenario 4's reopen on it.
   - **Review in Claude** opens your own Claude Code session with the review packet. Press Enter and see whether its verdict (accept, fix then accept, or reopen) is useful and cheap. If the packet is too long for a link, you get **Copy the review prompt** instead.
   - **Copy packet** and **Download .md** give the same packet.
   - If your review session pushes a fix, wait for the checks to pass again before merging.
6. Merge the PR on GitHub (mark it Ready for review first). Within a minute PI-25's page shows **Done** and it drops off the board. PI-26 becomes the milestone's next task, still taken by @sample-contributor. (`start-link 26` refuses to run before this: the milestone goes in order.)

Look for: was the packet enough to decide without opening the whole repo? Did anything ask the contributor to act?

## 4. Reopen (about 5 minutes)

1. Run PI-26's link the same way (`start-link 26 | clip`). Once the PR opens and shows "didn't link", paste it into **Link a PR** on PI-26's page. You don't have to wait for the checks to reopen.
2. In the **Reopen the task** card, write a one-line reason, optionally tick "Only developers can take it on next", and click **Reopen task**.
3. You should see "Reopened. It's back on the board with your reason in its brief. PR #… closed with your reason." Also check: the PR closed on GitHub with your reason as a comment from the App, PI-26 back on the board as open, your reason under the brief's Constraints as "Note from an earlier try: …", and the sample user no longer holding milestone 1.

## 5. Your own task, done yourself (about 10 minutes)

1. Open PI-27 (nobody holds it). As its owner you get a **Do it yourself** card with Start in Claude, Copy brief and Download .md, plus **Link a PR**.
2. Click **Start in Claude** and press Enter. The PR's description starts with `Task: PI-27`.
3. The PR links as yours ("Owner's PR open" on the board) and gets checked. PI-27's page tells anyone else "The owner has a PR open for this task." If it didn't link, paste it into Link a PR.
4. Mark it Ready for review if it's a draft, then merge it. PI-27 shows Done, with no "Helped ship" credit for anyone.

## 6. Questions for the owner (about 5 minutes)

Use the still-open PR from scenario 1 or 2 (you're its contributor; it stays open because its owner is the sample user). Edit its description on GitHub and add at the end:

```
## Question for owner
Should duplicates be compared case-insensitively? I'd keep it case-sensitive.
```

Within a minute the task page shows **Waiting on the owner** with the question, and "Your part is done… nothing is needed from you." (The owner here is the sample user, so the Answer in Claude button would show on its pages, not yours.) This question stays open for good, which shows in the Trial panel. A section that only says "None" is ignored.

## 7. Admin (about 5 minutes)

1. Open **Admin** and compare the **Trial** panel with the numbers you wrote down. If you ran everything, expect:
   - Merged +2: 1 with a coworker's help (Developer, PI-25), 1 by its owner (PI-27).
   - Reopened, Developer +1 (PI-26).
   - PRs waiting on owners +2 (the PI-23 and PI-24 PRs).
   - Open questions +1.
   - First-pass rates cover 4 more PRs (PI-23 to PI-26; your own PI-27 is left out).
   - The median review wait now includes PI-25.

   Two older direct-push alerts (from pushes to the `pitch-in` copy before admin pushes stopped alerting) may be listed; resolve them.
2. Commit straight to `main` on `pitch-in-sample-research` (it has no open PR you still need). About 30 seconds later, the audit log shows `push.by_admin` from "GitHub / system", and no alert appears: you're a repo admin. (An alert needs someone who isn't an admin: see below.)
3. Times on every page should be in your own time zone.

## With your second tester (later)

These need a second real GitHub account in the `PromptIn-test` org's sign-in team:

- They take on PI-26 for real (PI-25 and PI-27 are done by then): their PR links by itself, and GitHub asks you to review it when the checks pass. If you ticked "Only developers" in scenario 4, they need the Developer profile.
- They merge a PR on a task they don't own: the admin page shows an **unreviewed merge** alert.
- One milestone finished by two different people (Milestone 5's done-when).

## Known limits

- The installed GitHub App doesn't receive `issue_comment` or `check_run` events yet. Questions in the PR description and CI results still arrive; a question left as a PR **comment** waits for the five-minute sweep. An org owner can switch both events on in the App's settings.
- Review in Claude and Answer in Claude only open the session; nothing runs until you press Enter.
