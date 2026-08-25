// Shared helpers for the popup and dashboard pages.

export function dayKeyFor(date) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `day:${date.getFullYear()}-${m}-${d}`;
}

export function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 1) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

// Ask the service worker to commit the in-flight session, then read the
// buckets for the given Date objects. Returns Map<dayKey, {domain: ms}>.
export async function loadDays(dates) {
  try {
    await chrome.runtime.sendMessage({ type: "flush" });
  } catch {
    // Worker may be mid-restart; stored totals are at most one heartbeat old.
  }
  const keys = dates.map(dayKeyFor);
  const stored = await chrome.storage.local.get(keys);
  return new Map(keys.map((k) => [k, stored[k] || {}]));
}

export function sortedEntries(bucket) {
  return Object.entries(bucket).sort((a, b) => b[1] - a[1]);
}
