// Runs once when the web server starts: fail fast with a clear message if .env is wrong.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { getConfig } = await import("./lib/config");
  try {
    const config = getConfig();
    console.log(
      `[web] Pitch In for ${config.org} at ${config.appUrl}. GitHub App: ${
        config.githubApp ? config.githubApp.slug : "not set up yet, open /setup"
      }`,
    );
  } catch (err) {
    console.error(`[web] ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
