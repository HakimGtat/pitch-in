import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { cookieOptions, OAUTH_STATE_COOKIE } from "@/lib/auth/current-user";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Starts GitHub sign-in with the Pitch In GitHub App's own OAuth credentials. */
export async function GET() {
  const config = getConfig();
  if (!config.githubApp) {
    return NextResponse.redirect(new URL("/setup", config.appUrl));
  }

  const state = randomBytes(16).toString("hex");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.githubApp.clientId);
  url.searchParams.set("redirect_uri", `${config.appUrl}/api/auth/github/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");

  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_STATE_COOKIE, state, cookieOptions(config.appUrl, 600, "/api/auth/github"));
  return res;
}
