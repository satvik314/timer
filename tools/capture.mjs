// Screenshot the real extension for the README.
//
// Launches the Playwright-cached Chromium headless with extension/ loaded,
// seeds chrome.storage.local with tools/demo-data.mjs, then screenshots the
// actual popup.html and dashboard.html. No mocks, no stubbed chrome APIs —
// this is the shipped code rendering real storage.
//
//   node tools/capture.mjs
//
// Requires: a Chromium under ~/Library/Caches/ms-playwright (or set CHROME_BIN).

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toStorage } from "./demo-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "assets");
const PORT = 9333;
const MANIFEST_NAME = JSON.parse(
  await (await import("node:fs/promises")).readFile(path.join(EXT, "manifest.json"), "utf8")
).name;

async function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(process.env.HOME, "Library/Caches/ms-playwright");
  const candidates = [
    "Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ];
  for (const dir of (await readdir(cache).catch(() => [])).filter((d) => d.startsWith("chromium-"))) {
    for (const rel of candidates) {
      const p = path.join(cache, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("No Chromium found. Set CHROME_BIN to a Chrome/Chromium binary.");
}

// --- minimal CDP client (one browser socket, flattened sessions) ------------
function cdp(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let id = 0;
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((r) => ws.addEventListener("open", r));
  return {
    ready,
    events,
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params, sessionId }));
      });
    },
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, { tries = 60, every = 250, what = "condition" } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function main() {
  const bin = await findChrome();
  const profile = await mkdtemp(path.join(tmpdir(), "dtt-profile-"));
  await mkdir(OUT, { recursive: true });

  const chrome = spawn(bin, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stderr.on("data", (d) => {
    const s = String(d);
    if (/ERROR|FATAL/.test(s) && !/DEPRECATED|GPU|Vulkan|gl_display/.test(s)) process.stderr.write(s);
  });

  const version = await poll(
    () => fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null),
    { what: "DevTools endpoint" }
  );
  const browser = cdp(version.webSocketDebuggerUrl);
  await browser.ready;
  await browser.send("Target.setDiscoverTargets", { discover: true });

  // Several component extensions also run service workers, so identify ours by
  // attaching to each candidate and asking it for its manifest name.
  const extId = await poll(async () => {
    const { targetInfos } = await browser.send("Target.getTargets");
    for (const t of targetInfos) {
      if (t.type !== "service_worker" || !t.url.endsWith("/background.js")) continue;
      const { sessionId } = await browser.send("Target.attachToTarget", {
        targetId: t.targetId, flatten: true,
      });
      const r = await browser.send("Runtime.evaluate", {
        expression: "chrome.runtime.getManifest().name",
        returnByValue: true,
      }, sessionId).catch(() => null);
      await browser.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      if (r?.result?.value === MANIFEST_NAME) return new URL(t.url).hostname;
    }
    return null;
  }, { what: `service worker for "${MANIFEST_NAME}"` });
  console.log(`extension id: ${extId}`);

  async function shot(page, file, { width, height, fullPage }) {
    const url = `chrome-extension://${extId}/${page}`;
    const { targetId } = await browser.send("Target.createTarget", { url });
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (m, p) => browser.send(m, p, sessionId);
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 2, mobile: false,
    });

    // The target may still be on about:blank; wait for the extension origin.
    await poll(async () => {
      const r = await send("Runtime.evaluate", {
        expression: "typeof chrome !== 'undefined' && !!chrome.storage",
        returnByValue: true,
      });
      return r.result?.value === true;
    }, { tries: 40, what: `chrome.storage on ${page}` }).catch(async (e) => {
      const r = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
      throw new Error(`${e.message} (page is at ${r.result?.value})`);
    });

    // Seed real storage from the extension page's own chrome.storage.local.
    const seed = JSON.stringify(toStorage());
    const { exceptionDetails } = await send("Runtime.evaluate", {
      expression: `chrome.storage.local.set(${seed}).then(() => "ok")`,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`seed failed: ${JSON.stringify(exceptionDetails)}`);

    await send("Page.reload");
    await sleep(1200); // let render() finish its flush round-trip

    // cssContentSize is clamped to the viewport when the page is shorter than
    // it, so measure the document instead — the popup only needs ~250px.
    const measured = await send("Runtime.evaluate", {
      expression: "Math.ceil(document.documentElement.getBoundingClientRect().height)",
      returnByValue: true,
    });
    const h = fullPage ? measured.result.value : height;
    if (fullPage) {
      await send("Emulation.setDeviceMetricsOverride", {
        width, height: h, deviceScaleFactor: 2, mobile: false,
      });
      await sleep(300);
    }
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage });
    await writeFile(path.join(OUT, file), Buffer.from(data, "base64"));
    await browser.send("Target.closeTarget", { targetId });
    console.log(`wrote assets/${file} (${width}x${h} @2x)`);
  }

  await shot("popup.html", "popup.png", { width: 340, height: 420, fullPage: true });
  await shot("dashboard.html", "dashboard.png", { width: 860, height: 900, fullPage: true });

  browser.close();
  chrome.kill();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
