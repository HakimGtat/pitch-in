import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import type { Config, GitHubAppConfig } from "../config";
import type { SignInGitHub, TeamState } from "../auth/signin";
import type { RepoPermission } from "../permissions";
import type { GitHubRepo, PullRequest, RepoGitHub } from "./repos";

export class AppNotInstalledError extends Error {
  constructor(org: string) {
    super(`The Pitch In GitHub App isn't installed on ${org}.`);
  }
}

const isStatus = (err: unknown, status: number) =>
  typeof err === "object" && err !== null && "status" in err && err.status === status;

let cachedApp: { key: string; app: App<{ Octokit: typeof Octokit }> } | undefined;

export function getApp(cfg: GitHubAppConfig) {
  if (cachedApp?.key !== cfg.appId) {
    cachedApp = {
      key: cfg.appId,
      app: new App({
        appId: cfg.appId,
        privateKey: cfg.privateKey,
        oauth: { clientId: cfg.clientId, clientSecret: cfg.clientSecret },
        Octokit,
      }),
    };
  }
  return cachedApp.app;
}

/** The App's installation on the company org, or null if it isn't installed yet. */
export async function getOrgInstallation(
  cfg: GitHubAppConfig,
  org: string,
): Promise<{ id: number } | null> {
  try {
    const { data } = await getApp(cfg).octokit.request(
      "GET /orgs/{org}/installation",
      { org },
    );
    return { id: data.id };
  } catch (err) {
    if (isStatus(err, 404)) return null;
    throw err;
  }
}

async function orgOctokit(cfg: GitHubAppConfig, org: string) {
  const installation = await getOrgInstallation(cfg, org);
  if (!installation) throw new AppNotInstalledError(org);
  return getApp(cfg).getInstallationOctokit(installation.id);
}

const splitName = (fullName: string) => {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
};

type RawRepo = { id: number; full_name: string; default_branch?: string; private: boolean; archived?: boolean };
const toRepo = (r: RawRepo): GitHubRepo => ({
  id: Number(r.id),
  fullName: r.full_name,
  defaultBranch: r.default_branch ?? "main",
  private: r.private,
  archived: Boolean(r.archived),
});

/** The real GitHub side of repos and posting, using the App's installation on the org. */
export function createRepoGitHub(config: Config): RepoGitHub {
  const cfg = config.githubApp;
  if (!cfg) throw new Error("The GitHub App isn't set up yet.");
  const octokit = () => orgOctokit(cfg, config.org);

  return {
    async installationId() {
      const installation = await getOrgInstallation(cfg, config.org);
      if (!installation) throw new AppNotInstalledError(config.org);
      return installation.id;
    },

    async listRepos() {
      const kit = await octokit();
      const repos = await kit.paginate("GET /installation/repositories", { per_page: 100 });
      return (repos as RawRepo[]).map(toRepo);
    },

    async getRepo(id) {
      const kit = await octokit();
      try {
        const { data } = await kit.request("GET /repositories/{id}", { id });
        return toRepo(data as RawRepo);
      } catch (err) {
        if (isStatus(err, 404)) return null;
        throw err;
      }
    },

    async permission(fullName, login): Promise<RepoPermission> {
      const kit = await octokit();
      try {
        const { data } = await kit.request(
          "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
          { ...splitName(fullName), username: login },
        );
        // role_name is the precise role (maintain, triage); permission is the legacy summary.
        const role = (data as { role_name?: string }).role_name;
        if (role === "maintain" || role === "triage") return role;
        const p = data.permission;
        return p === "admin" || p === "write" || p === "read" ? p : "none";
      } catch (err) {
        if (isStatus(err, 404)) return "none";
        throw err;
      }
    },

    async listWorkflows(fullName, ref) {
      const kit = await octokit();
      try {
        const { data } = await kit.request("GET /repos/{owner}/{repo}/contents/{path}", {
          ...splitName(fullName),
          path: ".github/workflows",
          ref,
        });
        return Array.isArray(data) ? data.filter((f) => f.type === "file").map((f) => f.name) : [];
      } catch (err) {
        if (isStatus(err, 404)) return [];
        throw err;
      }
    },

    async readFile(fullName, path, ref) {
      const kit = await octokit();
      try {
        const { data } = await kit.request("GET /repos/{owner}/{repo}/contents/{path}", {
          ...splitName(fullName),
          path,
          ref,
        });
        if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
        return { text: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
      } catch (err) {
        if (isStatus(err, 404)) return null;
        throw err;
      }
    },

    async tree(fullName, ref) {
      const kit = await octokit();
      const { data } = await kit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        ...splitName(fullName),
        tree_sha: ref,
        recursive: "1",
      });
      return {
        paths: data.tree.filter((e) => e.type === "blob" && e.path).map((e) => e.path as string),
        truncated: Boolean(data.truncated),
      };
    },

    async getPullRequest(fullName, number) {
      const kit = await octokit();
      try {
        const { data } = await kit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          ...splitName(fullName),
          pull_number: number,
        });
        return toPullRequest(data as RawPull);
      } catch (err) {
        if (isStatus(err, 404)) return null;
        throw err;
      }
    },

    async listPullRequestFiles(fullName, number) {
      const kit = await octokit();
      const files = await kit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
        ...splitName(fullName),
        pull_number: number,
        per_page: 100,
      });
      return files.map((f) => ({
        path: f.filename,
        previousPath: f.previous_filename ?? undefined,
        additions: f.additions,
        deletions: f.deletions,
        status: f.status,
        patch: f.patch ?? undefined,
      }));
    },

    async listCheckRuns(fullName, sha) {
      const kit = await octokit();
      const runs = await kit.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        ...splitName(fullName),
        ref: sha,
        filter: "latest",
        per_page: 100,
      });
      return runs.map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion ?? null }));
    },

    async listCommitStatuses(fullName, sha) {
      const kit = await octokit();
      const { data } = await kit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", {
        ...splitName(fullName),
        ref: sha,
        per_page: 100,
      });
      return data.statuses.map((s) => ({ context: s.context, state: s.state }));
    },

    async createCheckRun(fullName, name, run) {
      const kit = await octokit();
      const { data } = await kit.request("POST /repos/{owner}/{repo}/check-runs", {
        ...splitName(fullName),
        name,
        head_sha: run.headSha,
        status: run.status,
        ...(run.conclusion ? { conclusion: run.conclusion } : {}),
        output: { title: run.title, summary: run.summary },
      });
      return Number(data.id);
    },

    async updateCheckRun(fullName, id, run) {
      const kit = await octokit();
      await kit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        ...splitName(fullName),
        check_run_id: id,
        status: run.status,
        ...(run.conclusion ? { conclusion: run.conclusion } : {}),
        output: { title: run.title, summary: run.summary },
      });
    },

    async closePullRequest(fullName, number, comment) {
      const kit = await octokit();
      await kit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        ...splitName(fullName),
        issue_number: number,
        body: comment,
      });
      await kit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...splitName(fullName),
        pull_number: number,
        state: "closed",
      });
    },

    async listIssueComments(fullName, number) {
      const kit = await octokit();
      const comments = await kit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        ...splitName(fullName),
        issue_number: number,
        per_page: 100,
      });
      return comments.map((c) => ({ id: Number(c.id), body: c.body ?? "", author: c.user?.login ?? "ghost" }));
    },

    async pullsForCommit(fullName, sha) {
      const kit = await octokit();
      try {
        const { data } = await kit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
          ...splitName(fullName),
          commit_sha: sha,
          per_page: 100,
        });
        return data.map((p) => p.number);
      } catch (err) {
        if (isStatus(err, 404) || isStatus(err, 422)) return [];
        throw err;
      }
    },
  };
}

