/**
 * Shared tmwork.net login flow: exchanges TMWORK_CODE/TMWORK_USER/TMWORK_PASSWORD
 * for a fresh session cookie + api token. Extracted out of scripts/refresh-auth.ts
 * so that any long-running script (e.g. src/claim-shifts.ts) can self-heal an
 * expired session in-process without duplicating this scraping logic -- there's
 * only one place to fix if tmwork changes its login page.
 *
 * Both values are minted per login (not static): the cookie comes from the
 * login response's Set-Cookie headers, and the api token is embedded as
 * `APP.Token = "...";` in the post-login /emp/ page's inline script.
 */

export interface TmworkSession {
  cookie: string;
  apiToken: string;
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

export async function login(code: string, user: string, password: string): Promise<TmworkSession> {
  const jar = new Map<string, string>();

  const signInRes = await fetch("https://www.tmwork.net/signin-emp");
  if (!signInRes.ok) {
    throw new Error(`Failed to load the sign-in page: HTTP ${signInRes.status}`);
  }
  mergeCookies(jar, signInRes.headers.getSetCookie());

  const signInHtml = await signInRes.text();
  const verificationTokenMatch = signInHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!verificationTokenMatch) {
    throw new Error(
      "Couldn't find __RequestVerificationToken on the sign-in page -- tmwork may have changed its login form.",
    );
  }

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
      __RequestVerificationToken: verificationTokenMatch[1],
    }),
  });
  mergeCookies(jar, loginRes.headers.getSetCookie());
  // A successful login redirects (3xx). A rejected one re-renders the
  // sign-in page (200) with "Sign In failed" -- catch that here rather than
  // letting it surface later as a confusing "couldn't find APP.Token".
  if (loginRes.status < 300 || loginRes.status >= 400) {
    const body = await loginRes.text().catch(() => "");
    if (/Sign In failed/i.test(body)) {
      throw new Error(
        "tmwork rejected the login (\"Sign In failed\") -- TMWORK_CODE/TMWORK_USER/TMWORK_PASSWORD are wrong or the password changed.",
      );
    }
  }
  const cookie = cookieHeader(jar);

  // The api token isn't returned as a header or cookie -- it's embedded as
  // `APP.Token = "...";` in the post-login /emp/ page's inline script, and
  // some shared JS elsewhere attaches it as the X-Api-Token header on API
  // calls. Fetch that page with our new cookie and pull it out directly.
  const dashRes = await fetch("https://www.tmwork.net/emp/", { headers: { Cookie: cookie } });
  if (!dashRes.ok) {
    throw new Error(
      `Login appears to have failed: sign-in returned HTTP ${loginRes.status}, but /emp/ returned HTTP ${dashRes.status}. ` +
        "Double check TMWORK_CODE/TMWORK_USER/TMWORK_PASSWORD.",
    );
  }
  const dashHtml = await dashRes.text();
  const apiTokenMatch = dashHtml.match(/APP\.Token\s*=\s*["']([^"']+)["']/);
  if (!apiTokenMatch) {
    throw new Error(
      "Logged in, but couldn't find APP.Token on the /emp/ page -- tmwork may have changed where the api token lives.",
    );
  }
  const apiToken = apiTokenMatch[1];

  const checkRes = await fetch(
    `https://www.tmwork.net/api/shift/emplist?date1=${new Date().toISOString().slice(0, 10)}&range=month`,
    { headers: { Cookie: cookie, "X-Api-Token": apiToken } },
  );
  if (!checkRes.ok) {
    throw new Error(`New cookie + api token still got HTTP ${checkRes.status} from emplist -- something else changed.`);
  }

  return { cookie, apiToken };
}
