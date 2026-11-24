import type { GitHubRepo, RepoGitHub } from "@/lib/github/repos";
import type { RepoPermission } from "@/lib/permissions";

/** A pretend GitHub with one org, a few repos and per-person permissions. */
export function fakeGitHub() {
  const world = {
    repos: new Map<number, GitHubRepo>(),
    files: new Map<string, Record<string, string>>(),
    perms: new Map<string, Record<string, RepoPermission>>(),
  };
  const gh: RepoGitHub = {
    installationId: async () => 777,
    listRepos: async () => [...world.repos.values()],
    getRepo: async (id) => world.repos.get(id) ?? null,
    permission: async (fullName, login) => world.perms.get(fullName)?.[login] ?? "none",
    listWorkflows: async (fullName) =>
      Object.keys(world.files.get(fullName) ?? {})
        .filter((p) => p.startsWith(".github/workflows/"))
        .map((p) => p.split("/").pop()!),
    readFile: async (fullName, path) => {
      const text = world.files.get(fullName)?.[path];
      return text === undefined ? null : { text, sha: `sha-${text.length}` };
    },
    tree: async (fullName) => ({ paths: Object.keys(world.files.get(fullName) ?? {}), truncated: false }),
  };
  const addRepo = (id: number, fullName: string, files: Record<string, string>, perms: Record<string, RepoPermission>) => {
    world.repos.set(id, { id, fullName, defaultBranch: "main", private: false, archived: false });
    world.files.set(fullName, files);
    world.perms.set(fullName, perms);
  };
  return { gh, world, addRepo };
}

