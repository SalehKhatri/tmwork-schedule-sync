# tmwork-schedule-sync

Pulls your work schedule from TeamWork / ScheduleSource (tmwork.net) and
publishes it as an ICS calendar feed you can subscribe to from Outlook (or
any calendar app that supports "subscribe from URL").

It runs on a schedule via GitHub Actions, fetches shifts (today, +7 days,
+14 days, each a `range=month` call), dedupes them by `Id`, converts them
to ICS events, and pushes the result to a GitHub Gist. The three calls
heavily overlap now that each pulls a full month, but that's harmless
since results are deduped by `Id` — it just means comfortably more
lookahead than the ~21 days the offsets alone would suggest. If anything
fails — most commonly expired auth — it sends you a push notification via
[ntfy.sh](https://ntfy.sh) so you know to fix it.

tmwork's `emplist` endpoint requires two things from your logged-in
browser session: a `Cookie` header and an `X-Api-Token` header. Both are
captured from dev tools together (step 5) and both are treated as a single
credential pair that expires and gets refreshed together — see "About
auth expiring" below.

> **Heads up: the Gist is public-but-unlisted, not private.** GitHub
> "secret" gists are unlisted (not searchable, not shown on your profile)
> but anyone with the raw URL can view them — that's what makes them
> subscribable from Outlook without auth. Only shift times, locations, and
> notes go into it. Don't add anything more sensitive.

## Setup

Do these in order.

### 1. Create the placeholder Gist

Go to [gist.github.com](https://gist.github.com), create a **new secret
gist**:

- Filename: `job1-schedule.ics`
- Content: anything as a placeholder, e.g.:
  ```
  BEGIN:VCALENDAR
  VERSION:2.0
  END:VCALENDAR
  ```
- Click **Create secret gist**.

Copy the Gist ID from the URL — it's the long hex string after your
username, e.g. `https://gist.github.com/yourname/abc123...` → `abc123...`.
You'll need it as `GIST_ID`.

### 2. Create a fine-grained GitHub PAT scoped to just that gist

1. Go to **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens** ([direct link](https://github.com/settings/personal-access-tokens/new)).
2. Give it a name like `tmwork-sync-gist`.
3. Set an expiration (GitHub will require you to rotate it eventually —
   that's fine, this repo isn't set up to auto-renew it).
4. Under **Resource owner**, pick yourself.
5. Under permissions, find **Gists** and set it to **Read and write**.
   Fine-grained PATs don't let you scope to a single gist ID directly, but
   this keeps the token limited to the Gists API only — it can't touch your
   repos, issues, etc.
6. Generate the token and save it somewhere — you'll paste it into a repo
   secret next (`GIST_TOKEN`) and won't be able to view it again.

### 3. Install ntfy and pick an obscure topic

1. Install the [ntfy Android app](https://play.store) (also available on
   iOS, or use the web app at ntfy.sh) from the Play Store / App Store.
2. Pick a topic name that's hard to guess — ntfy topics are public by
   topic name, so anyone who knows it can read/post to it. Something like
   `khatri-tmwork-sync-x7q2p` works well. This is your `NTFY_TOPIC` value.
3. In the app, subscribe to that exact topic name.
4. Sanity check it works:
   ```bash
   curl -d "test notification" ntfy.sh/your-topic-name
   ```
   You should see it land on your phone.

### 4. Add the 5 secrets to the repo

In this repo: **Settings → Secrets and variables → Actions → New repository
secret**. Add:

| Secret name         | Value                                           |
| -------------------- | ------------------------------------------------ |
| `TMWORK_COOKIE`      | See step 5 below                                |
| `TMWORK_API_TOKEN`   | See step 5 below                                |
| `GIST_ID`            | The Gist ID from step 1                         |
| `GIST_TOKEN`         | The fine-grained PAT from step 2                |
| `NTFY_TOPIC`         | The topic name from step 3                      |

### 5. Get `TMWORK_COOKIE` and `TMWORK_API_TOKEN` from browser dev tools

The `emplist` endpoint requires both a session cookie *and* an
`X-Api-Token` request header — grab both from the same request:

1. Log in to tmwork.net normally in your browser and open your schedule.
2. Open dev tools (F12 or Cmd+Option+I) → **Network** tab.
3. Reload the page, or navigate to trigger a schedule fetch.
4. Find the request to `emplist` (filter by "emplist" if needed).
5. Click it → **Headers** → scroll to **Request Headers**.
6. Copy the *entire* value of the **Cookie** header (it'll be a long
   string of `name=value; name2=value2; ...` pairs) → paste as
   `TMWORK_COOKIE`.
7. Copy the value of the **X-Api-Token** header → paste as
   `TMWORK_API_TOKEN`.

Both represent your logged-in session, so treat them like passwords —
they're already GitHub Actions secrets, which is the right place for
them. Since they come from the same login and are sent together on every
request, always refresh them **together** as a pair, even if only one of
them turns out to be the one that actually expired.

### 6. Trigger the workflow manually to verify it works

Go to **Actions → Sync tmwork schedule → Run workflow**. Watch the run:

- If it succeeds, the Gist should now contain real ICS data — open the
  Gist and check the file content.
- If it fails, check the logs. If it's an auth failure you should also get
  an ntfy push telling you the cookie looks expired — confirm that arrived
  too.

### 7. Subscribe from Outlook

Use this URL format (raw Gist URL, filename included):

```
https://gist.githubusercontent.com/{username}/{gist_id}/raw/job1-schedule.ics
```

In Outlook: **Add calendar → Subscribe from web**, paste that URL. Outlook
polls subscribed calendars periodically (interval isn't fully under your
control, typically every few hours), which pairs fine with this repo's
4-hour sync schedule.

## About auth expiring

The tmwork session cookie and `X-Api-Token` **will** expire at some
point — the exact interval isn't documented and may vary, and it's not
confirmed whether they expire on the same schedule as each other (they're
minted from the same login, so most likely yes). **This is expected, not
a bug.** When it happens:

1. The scheduled run will get a 401/403 from tmwork.
2. You'll get an ntfy push telling you specifically that auth has expired
   (not a generic error).
3. Repeat step 5 above to grab a fresh cookie *and* fresh API token
   together, and update both secrets.

No code changes needed — the ntfy alert *is* the refresh signal.

## Local development

```bash
npm install
TMWORK_COOKIE="..." TMWORK_API_TOKEN="..." GIST_ID="..." GIST_TOKEN="..." NTFY_TOPIC="..." npx tsx src/sync.ts
```

## How it works

- `src/sync.ts` — the whole script. Fetches 3 overlapping `range=month`
  windows of shifts, dedupes by `Id`, builds an ICS file, PATCHes it to
  the Gist, and notifies via ntfy on any failure.
- `.github/workflows/sync.yml` — runs the script every 4 hours plus
  on-demand via `workflow_dispatch`.
- Event times are written as floating local time (no `TZID`), matching the
  timestamps tmwork returns as-is.
