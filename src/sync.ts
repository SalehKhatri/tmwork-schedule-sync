/**
 * Syncs a work schedule from TeamWork / ScheduleSource (tmwork.net) into an
 * ICS calendar file, published to a GitHub Gist so it can be subscribed to
 * from Outlook (or any calendar app that supports "subscribe from URL").
 *
 * See README.md for one-time setup (Gist, PAT, Gmail app password, secrets).
 */

import { sendEmail } from "./lib/email.js";
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

/** Best-effort email alert from your Gmail to yourself. Never throws -- a
 * notification failure should never mask (or cause) a run failure. Never
 * logs the message content either: this repo's Actions logs are public. */
async function notify(subject: string, body: string, urgent = false): Promise<void> {
  const user = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!user || !password) {
    console.error("GMAIL_USER / GMAIL_APP_PASSWORD not set; skipping email alert");
    return;
  }
  try {
    await sendEmail({
      user,
      password: password.replace(/\s+/g, ""), // Google shows app passwords with spaces
      to: process.env.ALERT_EMAIL_TO || user,
      subject,
      body,
      urgent,
    });
    console.log("Email alert sent");
  } catch (err) {
    console.error("Failed to send email alert:", err instanceof Error ? err.message : err);
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

// ---------------------------------------------------------------------------
// Change notifications: diff the previously published feed against the new
// shifts and email an alert, so a last-minute station change reaches your
// phone right away even if your calendar app hasn't re-polled the feed yet.
// ---------------------------------------------------------------------------

const SHIFT_TZ = process.env.SHIFT_TZ || "America/New_York";

interface FeedEvent {
  start: string; // ICS local form, e.g. 20261112T180000
  end: string;
  summary: string;
  location: string;
}

function unescapeIcsText(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

/** Parses the events this script itself wrote (one property per line, no folding). */
function parseFeed(ics: string): Map<string, FeedEvent> {
  const events = new Map<string, FeedEvent>();
  for (const block of ics.replace(/\r\n/g, "\n").split("BEGIN:VEVENT").slice(1)) {
    const prop = (name: string) => block.match(new RegExp(`^${name}:(.*)$`, "m"))?.[1] ?? "";
    const uid = prop("UID");
    if (!uid) continue;
    events.set(uid, {
      start: prop("DTSTART"),
      end: prop("DTEND"),
      summary: unescapeIcsText(prop("SUMMARY")),
      location: unescapeIcsText(prop("LOCATION")),
    });
  }
  return events;
}

/** "Now" in the shifts' local timezone, in ICS local form (20261105T143000). */
function nowInShiftTz(): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: SHIFT_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

/** 20261112T180000 -> "Thu Nov 12, 6:00 PM" (treated as wall-clock time). */
function prettyTime(icsLocal: string): string {
  const m = icsLocal.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!m) return icsLocal;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return d.toLocaleString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function prettyEnd(icsLocal: string): string {
  return prettyTime(icsLocal).split(", ").pop() ?? icsLocal;
}

async function notifyChanges(previousIcs: string, newIcs: string): Promise<void> {
  const before = parseFeed(previousIcs);
  const after = parseFeed(newIcs);
  const now = nowInShiftTz();

  const stationChanges: string[] = [];
  const otherChanges: string[] = [];

  for (const [uid, ev] of after) {
    if (ev.start < now) continue; // only care about upcoming shifts
    const old = before.get(uid);
    const when = `${prettyTime(ev.start)}–${prettyEnd(ev.end)}`;
    if (!old) {
      otherChanges.push(`New shift: ${when}\n${ev.location}`);
      continue;
    }
    if (old.location !== ev.location) {
      stationChanges.push(`${when}\n${old.location}\n→ ${ev.location}`);
    }
    if (old.start !== ev.start || old.end !== ev.end) {
      otherChanges.push(
        `Time changed: ${prettyTime(old.start)}–${prettyEnd(old.end)}\n→ ${when}\n${ev.location}`,
      );
    }
  }
  for (const [uid, old] of before) {
    if (old.start >= now && !after.has(uid)) {
      otherChanges.push(`Shift removed: ${prettyTime(old.start)}–${prettyEnd(old.end)}\n${old.location}`);
    }
  }

  if (stationChanges.length) {
    console.log(`Station changed for ${stationChanges.length} shift(s)`);
    // Put the new station in the subject so the phone notification alone is enough.
    const first = stationChanges[0].split("\n");
    const subject = `⚠️ Station changed: ${first[0].split(",").slice(0, 2).join(",")} ${first[2]}`;
    await notify(subject, stationChanges.join("\n\n"), true);
  }
  if (otherChanges.length) {
    console.log(`${otherChanges.length} other schedule change(s)`);
    await notify("📅 Schedule updated", otherChanges.join("\n\n"));
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

  // Only diff when we know what was published before -- otherwise every
  // shift would look "new". Best-effort: never fails the run.
  if (current !== null) {
    await notifyChanges(current, ics).catch((err) => console.error("Change notification failed:", err));
  }
}

main().catch(async (err: unknown) => {
  const isAuthError = err instanceof AuthExpiredError;
  const detail = err instanceof Error ? err.message : String(err);
  const message = isAuthError
    ? `tmwork-schedule-sync: tmwork auth failed -- check the TMWORK_CODE/TMWORK_USER/TMWORK_PASSWORD secrets. (${detail})`
    : `tmwork-schedule-sync: sync failed. ${detail}`;

  console.error(message);
  await notify(isAuthError ? "tmwork-schedule-sync: login failed" : "tmwork-schedule-sync: sync failed", message, isAuthError);
  // Exit code 2 = auth problem, 1 = anything else (kept distinct for logs).
  process.exit(isAuthError ? 2 : 1);
});
