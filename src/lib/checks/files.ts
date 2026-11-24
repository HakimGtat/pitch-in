/** One file in a PR, as GitHub's "list pull request files" returns it. */
export type ChangedFile = {
  path: string;
  /** Set when the file was renamed: the old path counts for scope too. */
  previousPath?: string;
  additions: number;
  deletions: number;
  /** added, modified, removed, renamed... */
  status?: string;
  /** The unified-diff patch text. GitHub leaves it out for binary and very large files. */
  patch?: string;
  /** For a changed text file without a patch: the whole file at the PR's head, so it can still be scanned. */
  content?: string;
};

/** A CI result for the PR's head commit: a check run, or a commit status mapped to one. */
export type CiRun = {
  name: string;
  /** queued, in_progress or completed. */
  status: string;
  /** success, failure, neutral, skipped, cancelled, timed_out... null until completed. */
  conclusion: string | null;
};
