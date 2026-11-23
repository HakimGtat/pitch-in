import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getConfig } from "../config";
import { getDb } from "../db/client";
import { users, type User } from "../db/schema";
import { isAdmin } from "../permissions";
import { readSessionToken, SESSION_COOKIE, SESSION_HOURS } from "./session";

export const OAUTH_STATE_COOKIE = "pitchin_oauth_state";

export function cookieOptions(appUrl: string, maxAgeSeconds: number, path = "/") {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: appUrl.startsWith("https://"),
    path,
    maxAge: maxAgeSeconds,
  };
}

export const sessionCookieOptions = (appUrl: string) =>
  cookieOptions(appUrl, SESSION_HOURS * 3600);

/** The signed-in person, or null. Blocked people count as signed out. Cached per request. */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const config = getConfig();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await readSessionToken(token, config.sessionSecret);
  if (!session) return null;
  const [user] = await getDb()
    .select()
    .from(users)
    .where(eq(users.id, session.userId));
  if (!user || user.blocked) return null;
  return user;
});

export async function requireUser(
  opts: { allowNoProfile?: boolean } = {},
): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  if (!opts.allowNoProfile && !user.profile) redirect("/welcome");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (!isAdmin(user)) redirect("/");
  return user;
}
