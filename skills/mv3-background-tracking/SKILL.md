---
name: mv3-background-tracking
description: Build a Manifest V3 browser extension whose background service worker measures something continuous — time on a domain, session length, presence, streaks, focus state — without losing data when Chrome suspends the worker after ~30 seconds. Use this whenever an extension needs to keep counting, timing, or watching while the worker is being killed and restarted, or when an existing MV3 extension "loses time", resets its counters, or works only while DevTools is open.
---

# Suspension-safe tracking in an MV3 service worker

## The problem this solves

Manifest V3 replaced the persistent background page with a service worker that
Chrome **terminates after roughly 30 seconds of inactivity**. Every naive
tracking extension makes the same three mistakes:

1. Keeps the current session in a module-level variable — gone on suspension.
2. Uses `setInterval` / `setTimeout` to tick — the timer dies with the worker,
   and long timeouts never fire.
3. Trusts its own event history — after a restart it has no idea what the
   browser is currently doing.

The result is an extension that works while DevTools is open (DevTools keeps
the worker alive) and silently loses hours the moment it isn't. If a user
reports "it only tracks when I have the console open," this is why.

The fix is a single principle: **the worker owns no state.** It is a pure
event handler over `chrome.storage`, woken by real browser events and by an
alarm, and it re-derives the truth from the browser every time it wakes.

## The method

### 1. Put every piece of tracking state in `chrome.storage.local`

Two keys are enough for a time tracker; adapt the names, keep the shape:

```
activeSession   -> { subject: string, start: number } | null
bucket:<period> -> { [subject]: accumulatedMilliseconds }
```

The critical, non-obvious detail: **`start` is the last commit point, not the
moment tracking began.** Every commit writes elapsed time into the bucket and
moves `start` forward to now. That makes each commit idempotent and makes the
worst case of an unexpected death exactly one heartbeat interval, no matter
how long the session runs.

### 2. Use `chrome.alarms` for the heartbeat — never a timer

```js
const HEARTBEAT_MINUTES = 1; // Chrome's floor for released extensions
chrome.alarms.create("heartbeat", { periodInMinutes: HEARTBEAT_MINUTES });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "heartbeat") reevaluate(); });
```

Alarms survive worker termination and wake the worker to fire. Register the
alarm in `onInstalled` **and** `onStartup`; `alarms.create` with the same name
is idempotent, so re-registering costs nothing.

`periodInMinutes` below 1 is silently clamped in released extensions. Do not
design around sub-minute precision — design so that losing a minute is cheap.

### 3. Register every listener at the top level of the file

```js
chrome.tabs.onActivated.addListener(reevaluate);      // correct
chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.onActivated.addListener(reevaluate);    // WRONG — never fires
});
```

The worker re-executes its whole file on each wake. Listeners registered
inside async callbacks or after an `await` miss the event that woke the
worker. Top-level registration is what makes an event able to start the
worker at all.

### 4. Re-derive state from the browser; do not trust event bookkeeping

Write one `evaluateState()` that asks the browser what is true right now, and
point *every* event at it. Events become "something changed, look again"
signals rather than instructions:

```js
async function evaluateState() {
  const now = Date.now();
  if (await chrome.idle.queryState(IDLE_SECONDS) !== "active") return endSession(now);
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win?.focused) return endSession(now);
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  await switchSession(subjectFor(tab), now);
}
```

This is what makes a cold restart correct: a worker that just booted with no
memory reaches exactly the same conclusion as one that has been running.

### 5. Serialize every read-modify-write

Storage has no transactions, and two events can land in the same tick:

```js
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn, fn));
const reevaluate = () => enqueue(evaluateState);
```

Pass the failure handler too (`.then(fn, fn)`), or one rejection stalls the
chain forever. This only serializes within a worker lifetime — which is
sufficient, because a worker is single-threaded and a new one starts from
storage anyway.

### 6. Guard against sleep and clock jumps

Alarms do not fire while the machine is asleep, so on wake you will see one
enormous gap. Crediting it invents hours the user never spent:

