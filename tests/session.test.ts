import { describe, expect, it } from "vitest";
import { createSessionToken, readSessionToken, SESSION_HOURS } from "@/lib/auth/session";

const secret = "a".repeat(40);
const now = new Date("2026-11-23T09:00:00Z");

describe("session cookie", () => {
  it("round-trips the user id", async () => {
    const token = await createSessionToken(42, secret, now);
    expect(await readSessionToken(token, secret, now)).toEqual({ userId: 42 });
  });

  it("expires after one working day", async () => {
    const token = await createSessionToken(42, secret, now);
    const later = new Date(now.getTime() + (SESSION_HOURS * 3600 + 1) * 1000);
    expect(await readSessionToken(token, secret, later)).toBeNull();
  });

  it("rejects a tampered token or the wrong secret", async () => {
    const token = await createSessionToken(42, secret, now);
    expect(await readSessionToken(token.slice(0, -2) + "xx", secret, now)).toBeNull();
    expect(await readSessionToken(token, "b".repeat(40), now)).toBeNull();
    expect(await readSessionToken(undefined, secret, now)).toBeNull();
  });
});
