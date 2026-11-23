import { NextResponse, type NextRequest } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/current-user";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { completeSignIn } from "@/lib/auth/signin";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { AppNotInstalledError, createSignInGitHub } from "@/lib/github/app";

export const dynamic = "force-dynamic";

/** GitHub sends the person back here after they approve sign-in. */
export async function GET(request: NextRequest) {
  const config = getConfig();
  const to = (path: string) => NextResponse.redirect(new URL(path, config.appUrl));
  const fail = (reason: string) => {
    const res = to(`/?error=${reason}`);
    res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/auth/github" });
    return res;
  };

  if (!config.githubApp) return to("/setup");

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return fail("cancelled");

  const code = params.get("code");
  const state = params.get("state");
  const expected = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!code || !state || !expected || state !== expected) return fail("expired");

  try {
    const result = await completeSignIn(getDb(), createSignInGitHub(config), code, {
      signInTeam: config.signInTeam,
      aiTeam: config.aiTeam,
      mainAdminLogin: config.mainAdminLogin,
    });
    if (!result.ok) {
      console.log(`[signin] Refused @${result.login}: ${result.reason}`);
      return fail(result.reason);
    }

    const res = to(result.needsWelcome ? "/welcome" : "/");
    res.cookies.set(
      SESSION_COOKIE,
      await createSessionToken(result.userId, config.sessionSecret),
      sessionCookieOptions(config.appUrl),
    );
    res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/auth/github" });
    return res;
  } catch (err) {
    if (err instanceof AppNotInstalledError) return fail("app_not_installed");
    console.error("[signin] GitHub check failed:", err);
    return fail("github_error");
  }
}
