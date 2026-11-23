import { jwtVerify, SignJWT } from "jose";

// A signed cookie that only holds the user id. The user row is loaded on every
// request, so a block takes effect immediately. Sessions last one working day;
// signing in again re-checks GitHub team membership.

export const SESSION_COOKIE = "pitchin_session";
export const SESSION_HOURS = 12;

const key = (secret: string) => new TextEncoder().encode(secret);

export async function createSessionToken(
  userId: number,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_HOURS * 3600)
    .sign(key(secret));
}

export async function readSessionToken(
  token: string | undefined,
  secret: string,
  now: Date = new Date(),
): Promise<{ userId: number } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      currentDate: now,
    });
    return typeof payload.uid === "number" ? { userId: payload.uid } : null;
  } catch {
    return null;
  }
}
