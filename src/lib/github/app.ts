import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import type { Config, GitHubAppConfig } from "../config";
import type { SignInGitHub, TeamState } from "../auth/signin";

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
