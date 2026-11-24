import { isLongLink, startInClaudeUrl } from "./prompt";

// Review in Claude (plan.md, "Review with the owner's agent"): the owner's own
// session, opened on the PR with the criteria and the review packet, plus
// reading rules that keep the owner's usage low. The site starts nothing: the
// owner opens the link and presses Enter.

export type ReviewPromptInput = {
  prUrl: string;
  repoFullName: string;
  ref: string;
  title: string;
  headRef: string;
  draft: boolean;
  acceptance: string[];
  packet: string;
};

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const parts = [
    `You're reviewing a pull request on ${input.repoFullName} as the owner of the task it's for: ${input.prUrl} (${input.ref}, ${input.title}). A coworker took this task on, and Pitch In's automatic checks already passed.`,
    [
      "How to review (keep it cheap):",
      "- Start from the review packet below: each acceptance criterion, its pointer and the changed lines around it.",
      "- Open only the PR's own files, and only where a pointer needs more context. Don't browse the rest of the repo.",
      "- Don't re-run the tests, and don't re-check what the checks already proved: size, scope, secrets, the template and CI.",
      "- Don't ask the contributor to do anything: their part ended when the PR opened.",
    ].join("\n"),
    [
      "Then tell me one of three outcomes:",
      "- Accept: every criterion is met. I'll merge it on GitHub.",
      `- Fix, then accept: only small problems. If so, fix them yourself in this session: on the PR's branch (${input.headRef}) if this session can push to it, otherwise as a small PR into that branch. Then tell me it's ready to merge.`,
      "- Reopen: the work isn't worth fixing. Give one short reason for the next person who takes it on; I'll reopen the task on Pitch In with it.",
    ].join("\n"),
  ];
  if (input.draft) parts.push("The PR is a draft: mark it Ready for review on GitHub before you merge it.");
  parts.push(`Acceptance criteria:\n${input.acceptance.map((c) => `- ${c}`).join("\n")}`);
  parts.push(input.packet.trim());
  return parts.join("\n\n") + "\n";
}

/** The prompt and its link, built the same way as Start in Claude. `long` means copy it instead. */
export function reviewInClaude(input: ReviewPromptInput): { prompt: string; url: string; long: boolean } {
  const prompt = buildReviewPrompt(input);
  const url = startInClaudeUrl(prompt, input.repoFullName);
  return { prompt, url, long: isLongLink(url) };
}
