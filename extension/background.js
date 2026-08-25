// Domain Time Tracker — MV3 service worker.
//
// The worker is fully event-driven and stateless: every piece of tracking
// state lives in chrome.storage.local so it survives service-worker
// suspension. A chrome.alarms heartbeat (no setInterval — timers die with
// the worker) periodically commits the open session to storage, so a crash
// or suspension can lose at most ~one heartbeat interval of data.
//
// Storage schema:
//   activeSession        -> { domain: string, start: number } | null
//                           `start` is the last commit point, not the moment
//                           the domain was focused.
//   day:YYYY-MM-DD       -> { [domain]: milliseconds }

const HEARTBEAT_MINUTES = 1;
// An elapsed span longer than this means the machine slept or the profile was
// gone between commits (alarms don't fire during system sleep); don't credit it.
const MAX_COMMIT_MS = 5 * 60 * 1000;
const IDLE_DETECTION_SECONDS = 60;
const RETENTION_DAYS = 60;

// ---------------------------------------------------------------------------
// Serialize all storage read-modify-write cycles within a worker lifetime.
// ---------------------------------------------------------------------------
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function dateKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `day:${d.getFullYear()}-${m}-${day}`;
}

function nextLocalMidnight(ts) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function domainFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname;
  } catch {
    return null;
  }
}

// Split [start, end) across local-midnight boundaries and add each slice to
// its day's bucket for `domain`.
async function creditTime(domain, start, end) {
  if (end <= start) return;
  const slices = new Map(); // storage key -> ms
  let cursor = start;
  while (cursor < end) {
    const sliceEnd = Math.min(nextLocalMidnight(cursor), end);
    const key = dateKey(cursor);
    slices.set(key, (slices.get(key) || 0) + (sliceEnd - cursor));
    cursor = sliceEnd;
  }
  const keys = [...slices.keys()];
  const stored = await chrome.storage.local.get(keys);
  const update = {};
  for (const [key, ms] of slices) {
    const bucket = stored[key] || {};
    bucket[domain] = (bucket[domain] || 0) + ms;
    update[key] = bucket;
  }
  await chrome.storage.local.set(update);
}

// Commit the open session's elapsed time and advance its commit point.
async function commitSession(now) {
  const { activeSession } = await chrome.storage.local.get("activeSession");
  if (!activeSession) return;
  const elapsed = now - activeSession.start;
  if (elapsed > 0 && elapsed <= MAX_COMMIT_MS) {
    await creditTime(activeSession.domain, activeSession.start, now);
  }
  await chrome.storage.local.set({
    activeSession: { ...activeSession, start: now },
  });
}

async function endSession(now) {
  await commitSession(now);
  await chrome.storage.local.set({ activeSession: null });
}

// Commit whatever was open, then open a session for `domain` (or none).
async function switchSession(domain, now) {
  const { activeSession } = await chrome.storage.local.get("activeSession");
  if (activeSession && activeSession.domain === domain) {
    await commitSession(now);
    return;
  }
  await endSession(now);
  if (domain) {
    await chrome.storage.local.set({ activeSession: { domain, start: now } });
  }
}

// Re-derive what should be tracked from the browser's current state:
// the active tab of the focused window, unless the user is idle/locked.
async function evaluateState() {
  const now = Date.now();
  const idleState = await chrome.idle.queryState(IDLE_DETECTION_SECONDS);
  if (idleState !== "active") {
    await endSession(now);
    return;
  }
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win || !win.focused) {
    await endSession(now);
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  await switchSession(tab ? domainFromUrl(tab.url) : null, now);
}

const reevaluate = () => enqueue(evaluateState);

// ---------------------------------------------------------------------------
// Event wiring (top-level, so listeners re-register on every worker wake)
// ---------------------------------------------------------------------------
chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);

chrome.tabs.onActivated.addListener(reevaluate);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) reevaluate();
});

chrome.tabs.onRemoved.addListener(reevaluate);

chrome.windows.onFocusChanged.addListener(reevaluate);

chrome.idle.onStateChanged.addListener(reevaluate);

chrome.alarms.onAlarm.addListener((alarm) => {
  // Heartbeat: commit progress and re-verify the session is still valid, so
  // storage never lags reality by more than one interval.
  if (alarm.name === "heartbeat") reevaluate();
});

async function initialize(clearStale) {
  await chrome.alarms.create("heartbeat", {
    periodInMinutes: HEARTBEAT_MINUTES,
  });
  await enqueue(async () => {
    if (clearStale) {
      // Browser just started: a leftover session belongs to the previous run
      // and its post-heartbeat tail can't be trusted — drop it (≤1 min lost).
      await chrome.storage.local.set({ activeSession: null });
      await pruneOldDays();
    }
    await evaluateState();
  });
}

chrome.runtime.onStartup.addListener(() => initialize(true));
chrome.runtime.onInstalled.addListener(() => initialize(true));

async function pruneOldDays() {
  const all = await chrome.storage.local.get(null);
  const cutoff = dateKey(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const stale = Object.keys(all).filter(
    (k) => k.startsWith("day:") && k < cutoff
  );
  if (stale.length) await chrome.storage.local.remove(stale);
}

// Popup/dashboard ask us to commit the in-flight session before they read
// storage, so displayed totals include the current partial minute.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "flush") {
    enqueue(async () => {
      await commitSession(Date.now());
    }).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
});
