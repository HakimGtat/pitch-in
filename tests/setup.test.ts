import { describe, expect, it } from "vitest";
import { ConfigError, decodePrivateKey, parseConfig } from "@/lib/config";
import {
  buildManifest,
  convertManifestCode,
  createSetupState,
  envLinesFor,
  manifestFormAction,
  verifySetupState,
} from "@/lib/github/manifest";

const secret = "s".repeat(40);
const now = new Date("2026-11-23T12:00:00Z");

describe("GitHub App manifest", () => {
  const manifest = buildManifest({
    appUrl: "http://localhost:3000",
    smeeUrl: "https://smee.io/abc",
    org: "example-org",
  });

  it("sends webhooks to the smee channel and redirects back to this site", () => {
    expect(manifest.hook_attributes).toEqual({ url: "https://smee.io/abc", active: true });
    expect(manifest.redirect_url).toBe("http://localhost:3000/setup/callback");
    expect(manifest.callback_urls).toEqual(["http://localhost:3000/api/auth/github/callback"]);
    expect(manifest.public).toBe(false);
  });

  it("asks for exactly the permissions in the plan", () => {
    expect(manifest.default_permissions).toEqual({
      contents: "read",
      metadata: "read",
      statuses: "read",
      members: "read",
      pull_requests: "write",
      checks: "write",
    });
    expect(manifest.default_events).toEqual(["pull_request", "check_suite", "push"]);
  });

  it("keeps the App name within GitHub's 34-character limit", () => {
    const long = buildManifest({ appUrl: "http://x", smeeUrl: "https://smee.io/a", org: "a-very-long-organization-name-indeed" });
    expect(long.name.length).toBeLessThanOrEqual(34);
  });

  it("posts to the org's new-App page", () => {
    expect(manifestFormAction("example-org", "1.abc")).toBe(
      "https://github.com/organizations/example-org/settings/apps/new?state=1.abc",
    );
  });
});

describe("setup state", () => {
  it("accepts a fresh state from this site", () => {
    expect(verifySetupState(createSetupState(secret, now), secret, now)).toBe(true);
  });

  it("rejects old, tampered or foreign states", () => {
    const state = createSetupState(secret, now);
    expect(verifySetupState(state, secret, new Date(now.getTime() + 61 * 60_000))).toBe(false);
    const tampered = state.slice(0, -1) + (state.endsWith("0") ? "1" : "0");
    expect(verifySetupState(tampered, secret, now)).toBe(false);
    expect(verifySetupState(state, "t".repeat(40), now)).toBe(false);
    expect(verifySetupState(null, secret, now)).toBe(false);
    expect(verifySetupState("garbage", secret, now)).toBe(false);
  });
});

describe("manifest code conversion", () => {
  const conversion = {
    id: 123,
    slug: "pitch-in-example-org",
    client_id: "Iv1.fake",
    client_secret: "fake-secret",
    webhook_secret: "fake-hook-secret",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n",
    html_url: "https://github.com/apps/pitch-in-example-org",
  };

  it("swaps the code for the App's keys", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify(conversion), { status: 201 });
    }) as unknown as typeof fetch;
    expect(await convertManifestCode("abc123", fakeFetch)).toEqual(conversion);
    expect(calledUrl).toBe("https://api.github.com/app-manifests/abc123/conversions");
  });

  it("refuses odd-looking codes before calling GitHub", async () => {
    await expect(convertManifestCode("../users", fetch)).rejects.toThrow();
  });

  it("prints .env lines that the config reads back", () => {
    const lines = envLinesFor(conversion);
    const env = Object.fromEntries(lines.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const config = parseConfig({ ...baseEnv, ...env });
    expect(config.githubApp).toMatchObject({ appId: "123", slug: "pitch-in-example-org", privateKey: conversion.pem });
  });
});

const baseEnv = {
  DATABASE_URL: "postgres://x:y@localhost:5432/z",
  APP_URL: "http://localhost:3000/",
  SESSION_SECRET: secret,
  GITHUB_ORG: "example-org",
  GITHUB_SIGNIN_TEAM: "wishlist-users",
  MAIN_ADMIN_GITHUB_LOGIN: "boss",
};

describe("config", () => {
  it("works before the GitHub App exists", () => {
    const config = parseConfig(baseEnv);
    expect(config.githubApp).toBeNull();
    expect(config.appUrl).toBe("http://localhost:3000");
    expect(config.aiTeam).toBe("ai-team");
  });

  it("lists every problem at once", () => {
    try {
      parseConfig({ ...baseEnv, SESSION_SECRET: "short", GITHUB_ORG: "" });
      throw new Error("should have failed");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).problems).toHaveLength(2);
    }
  });

  it("refuses half-filled GitHub App settings", () => {
    expect(() => parseConfig({ ...baseEnv, GITHUB_APP_ID: "1" })).toThrow(ConfigError);
  });

  it("reads the private key as base64 or as a PEM with \\n escapes", () => {
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----";
    expect(decodePrivateKey(Buffer.from(pem).toString("base64"))).toBe(pem);
    expect(decodePrivateKey(pem.replace(/\n/g, "\\n"))).toBe(pem);
  });
});
