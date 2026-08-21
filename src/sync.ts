/**
 * Syncs a work schedule from TeamWork / ScheduleSource (tmwork.net) into an
 * ICS calendar file, published to a GitHub Gist so it can be subscribed to
 * from Outlook (or any calendar app that supports "subscribe from URL").
 *
 * See README.md for one-time setup (Gist, PAT, ntfy topic, secrets).
 */

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

async function main(): Promise<void> {
  const cookie = requireEnv("TMWORK_COOKIE");
  const apiToken = requireEnv("TMWORK_API_TOKEN");
  const gistId = requireEnv("GIST_ID");
  const gistToken = requireEnv("GIST_TOKEN");

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

  await pushToGist(gistId, gistToken, ics);
  console.log(`Synced ${allShifts.length} shifts to gist ${gistId}`);
}

main().catch(async (err: unknown) => {
  const isAuthError = err instanceof AuthExpiredError;
  const detail = err instanceof Error ? err.message : String(err);
  const message = isAuthError
    ? `tmwork-schedule-sync: TMWORK_COOKIE has expired. Grab a fresh one from browser dev tools and update the repo secret. (${detail})`
    : `tmwork-schedule-sync: sync failed. ${detail}`;

  console.error(message);
  await notify(message);
  // Exit code 2 specifically means "auth expired" -- the refresh-auth job in
  // the workflow checks for this exact code to decide whether to attempt an
  // automated re-login. Any other failure exits 1 and is left alone.
  process.exit(isAuthError ? 2 : 1);
});
