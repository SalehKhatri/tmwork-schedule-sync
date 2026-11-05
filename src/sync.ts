/**
 * Syncs a work schedule from TeamWork / ScheduleSource (tmwork.net) into an
 * ICS calendar file, published to a GitHub Gist so it can be subscribed to
 * from Outlook (or any calendar app that supports "subscribe from URL").
 *
 * See README.md for one-time setup (Gist, PAT, ntfy topic, secrets).
 */

import { login } from "./lib/tmwork-login.js";

const TMWORK_BASE = "https://www.tmwork.net/api/shift/emplist";
const GIST_FILENAME = "job1-schedule.ics";

interface Shift {
  Id: number;
  Title: string;
  Start: string; // e.g. "2026-09-02T00:00:00"
  End: string;
  LocName: string;
  StnName: string;
  Notes: string;
  IsApproved: boolean;
  // The real response has more fields; we only use the ones above.
  [key: string]: unknown;
}

class AuthExpiredError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

async function fetchShifts(date1: string, cookie: string, apiToken: string): Promise<Shift[]> {
  const url = `${TMWORK_BASE}?date1=${date1}&range=month`;
  const res = await fetch(url, {
    headers: { Cookie: cookie, "X-Api-Token": apiToken },
  });

  if (res.status === 401 || res.status === 403) {
    throw new AuthExpiredError(
      `tmwork rejected the session cookie/API token (HTTP ${res.status}) — they've almost certainly expired. Grab both fresh from dev tools together.`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`tmwork request failed: HTTP ${res.status} ${body}`);
  }

  return (await res.json()) as Shift[];
}

/** Escapes text per RFC 5545 (backslash, comma, semicolon, newline). */
function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/** "2026-09-02T00:00:00" -> "20260902T000000" (floating local time, no TZID). */
function toIcsDateTime(isoLocal: string): string {
  return isoLocal.replace(/[-:]/g, "").split(".")[0];
}

function toIcsUtcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function buildIcs(shifts: Shift[]): string {
  const now = toIcsUtcStamp(new Date());

  const events = shifts.map((shift) => {
    const location = escapeIcsText(`${shift.StnName}, ${shift.LocName}`);
    const description = escapeIcsText(
      `Approved: ${shift.IsApproved ? "yes" : "no"}${shift.Notes ? `\nNotes: ${shift.Notes}` : ""}`,
    );

    return [
      "BEGIN:VEVENT",
      `UID:${shift.Id}@tmwork.net`,
      `DTSTAMP:${now}`,
      `DTSTART:${toIcsDateTime(shift.Start)}`,
      `DTEND:${toIcsDateTime(shift.End)}`,
      `SUMMARY:${escapeIcsText(shift.Title)}`,
      `LOCATION:${location}`,
      `DESCRIPTION:${description}`,
      "END:VEVENT",
    ].join("\r\n");
  });

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tmwork-schedule-sync//EN",
    "CALSCALE:GREGORIAN",
    // Hints to subscribed-calendar clients (Outlook, etc.) that they can
    // poll this feed more often than their default interval. Not every
    // client honors it, and those that do may still enforce their own
    // floor, but it's a no-cost nudge toward fresher data without any
    // manual re-subscribe.
    "X-PUBLISHED-TTL:PT30M",
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n") + "\r\n";
}

async function pushToGist(gistId: string, token: string, icsContent: string): Promise<void> {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "tmwork-schedule-sync",
    },
    body: JSON.stringify({
      files: {
        [GIST_FILENAME]: { content: icsContent },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to update gist: HTTP ${res.status} ${body}`);
  }
}

/** Best-effort push notification. Never throws — a notification failure
 * should never mask (or cause) a run failure. */
async function notify(message: string): Promise<void> {
  try {
    const topic = process.env.NTFY_TOPIC;
    if (!topic) {
      console.error("NTFY_TOPIC not set; skipping notification");
      return;
    }
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      body: message,
    });
  } catch (err) {
    console.error("Failed to send ntfy notification:", err);
  }
}

/** Same as buildIcs output but with the per-run DTSTAMP lines removed, so two
 * feeds with identical shifts compare equal. */
function stripVolatile(ics: string): string {
  // Normalize line endings too, in case the gist round-trip changes CRLF.
  return ics.replace(/\r\n/g, "\n").replace(/^DTSTAMP:.*\n/gm, "");
}

async function fetchCurrentGistFile(gistId: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "tmwork-schedule-sync",
      },
    });
    if (!res.ok) return null;
    const gist = (await res.json()) as { files?: Record<string, { content?: string; truncated?: boolean }> };
    const file = gist.files?.[GIST_FILENAME];
    if (!file || file.truncated) return null;
    return file.content ?? null;
  } catch {
    return null; // can't compare -> just push
  }
}

/**
 * Logs in fresh every run (cookie + api token are minted per login and expire
 * quickly), so there's no stored session to go stale and no separate
 * refresh-auth job. Falls back to TMWORK_COOKIE/TMWORK_API_TOKEN only when
 * login credentials aren't configured.
 */
async function getSession(): Promise<{ cookie: string; apiToken: string }> {
  const { TMWORK_CODE, TMWORK_USER, TMWORK_PASSWORD } = process.env;
  if (TMWORK_CODE && TMWORK_USER && TMWORK_PASSWORD) {
    try {
      return await login(TMWORK_CODE, TMWORK_USER, TMWORK_PASSWORD);
    } catch (err) {
      throw new AuthExpiredError(err instanceof Error ? err.message : String(err));
    }
  }
  return { cookie: requireEnv("TMWORK_COOKIE"), apiToken: requireEnv("TMWORK_API_TOKEN") };
}

async function main(): Promise<void> {
  const gistId = requireEnv("GIST_ID");
  const gistToken = requireEnv("GIST_TOKEN");
  const { cookie, apiToken } = await getSession();

  const today = new Date();
  const rangeStarts = [0, 7, 14].map((offset) => formatDate(addDays(today, offset)));

  const shiftsById = new Map<number, Shift>();
  for (const date1 of rangeStarts) {
    const shifts = await fetchShifts(date1, cookie, apiToken);
    for (const shift of shifts) {
      shiftsById.set(shift.Id, shift);
    }
  }

  const allShifts = [...shiftsById.values()].sort((a, b) => a.Start.localeCompare(b.Start));
  const ics = buildIcs(allShifts);

  const current = await fetchCurrentGistFile(gistId, gistToken);
  if (current !== null && stripVolatile(current) === stripVolatile(ics)) {
    console.log(`No changes (${allShifts.length} shifts); gist left as-is`);
    return;
  }

  await pushToGist(gistId, gistToken, ics);
  console.log(`Synced ${allShifts.length} shifts to gist ${gistId}`);
}

main().catch(async (err: unknown) => {
  const isAuthError = err instanceof AuthExpiredError;
  const detail = err instanceof Error ? err.message : String(err);
  const message = isAuthError
    ? `tmwork-schedule-sync: tmwork auth failed -- check the TMWORK_CODE/TMWORK_USER/TMWORK_PASSWORD secrets. (${detail})`
    : `tmwork-schedule-sync: sync failed. ${detail}`;

  console.error(message);
  await notify(message);
  // Exit code 2 = auth problem, 1 = anything else (kept distinct for logs).
  process.exit(isAuthError ? 2 : 1);
});
