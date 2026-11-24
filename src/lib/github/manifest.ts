import { createHmac, timingSafeEqual } from "node:crypto";

// GitHub App manifest flow: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
// The setup page posts this manifest to GitHub, the admin confirms on GitHub,
// and GitHub redirects back with a one-time code that we swap for the App's keys.

export type GitHubAppManifest = {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  public: boolean;
  request_oauth_on_install: boolean;
  default_permissions: Record<string, "read" | "write">;
  default_events: string[];
};

const MAX_APP_NAME = 34; // GitHub's limit for App names

export function buildManifest(opts: {
  appUrl: string;
  smeeUrl: string;
  org: string;
}): GitHubAppManifest {
  return {
    // App names are unique across GitHub, so include the org. GitHub lets the admin edit it.
    name: `Pitch In ${opts.org}`.slice(0, MAX_APP_NAME),
    url: opts.appUrl,
    description: "Pick up part of a coworker's project.",
    hook_attributes: { url: opts.smeeUrl, active: true },
    redirect_url: `${opts.appUrl}/setup/callback`,
    callback_urls: [`${opts.appUrl}/api/auth/github/callback`],
    setup_url: `${opts.appUrl}/setup`,
    public: false,
    request_oauth_on_install: false,
    default_permissions: {
      contents: "read",
      metadata: "read",
      statuses: "read",
      members: "read",
      pull_requests: "write",
      checks: "write",
    },
    // installation events are always sent; these are the extra ones.
    default_events: ["pull_request", "check_suite", "push"],
  };
}

export function manifestFormAction(org: string, state: string): string {
  return `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
}

const sign = (secret: string, value: string) =>
  createHmac("sha256", secret).update(`setup:${value}`).digest("hex");

/** A signed timestamp, so the callback only accepts flows this site started. */
export function createSetupState(secret: string, now: Date = new Date()): string {
  const ts = String(now.getTime());
  return `${ts}.${sign(secret, ts)}`;
}

export function verifySetupState(
  state: string | null | undefined,
  secret: string,
  now: Date = new Date(),
  maxAgeMs = 60 * 60 * 1000,
): boolean {
  if (!state) return false;
  const [ts, mac] = state.split(".");
  if (!ts || !mac || !/^\d+$/.test(ts)) return false;
  const expected = Buffer.from(sign(secret, ts));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return false;
  const age = now.getTime() - Number(ts);
  return age >= 0 && age <= maxAgeMs;
}

export type ManifestConversion = {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
  html_url: string;
  owner?: { login: string };
};

export async function convertManifestCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManifestConversion> {
  if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("Invalid code from GitHub.");
  const res = await fetchImpl(
    `https://api.github.com/app-manifests/${code}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub didn't accept the setup code (HTTP ${res.status}). Codes work once and expire after an hour, so start the setup again.`,
    );
  }
  return (await res.json()) as ManifestConversion;
}

/** The lines the admin pastes into .env. The private key is base64 so it fits on one line. */
export function envLinesFor(conv: ManifestConversion): string {
  return [
    `GITHUB_APP_ID=${conv.id}`,
    `GITHUB_APP_SLUG=${conv.slug}`,
    `GITHUB_APP_CLIENT_ID=${conv.client_id}`,
    `GITHUB_APP_CLIENT_SECRET=${conv.client_secret}`,
    `GITHUB_APP_WEBHOOK_SECRET=${conv.webhook_secret}`,
    `GITHUB_APP_PRIVATE_KEY=${Buffer.from(conv.pem, "utf8").toString("base64")}`,
  ].join("\n");
}
