import type { RepoTree } from "../brief";
import type { ChangedFile, CiRun } from "../checks/files";
import type { RepoPermission } from "../permissions";

/** A pull request, fresh from GitHub. */
export type PullRequest = {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  mergedBy: string | null;
  mergeCommitSha: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
  author: string;
  url: string;
};

/** A check run on a commit, from any app. */
export type CheckRun = CiRun & { id: number };

/** What Pitch In posts as its one check run. */
export type CheckRunInput = {
  headSha: string;
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure";
  title: string;
  summary: string;
  /** The "Details" link on GitHub: the task page. */
  detailsUrl?: string;
};

/** A repo the Pitch In App can see on the company org. */
export type GitHubRepo = {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
};

/**
 * The GitHub calls repos and posting need. The real one lives in
 * lib/github/app.ts and uses the App's installation token; tests use a fake.
 */
export interface RepoGitHub {
  /** The App's installation id on the company org. */
  installationId(): Promise<number>;
  /** Repos the App's installation can see. */
  listRepos(): Promise<GitHubRepo[]>;
  /** One repo by its numeric id (survives renames), or null if the App can't see it. */
  getRepo(id: number): Promise<GitHubRepo | null>;
  /** The person's permission on the repo, fresh from GitHub. */
  permission(fullName: string, login: string): Promise<RepoPermission>;
  /** File names in .github/workflows on a branch. Empty when the folder doesn't exist. */
  listWorkflows(fullName: string, ref: string): Promise<string[]>;
  /** A text file on a branch, or null if it doesn't exist. */
  readFile(fullName: string, path: string, ref: string): Promise<{ text: string; sha: string } | null>;
  /** Every file path on a branch. */
  tree(fullName: string, ref: string): Promise<RepoTree>;
  /** The repo's open pull requests, newest first. */
  listOpenPullRequests(fullName: string): Promise<PullRequest[]>;
  /** One pull request, or null if it doesn't exist. */
  getPullRequest(fullName: string, number: number): Promise<PullRequest | null>;
  /** The PR's changed files with their patches. */
  listPullRequestFiles(fullName: string, number: number): Promise<ChangedFile[]>;
  /** The latest check run of each name on a commit, from every app. */
  listCheckRuns(fullName: string, sha: string): Promise<CheckRun[]>;
  /** Legacy commit statuses on a commit, latest per context. */
  listCommitStatuses(fullName: string, sha: string): Promise<{ context: string; state: string }[]>;
  /** Posts a check run as the Pitch In App. Returns its id. */
  createCheckRun(fullName: string, name: string, run: CheckRunInput): Promise<number>;
  updateCheckRun(fullName: string, id: number, run: CheckRunInput): Promise<void>;
  /** Comments on a PR as the Pitch In App, then closes it without merging. */
  closePullRequest(fullName: string, number: number, comment: string): Promise<void>;
  /** Asks someone to review a PR (it shows in their GitHub notifications). */
  requestReview(fullName: string, number: number, login: string): Promise<void>;
  /** The comments on a PR's conversation, oldest first. */
  listIssueComments(fullName: string, number: number): Promise<{ id: number; body: string; author: string }[]>;
  /** Numbers of the PRs GitHub associates with a commit (a merge commit's own PR among them). */
  pullsForCommit(fullName: string, sha: string): Promise<number[]>;
}

export const PROJECT_BRIEF_PATH = "PROJECT_BRIEF.md";

/** A repo has CI when at least one workflow file exists on its default branch. */
export function hasWorkflowFile(names: string[]): boolean {
  return names.some((n) => /\.ya?ml$/i.test(n));
}

/** Offered when a docs or research repo has no CI yet. */
export const STARTER_WORKFLOW_PATH = ".github/workflows/docs-check.yml";
export const STARTER_WORKFLOW = `name: Docs check

on:
  pull_request:
  push:
    branches: [main]

jobs:
  markdown:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DavidAnson/markdownlint-cli2-action@v20
        with:
          globs: "**/*.md"
`;

/** Optional: relax the rules most existing docs trip over. Commit next to the workflow. */
export const STARTER_LINT_CONFIG_PATH = ".markdownlint-cli2.jsonc";
export const STARTER_LINT_CONFIG = `{
  "config": {
    "MD013": false
  }
}
`;
