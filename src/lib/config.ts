import { z } from "zod";

// All configuration comes from environment variables (see .env.example).

const blankToUndefined = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const configSchema = z.object({
  DATABASE_URL: z.string().min(1, "is required"),
  APP_URL: z.url("must be a full URL like http://localhost:3000"),
  SESSION_SECRET: z
    .string()
    .min(32, "must be at least 32 characters")
    .refine((v) => !v.startsWith("replace-me"), "is still the example value. Generate a real one (see .env.example)"),
  GITHUB_ORG: z.string().min(1, "is required"),
  GITHUB_SIGNIN_TEAM: z.string().min(1, "is required"),
  GITHUB_AI_TEAM: z.string().min(1).default("ai-team"),
  MAIN_ADMIN_GITHUB_LOGIN: z.string().min(1, "is required"),
  SMEE_URL: blankToUndefined,
  GITHUB_APP_ID: blankToUndefined,
  GITHUB_APP_SLUG: blankToUndefined,
  GITHUB_APP_CLIENT_ID: blankToUndefined,
  GITHUB_APP_CLIENT_SECRET: blankToUndefined,
  GITHUB_APP_PRIVATE_KEY: blankToUndefined,
  GITHUB_APP_WEBHOOK_SECRET: blankToUndefined,
});

export type GitHubAppConfig = {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
};

export type Config = {
  appUrl: string;
  sessionSecret: string;
  org: string;
  signInTeam: string;
  aiTeam: string;
  mainAdminLogin: string;
  smeeUrl: string | undefined;
  /** Null until the GitHub App is registered through the setup page. */
  githubApp: GitHubAppConfig | null;
};

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Pitch In configuration problems:\n  - ${problems.join("\n  - ")}`);
  }
}

/** Accepts the PEM itself (with real or \n line breaks) or the base64 form the setup page prints. */
export function decodePrivateKey(value: string): string {
  if (value.includes("-----BEGIN")) return value.replace(/\\n/g, "\n");
  return Buffer.from(value, "base64").toString("utf8");
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`),
    );
  }
  const e = result.data;

  const appParts = [
    e.GITHUB_APP_ID,
    e.GITHUB_APP_SLUG,
    e.GITHUB_APP_CLIENT_ID,
    e.GITHUB_APP_CLIENT_SECRET,
    e.GITHUB_APP_PRIVATE_KEY,
    e.GITHUB_APP_WEBHOOK_SECRET,
  ];
  const appSet = appParts.filter(Boolean).length;
  if (appSet > 0 && appSet < appParts.length) {
    throw new ConfigError([
      "GITHUB_APP_* values are only partly filled in. Paste all six lines from the setup page, or leave all of them blank.",
    ]);
  }

  return {
    appUrl: e.APP_URL.replace(/\/+$/, ""),
    sessionSecret: e.SESSION_SECRET,
    org: e.GITHUB_ORG,
    signInTeam: e.GITHUB_SIGNIN_TEAM,
    aiTeam: e.GITHUB_AI_TEAM,
    mainAdminLogin: e.MAIN_ADMIN_GITHUB_LOGIN,
    smeeUrl: e.SMEE_URL,
    githubApp:
      appSet === 0
        ? null
        : {
            appId: e.GITHUB_APP_ID!,
            slug: e.GITHUB_APP_SLUG!,
            clientId: e.GITHUB_APP_CLIENT_ID!,
            clientSecret: e.GITHUB_APP_CLIENT_SECRET!,
            privateKey: decodePrivateKey(e.GITHUB_APP_PRIVATE_KEY!),
            webhookSecret: e.GITHUB_APP_WEBHOOK_SECRET!,
          },
  };
}

let cached: Config | undefined;

export function getConfig(): Config {
  cached ??= parseConfig(process.env);
  return cached;
}
