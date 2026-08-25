// Seed data for the README screenshots.
//
// This is NOT shipped in the extension. `tools/capture.mjs` writes it straight
// into chrome.storage.local of a real, freshly-loaded copy of the extension,
// then screenshots the real popup and dashboard rendering it. So the numbers
// are synthetic, but every pixel around them is the actual product.
//
// A day is `{ [domain]: minutes }`, indexed by how many days ago it was
// (0 = today). Keep it to ~7 days so the weekly chart is full.

export const DAYS_AGO = {
  0: { "github.com": 96, "docs.anthropic.com": 41, "news.ycombinator.com": 22, "mail.google.com": 18, "youtube.com": 12, "stackoverflow.com": 9 },
  1: { "github.com": 112, "localhost": 64, "docs.anthropic.com": 28, "mail.google.com": 24, "twitter.com": 19, "youtube.com": 15 },
  2: { "github.com": 78, "figma.com": 55, "mail.google.com": 31, "news.ycombinator.com": 26, "youtube.com": 21 },
  3: { "docs.google.com": 88, "github.com": 62, "mail.google.com": 35, "calendar.google.com": 14, "twitter.com": 12 },
  4: { "github.com": 134, "localhost": 71, "stackoverflow.com": 33, "docs.anthropic.com": 25, "mail.google.com": 16 },
  5: { "youtube.com": 47, "news.ycombinator.com": 29, "github.com": 18, "reddit.com": 16 },
  6: { "github.com": 91, "docs.anthropic.com": 44, "mail.google.com": 27, "figma.com": 23, "twitter.com": 11 },
};

// Turn the table above into the extension's real storage schema:
//   day:YYYY-MM-DD -> { [domain]: milliseconds }
export function toStorage(now = new Date()) {
  const out = {};
  for (const [ago, domains] of Object.entries(DAYS_AGO)) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - Number(ago));
    const key = `day:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out[key] = Object.fromEntries(
      Object.entries(domains).map(([domain, min]) => [domain, min * 60_000])
    );
  }
  return out;
}
