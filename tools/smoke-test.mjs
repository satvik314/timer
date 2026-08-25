// End-to-end check of the tracking loop against a real Chrome.
//
// Loads extension/ into a real browser, serves a page on 127.0.0.1, focuses it,
// and verifies the service worker actually credits elapsed time to that domain
// in chrome.storage.local — plus that the sleep guard drops implausible gaps
// and that spans crossing local midnight are split across day buckets.
//
//   node tools/smoke-test.mjs

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const PORT = 9334;
const SITE_PORT = 8788;
const MANIFEST_NAME = JSON.parse(await readFile(path.join(EXT, "manifest.json"), "utf8")).name;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(process.env.HOME, "Library/Caches/ms-playwright");
  for (const dir of (await readdir(cache).catch(() => [])).filter((d) => d.startsWith("chromium-"))) {
    for (const rel of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "Chromium.app/Contents/MacOS/Chromium",
    ]) {
      const p = path.join(cache, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("No Chromium found. Set CHROME_BIN.");
}

function cdp(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  return {
    ready: new Promise((r) => ws.addEventListener("open", r)),
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const n = ++id;
        pending.set(n, { res, rej });
        ws.send(JSON.stringify({ id: n, method, params, sessionId }));
      }),
    close: () => ws.close(),
  };
}

const site = createServer((_, res) => res.end("<title>smoke</title><h1>smoke</h1>"));
await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));

const profile = await mkdtemp(path.join(tmpdir(), "dtt-smoke-"));
const chrome = spawn(await findChrome(), [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  "--no-first-run",
  "--no-default-browser-check",
], { stdio: "ignore" });

let version;
for (let i = 0; i < 60 && !version; i++) {
  version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
  if (!version) await sleep(250);
}
const browser = cdp(version.webSocketDebuggerUrl);
await browser.ready;
await browser.send("Target.setDiscoverTargets", { discover: true });

// Attach to our service worker so we can call its internals directly.
let sw = null;
for (let i = 0; i < 60 && !sw; i++) {
  const { targetInfos } = await browser.send("Target.getTargets");
  for (const t of targetInfos) {
    if (t.type !== "service_worker" || !t.url.endsWith("/background.js")) continue;
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    const r = await browser.send("Runtime.evaluate", {
      expression: "chrome.runtime.getManifest().name", returnByValue: true,
    }, sessionId).catch(() => null);
    if (r?.result?.value === MANIFEST_NAME) { sw = sessionId; break; }
    await browser.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
  if (!sw) await sleep(250);
}
if (!sw) throw new Error("service worker for the extension never appeared");

const evalSW = async (expression) => {
  const r = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sw);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

console.log("\nservice worker");
check("registers a heartbeat alarm",
  (await evalSW(`chrome.alarms.get("heartbeat").then(a => a?.periodInMinutes ?? null)`)) === 1);
const swSource = (await readFile(path.join(EXT, "background.js"), "utf8"))
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
check("uses chrome.alarms, never setInterval/setTimeout (they die with the worker)",
  !/\bset(Interval|Timeout)\s*\(/.test(swSource));

console.log("\ntracking loop");
await browser.send("Target.createTarget", { url: `http://127.0.0.1:${SITE_PORT}/` });
await sleep(1500);
await evalSW("reevaluate()");
const session = await evalSW(`chrome.storage.local.get("activeSession").then(r => r.activeSession)`);
check("opens a session for the focused tab's domain",
  session?.domain === "127.0.0.1", `got ${JSON.stringify(session)}`);

await sleep(3000);
await evalSW("enqueue(() => commitSession(Date.now()))");
const key = await evalSW("dateKey(Date.now())");
const credited = await evalSW(`chrome.storage.local.get("${key}").then(r => (r["${key}"] || {})["127.0.0.1"] || 0)`);
check("credits elapsed time to that domain",
  credited >= 2500 && credited <= 6000, `${credited}ms credited over ~3s`);

console.log("\nguards");
// A gap larger than MAX_COMMIT_MS means the machine slept: it must not be credited.
await evalSW(`chrome.storage.local.set({ activeSession: { domain: "slept.example", start: Date.now() - 60 * 60 * 1000 } })`);
await evalSW("enqueue(() => commitSession(Date.now()))");
const slept = await evalSW(`chrome.storage.local.get("${key}").then(r => (r["${key}"] || {})["slept.example"] || 0)`);
check("discards gaps longer than the sleep guard", slept === 0, `${slept}ms credited for a 1h gap`);

// A span crossing local midnight must land in two different day buckets.
await evalSW(`chrome.storage.local.set({ activeSession: null })`);
const split = await evalSW(`(async () => {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const t = midnight.getTime();
  await creditTime("midnight.example", t - 60000, t + 60000);
  const a = dateKey(t - 60000), b = dateKey(t + 60000);
  const s = await chrome.storage.local.get([a, b]);
  return [ (s[a]||{})["midnight.example"] || 0, (s[b]||{})["midnight.example"] || 0 ];
})()`);
check("splits a span across local midnight into two day buckets",
  split[0] === 60000 && split[1] === 60000, `yesterday=${split[0]}ms today=${split[1]}ms`);

console.log(`\n${failures ? `${failures} check(s) failed` : "all checks passed"}`);
browser.close();
chrome.kill();
site.close();
process.exit(failures ? 1 : 0);
