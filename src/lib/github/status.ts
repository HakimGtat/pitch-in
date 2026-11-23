import type { Config } from "../config";
import { getOrgInstallation } from "./app";

export type GitHubStatus = {
  smeeConfigured: boolean;
  app: null | {
    slug: string;
    settingsUrl: string;
    installUrl: string;
    /** null when GitHub couldn't be reached. */
    installed: boolean | null;
  };
};

/** What the setup and admin screens show about the GitHub App. */
export async function getGitHubStatus(config: Config): Promise<GitHubStatus> {
  const smeeConfigured = Boolean(config.smeeUrl);
  if (!config.githubApp) return { smeeConfigured, app: null };

  const { slug } = config.githubApp;
  let installed: boolean | null = null;
  try {
    installed = Boolean(await getOrgInstallation(config.githubApp, config.org));
  } catch (err) {
    console.error("[github] Couldn't check the App installation:", err);
  }
  return {
    smeeConfigured,
    app: {
      slug,
      settingsUrl: `https://github.com/organizations/${config.org}/settings/apps/${slug}`,
      installUrl: `https://github.com/apps/${slug}/installations/new`,
      installed,
    },
  };
}