```js
const MAX_COMMIT_MS = 5 * 60 * 1000; // a few heartbeats
if (elapsed > 0 && elapsed <= MAX_COMMIT_MS) await credit(subject, start, now);
// too large: drop the span, but still advance `start` to now
```

Always advance `start` even when discarding, or the next commit re-measures
the same impossible gap.

### 7. Attribute spans to periods at commit time, splitting boundaries

If your buckets are per-day, a span that crosses local midnight belongs to two
buckets. Split it when you commit, not when you display:

```js
let cursor = start;
while (cursor < end) {
  const sliceEnd = Math.min(nextLocalMidnight(cursor), end);
  add(bucketKey(cursor), sliceEnd - cursor);
  cursor = sliceEnd;
}
```

Build keys from local date parts (`getFullYear`/`getMonth`/`getDate`), not
`toISOString()` — the latter is UTC and will misfile evening activity for
anyone west of Greenwich.

### 8. Recover on startup and prune

On `onStartup`/`onInstalled`, drop any leftover `activeSession`: its time up
to the last heartbeat is already committed, and its tail belongs to a browser
run that is over. Prune buckets past your retention window in the same pass —
`chrome.storage.local` has a real quota and unbounded history will hit it.

### 9. Give the UI a `flush` message

A popup opening mid-interval would otherwise show numbers up to a heartbeat
stale. Have the UI ask the worker to commit before it reads:

```js
// worker
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type !== "flush") return;
  enqueue(() => commitSession(Date.now())).then(() => sendResponse({ ok: true }));
  return true; // keep the channel open for the async response
});
// UI — tolerate failure, the worker may be mid-restart
try { await chrome.runtime.sendMessage({ type: "flush" }); } catch {}
```

Returning `true` synchronously is mandatory; without it the channel closes
before `sendResponse` runs.

## Permissions

Request only what the derivation needs. For tab-focus time tracking that is
`["tabs", "storage", "idle", "alarms"]` — no host permissions, because
`tabs.query` gives you the URL without them and nothing needs to run in the
page. Extensions that inject content scripts to do this trip review and scare
users for no gain.

## Verification — do this, it is the whole point

The failure mode is invisible in normal development, so test the suspension
directly:

1. Load the unpacked extension, open `chrome://extensions`, and click the
   service worker link to confirm it registers with no errors.
2. **Close DevTools**, browse normally for five minutes, then reopen the popup.
   Time must have accumulated. If it only accumulates with DevTools open, some
   state is still in memory.
3. On `chrome://extensions`, hit **Service worker → terminate** mid-session,
   then keep browsing. Totals must keep growing across the kill.
4. Sleep the machine for an hour and wake it. The sleep must not appear as
   tracked time.
5. If you want this in CI, drive a real Chrome over the DevTools protocol:
   launch with `--load-extension`, find your worker among the targets by
   `chrome.runtime.getManifest().name` (component extensions run workers too),
   attach, and call the worker's own functions to assert on storage.

## Output contract

A working result has all of these:

- [ ] No module-level mutable tracking state, and no `setInterval`/`setTimeout`
      in the service worker.
- [ ] Every listener registered at top level.
- [ ] One `evaluateState()` that re-derives from the browser; all events route
      to it through the serializing queue.
- [ ] Commits advance `start`; oversized gaps are dropped, not credited.
- [ ] Period keys built from local date parts, spans split at boundaries.
- [ ] Startup clears stale sessions and prunes old buckets.
- [ ] Survives a manual `terminate` mid-session with no lost time beyond one
      heartbeat.

## Reference implementation

A complete, working extension built exactly this way — plus a headless
smoke test that asserts on the tracking loop, the sleep guard, and midnight
splitting — is at <https://github.com/satvik314/timer>. If that repo is
available locally, read `extension/background.js` as a working reference and
`tools/smoke-test.mjs` for the CDP testing pattern. The skill above is
self-contained; the repo is only an example of it.
