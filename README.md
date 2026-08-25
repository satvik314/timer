# Domain Time Tracker

A Manifest V3 Chrome extension that tracks how much time you spend on each
domain, with a popup showing today's totals and a dashboard page with weekly
history.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

Click the toolbar icon for today's totals; follow the "Weekly dashboard" link
for the last 7 days.

## How tracking works

Time is only credited to a domain while all of these hold:

- its tab is the **active tab** of the **focused Chrome window**
  (`tabs.onActivated`, `tabs.onUpdated`, `windows.onFocusChanged`), and
- the user is **not idle or locked** (`chrome.idle`, 60s threshold), and
- the URL is `http:`/`https:` (internal pages like `chrome://` are ignored).

Switching tabs, navigating, changing window focus, or going idle ends the
current session and starts the next one.

## Service-worker–safe design

MV3 service workers are suspended after ~30s of inactivity, so the tracker
never relies on in-memory state or `setInterval`:

- **All state lives in `chrome.storage.local`.** The open session is stored as
  `activeSession: {domain, start}`; accumulated time is stored per local day
  as `day:YYYY-MM-DD → {domain: ms}`. The worker can be killed and restarted
  at any point without losing track of what's being timed.
- **A `chrome.alarms` heartbeat (1 min)** commits the open session's elapsed
  time to the day bucket and advances the commit point, then re-verifies the
  session against real browser state. A crash or forced shutdown can lose at
  most about one heartbeat interval.
- **Sleep guard:** alarms don't fire while the machine sleeps, so any single
  gap longer than 5 minutes between commits is discarded rather than credited.
- **Startup recovery:** on `runtime.onStartup`/`onInstalled` any stale session
  from a previous run is dropped (its time up to the last heartbeat was
  already committed) and day buckets older than 60 days are pruned.
- **Midnight splitting:** commits that span local midnight are apportioned to
  the correct day buckets, so the daily history stays accurate.

The popup and dashboard send a `flush` message before reading storage, so the
in-flight partial minute is included in what they display.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest (`tabs`, `storage`, `idle`, `alarms`) |
| `background.js` | Event-driven service worker: session tracking + heartbeat |
| `popup.html/js` | Today's per-domain totals |
| `dashboard.html/js` | 7-day chart, weekly top domains, per-day breakdown |
| `common.js` | Shared storage/formatting helpers |
| `style.css` | Shared styles |

All data stays local in `chrome.storage.local`; nothing is sent anywhere.