type RawPull = {
  number: number;
  title: string;
  body: string | null;
  draft?: boolean;
  state: string;
  merged?: boolean;
  merged_by?: { login: string } | null;
  merge_commit_sha?: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
  user: { login: string } | null;
  html_url: string;
};

const toPullRequest = (p: RawPull): PullRequest => ({
  number: p.number,
  title: p.title,
  body: p.body,
  draft: Boolean(p.draft),
  state: p.state === "closed" ? "closed" : "open",
  merged: Boolean(p.merged),
  mergedBy: p.merged_by?.login ?? null,
  mergeCommitSha: p.merge_commit_sha ?? null,
  headSha: p.head.sha,
  headRef: p.head.ref,
  baseRef: p.base.ref,
  author: p.user?.login ?? "ghost",
  url: p.html_url,
});

/** The real GitHub side of sign-in, using the App's own OAuth credentials. */
export function createSignInGitHub(config: Config): SignInGitHub {
  const cfg = config.githubApp;
  if (!cfg) throw new Error("The GitHub App isn't set up yet.");
  const org = config.org;

  return {
    async identify(code) {
      const { authentication } = await getApp(cfg).oauth.createToken({ code });
      const user = new Octokit({ auth: authentication.token });
      const { data } = await user.request("GET /user");
      return {
        id: Number(data.id),
        login: data.login,
        name: data.name ?? null,
        avatarUrl: data.avatar_url ?? null,
      };
    },

    async teamMembership(login, teamSlug): Promise<TeamState> {
      const octokit = await orgOctokit(cfg, org);
      try {
        const { data } = await octokit.request(
          "GET /orgs/{org}/teams/{team_slug}/memberships/{username}",
          { org, team_slug: teamSlug, username: login },
        );
        return data.state === "active" ? "active" : "pending";
      } catch (err) {
        if (isStatus(err, 404)) return "none";
        throw err;
      }
    },

    async isOrgOwner(login) {
      const octokit = await orgOctokit(cfg, org);
      try {
        const { data } = await octokit.request(
          "GET /orgs/{org}/memberships/{username}",
          { org, username: login },
        );
        return data.role === "admin" && data.state === "active";
      } catch (err) {
        if (isStatus(err, 404)) return false;
        throw err;
      }
    },
  };
}
