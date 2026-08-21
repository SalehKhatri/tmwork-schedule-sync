/**
 * One-command re-auth: logs into tmwork.net with stored credentials, grabs a
 * fresh session cookie, validates it against the emplist API, and pushes it
 * straight to the GitHub Actions secret via `gh secret set`.
 *
 * Does NOT touch TMWORK_API_TOKEN. That value appears to be static (not tied
 * to the session) rather than something that rotates on login, so it
 * shouldn't need refreshing here. If a sync still fails right after a
 * successful run of this script, the api token may have changed after all --
 * grab a fresh one from dev tools once (see README) and update that secret
 * by hand.
 *
 * Credentials come from either .env.local (local runs -- gitignored, never
 * committed, see .env.local.example) or repo secrets (CI runs). Pushing the
 * refreshed secret requires a `gh`-authenticated identity with permission to
 * write Actions secrets on this repo: locally that's your own `gh auth
 * login` session; in CI it's the SECRETS_ADMIN_TOKEN secret passed in as
 * GH_TOKEN (see .github/workflows/sync.yml and README).
 *
 * Local run: npm run refresh-auth
 * CI run: triggered automatically by the refresh-auth job in
 * .github/workflows/sync.yml when the sync job exits with code 2
 * (AuthExpiredError) -- see src/sync.ts. In CI, the fresh cookie is also
 * written to $GITHUB_ENV so the workflow's very next step (an immediate
 * retry of sync.ts) can use it without waiting for the GitHub secret we
 * just pushed to become visible to a new job.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Folds Set-Cookie response headers into a name -> value jar, overwriting on repeats. */
function mergeCookies(jar: Map<string, string>, setCookieHeaders: string[]): void {
  for (const raw of setCookieHeaders) {
    const pair = raw.split(";")[0]; // drop attributes like Path=/, HttpOnly, Secure
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Exposes the fresh cookie to later steps in the same CI job, via
 * $GITHUB_ENV, so an immediate retry of sync.ts doesn't have to wait for
 * the (now-stale) `secrets.TMWORK_COOKIE` to refresh on the next run.
 * No-op outside of GitHub Actions (e.g. local `npm run refresh-auth`).
 */
function exposeToCiJobEnv(cookie: string): void {
  if (!process.env.GITHUB_ENV) return;
  console.log("::add-mask::" + cookie); // keep it out of any later log output too
  const delimiter = `TMWORK_COOKIE_${randomUUID()}`;
  appendFileSync(process.env.GITHUB_ENV, `TMWORK_COOKIE<<${delimiter}\n${cookie}\n${delimiter}\n`);
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
  const apiToken = requireEnv("TMWORK_API_TOKEN"); // only used here to validate the new cookie

  const jar = new Map<string, string>();

  console.log("Fetching sign-in page...");
  const signInRes = await fetch("https://www.tmwork.net/signin-emp");
  if (!signInRes.ok) {
    throw new Error(`Failed to load the sign-in page: HTTP ${signInRes.status}`);
  }
  mergeCookies(jar, signInRes.headers.getSetCookie());

  const html = await signInRes.text();
  const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!tokenMatch) {
    throw new Error(
      "Couldn't find __RequestVerificationToken on the sign-in page -- tmwork may have changed its login form.",
    );
  }

  console.log("Logging in...");
  const loginRes = await fetch("https://www.tmwork.net/SignIn-Emp?handler=EmpLogin", {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(jar),
    },
    body: new URLSearchParams({
      portal: "emp",
      EmpCode: code,
      EmpUser: user,
      EmpPassword: password,
      __RequestVerificationToken: tokenMatch[1],
    }),
  });
  mergeCookies(jar, loginRes.headers.getSetCookie());
  console.log(
    `Login response: HTTP ${loginRes.status}, Location: ${loginRes.headers.get("location") ?? "(none)"}`,
  );
  // Names only -- never log cookie values, they're session credentials.
  console.log(`Cookies held after login: ${[...jar.keys()].join(", ")}`);

  const newCookie = cookieHeader(jar);

  // TEMP DIAGNOSTIC: the api token may not be static after all (login
  // clearly succeeds -- see Location above -- but the old token still gets
  // rejected). Fetch the post-login SPA shell and look for anything
  // token-shaped embedded in it. Logs key names/lengths only, never values.
  const dashRes = await fetch("https://www.tmwork.net/emp/", { headers: { Cookie: newCookie } });
  const dashHtml = await dashRes.text();
  console.log(`[diag] /emp/ fetch: HTTP ${dashRes.status}, body length ${dashHtml.length}`);
  const tokenMatches = [...dashHtml.matchAll(/([a-zA-Z0-9_-]{0,24}[Tt]oken[a-zA-Z0-9_-]{0,24})["']?\s*[:=]\s*["']([^"']{8,100})["']/g)];
  if (tokenMatches.length === 0) {
    console.log("[diag] no token-shaped strings found in /emp/ body");
  }
  for (const m of tokenMatches.slice(0, 15)) {
    console.log(`[diag] candidate key="${m[1]}" valueLength=${m[2].length} prefix="${m[2].slice(0, 6)}..."`);
  }

  // Razor Pages login handlers can either redirect (302) or re-render the
  // form (200) on failure -- rather than guess which, treat the actual
  // emplist call as the source of truth for whether login worked.
  console.log("Validating the new cookie against the emplist API...");
  const today = new Date().toISOString().slice(0, 10);
  const checkRes = await fetch(`https://www.tmwork.net/api/shift/emplist?date1=${today}&range=month`, {
    headers: { Cookie: newCookie, "X-Api-Token": apiToken },
  });
  if (!checkRes.ok) {
    throw new Error(
      `Login appears to have failed (sign-in returned HTTP ${loginRes.status}, emplist check returned HTTP ${checkRes.status}). ` +
        "Double check TMWORK_CODE/TMWORK_USER/TMWORK_PASSWORD in .env.local. If those are right, TMWORK_API_TOKEN may have " +
        "expired too -- grab a fresh one from dev tools (see README) and update that secret by hand.",
    );
  }

  exposeToCiJobEnv(newCookie);

  console.log("Pushing the fresh cookie to the TMWORK_COOKIE GitHub secret...");
  const repo = getRepoSlug();
  execFileSync("gh", ["secret", "set", "TMWORK_COOKIE", "--repo", repo, "--body", newCookie], {
    stdio: "inherit",
  });

  console.log("Done. TMWORK_COOKIE refreshed and pushed. (TMWORK_API_TOKEN left untouched.)");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
