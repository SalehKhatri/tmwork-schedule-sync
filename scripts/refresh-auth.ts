/**
 * One-command re-auth: logs into tmwork.net with stored credentials, grabs a
 * fresh session cookie AND a fresh api token, validates the pair against the
 * emplist API, and pushes both straight to their GitHub Actions secrets via
 * `gh secret set`.
 *
 * Both are minted per login: the cookie comes from the login response's
 * Set-Cookie headers, and the api token comes from a global `APP.Token = "...
 * "` assignment embedded in the post-login /emp/ page (confirmed by testing
 * -- an old api token paired with a freshly logged-in cookie gets a 401, so
 * it's tied to the session, not a static value).
 *
 * Credentials come from either .env.local (local runs -- gitignored, never
 * committed, see .env.local.example) or repo secrets (CI runs). Pushing the
 * refreshed secrets requires a `gh`-authenticated identity with permission to
 * write Actions secrets on this repo: locally that's your own `gh auth
 * login` session; in CI it's the SECRETS_ADMIN_TOKEN secret passed in as
 * GH_TOKEN (see .github/workflows/sync.yml and README).
 *
 * Local run: npm run refresh-auth
 * CI run: triggered automatically by the refresh-auth job in
 * .github/workflows/sync.yml when the sync job exits with code 2
 * (AuthExpiredError) -- see src/sync.ts. In CI, both fresh values are also
 * written to $GITHUB_ENV so the workflow's very next step (an immediate
 * retry of sync.ts) can use them without waiting for the GitHub secrets we
 * just pushed to become visible to a new job.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { login } from "../src/lib/tmwork-login.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvLocal(): void {
  const envPath = path.join(REPO_ROOT, ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} -- set it in .env.local (see .env.local.example)`);
  }
  return value;
}

/**
 * Exposes fresh values to later steps in the same CI job, via $GITHUB_ENV,
 * so an immediate retry of sync.ts doesn't have to wait for the (now-stale)
 * secrets to refresh on the next run. No-op outside of GitHub Actions (e.g.
 * local `npm run refresh-auth`).
 */
function exposeToCiJobEnv(values: Record<string, string>): void {
  if (!process.env.GITHUB_ENV) return;
  for (const [name, value] of Object.entries(values)) {
    console.log("::add-mask::" + value); // keep it out of any later log output too
    const delimiter = `${name}_${randomUUID()}`;
    appendFileSync(process.env.GITHUB_ENV, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}

function getRepoSlug(): string {
  // GitHub Actions sets this automatically; prefer it there over parsing
  // the local git remote (which the checkout step configures differently).
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;

  const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT }).toString().trim();
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/);
  if (!match) throw new Error(`Couldn't parse a GitHub repo slug from remote URL: ${url}`);
  return `${match[1]}/${match[2]}`;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const code = requireEnv("TMWORK_CODE");
  const user = requireEnv("TMWORK_USER");
  const password = requireEnv("TMWORK_PASSWORD");

  console.log("Logging in and validating a fresh cookie + api token...");
  const { cookie: newCookie, apiToken: newApiToken } = await login(code, user, password);

  exposeToCiJobEnv({ TMWORK_COOKIE: newCookie, TMWORK_API_TOKEN: newApiToken });

  console.log("Pushing fresh TMWORK_COOKIE and TMWORK_API_TOKEN secrets...");
  const repo = getRepoSlug();
  execFileSync("gh", ["secret", "set", "TMWORK_COOKIE", "--repo", repo, "--body", newCookie], {
    stdio: "inherit",
  });
  execFileSync("gh", ["secret", "set", "TMWORK_API_TOKEN", "--repo", repo, "--body", newApiToken], {
    stdio: "inherit",
  });

  console.log("Done. TMWORK_COOKIE and TMWORK_API_TOKEN refreshed and pushed.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
