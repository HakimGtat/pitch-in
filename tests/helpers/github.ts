import type { ChangedFile } from "@/lib/checks/files";
import type { CheckRun, CheckRunInput, GitHubRepo, PullRequest, RepoGitHub } from "@/lib/github/repos";
import type { RepoPermission } from "@/lib/permissions";

export type PostedCheckRun = { fullName: string; id: number; name: string; op: "create" | "update"; run: CheckRunInput };

/** A pretend GitHub with one org, a few repos, per-person permissions, PRs and check runs. */
export function fakeGitHub() {
  const world = {
    repos: new Map<number, GitHubRepo>(),
    files: new Map<string, Record<string, string>>(),
    perms: new Map<string, Record<string, RepoPermission>>(),
    pulls: new Map<string, PullRequest>(),
    prFiles: new Map<string, ChangedFile[]>(),
    checkRuns: new Map<string, CheckRun[]>(),
    statuses: new Map<string, { context: string; state: string }[]>(),
    posted: [] as PostedCheckRun[],
    comments: [] as { fullName: string; number: number; body: string }[],
    closed: [] as { fullName: string; number: number }[],
  };
  let nextCheckRunId = 1000;
  const prKey = (fullName: string, n: number) => `${fullName}#${n}`;
  const shaKey = (fullName: string, sha: string) => `${fullName}@${sha}`;

  const gh: RepoGitHub = {
    installationId: async () => 777,
    listRepos: async () => [...world.repos.values()],
    getRepo: async (id) => world.repos.get(id) ?? null,
    permission: async (fullName, login) => world.perms.get(fullName)?.[login] ?? "none",
    listWorkflows: async (fullName) =>
      Object.keys(world.files.get(fullName) ?? {})
        .filter((p) => p.startsWith(".github/workflows/"))
        .map((p) => p.split("/").pop()!),
    readFile: async (fullName, path) => {
      const text = world.files.get(fullName)?.[path];
      return text === undefined ? null : { text, sha: `sha-${text.length}` };
    },
    tree: async (fullName) => ({ paths: Object.keys(world.files.get(fullName) ?? {}), truncated: false }),
    getPullRequest: async (fullName, n) => {
      const pr = world.pulls.get(prKey(fullName, n));
      return pr ? { ...pr } : null;
    },
    listPullRequestFiles: async (fullName, n) => world.prFiles.get(prKey(fullName, n)) ?? [],
    listCheckRuns: async (fullName, sha) => (world.checkRuns.get(shaKey(fullName, sha)) ?? []).map((r) => ({ ...r })),
    listCommitStatuses: async (fullName, sha) => world.statuses.get(shaKey(fullName, sha)) ?? [],
    createCheckRun: async (fullName, name, run) => {
      const id = nextCheckRunId++;
      const list = world.checkRuns.get(shaKey(fullName, run.headSha)) ?? [];
      list.push({ id, name, status: run.status, conclusion: run.conclusion ?? null });
      world.checkRuns.set(shaKey(fullName, run.headSha), list);
      world.posted.push({ fullName, id, name, op: "create", run });
      return id;
    },
    updateCheckRun: async (fullName, id, run) => {
      for (const list of world.checkRuns.values()) {
        const found = list.find((r) => r.id === id);
        if (found) {
          found.status = run.status;
          found.conclusion = run.conclusion ?? null;
          world.posted.push({ fullName, id, name: found.name, op: "update", run });
          return;
        }
      }
      throw new Error(`No check run ${id}`);
    },
    closePullRequest: async (fullName, n, comment) => {
      world.comments.push({ fullName, number: n, body: comment });
      const pr = world.pulls.get(prKey(fullName, n));
      if (pr) pr.state = "closed";
      world.closed.push({ fullName, number: n });
    },
    pullsForCommit: async (fullName, sha) =>
      [...world.pulls.entries()]
        .filter(([key, pr]) => key.startsWith(`${fullName}#`) && (pr.mergeCommitSha === sha || pr.headSha === sha))
        .map(([, pr]) => pr.number),
  };

  const addRepo = (id: number, fullName: string, files: Record<string, string>, perms: Record<string, RepoPermission>) => {
    world.repos.set(id, { id, fullName, defaultBranch: "main", private: false, archived: false });
    world.files.set(fullName, files);
    world.perms.set(fullName, perms);
  };

  /** A PR on a repo, with its changed files. Fields default to an open PR into main. */
  const addPull = (fullName: string, pr: Partial<PullRequest> & { number: number; author: string }, files: ChangedFile[] = []) => {
    const full: PullRequest = {
      title: `PR ${pr.number}`,
      body: "",
      draft: false,
      state: "open",
      merged: false,
      mergedBy: null,
      mergeCommitSha: null,
      headSha: `head-${pr.number}`,
      headRef: `branch-${pr.number}`,
      baseRef: "main",
      url: `https://github.com/${fullName}/pull/${pr.number}`,
      ...pr,
    };
    world.pulls.set(prKey(fullName, pr.number), full);
    world.prFiles.set(prKey(fullName, pr.number), files);
    return full;
  };

  /** The repo's own CI results on a commit. */
  const setCi = (fullName: string, sha: string, runs: { name: string; status?: string; conclusion: string | null }[]) => {
    const others = (world.checkRuns.get(shaKey(fullName, sha)) ?? []).filter((r) => world.posted.some((p) => p.id === r.id));
    world.checkRuns.set(shaKey(fullName, sha), [
      ...runs.map((r, i) => ({ id: 1 + i, name: r.name, status: r.status ?? "completed", conclusion: r.conclusion })),
      ...others,
    ]);
  };

  return { gh, world, addRepo, addPull, setCi };
}
