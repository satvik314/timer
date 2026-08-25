import { loadDays, dayKeyFor, formatDuration, sortedEntries } from "./common.js";

async function render() {
  const today = new Date();
  const days = await loadDays([today]);
  const bucket = days.get(dayKeyFor(today));
  const entries = sortedEntries(bucket);

  const total = entries.reduce((sum, [, ms]) => sum + ms, 0);
  document.getElementById("total").textContent =
    total > 0 ? formatDuration(total) : "";

  const list = document.getElementById("list");
  list.replaceChildren();
  document.getElementById("empty").hidden = entries.length > 0;

  const max = entries.length ? entries[0][1] : 1;
  for (const [domain, ms] of entries) {
    const li = document.createElement("li");

    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.width = `${Math.max(2, (ms / max) * 100)}%`;

    const name = document.createElement("span");
    name.className = "domain";
    name.textContent = domain;
    name.title = domain;

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatDuration(ms);

    li.append(bar, name, time);
    list.append(li);
  }
}

document.getElementById("dashboard-link").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

render();
// The popup is a real window (not the service worker), so setInterval is
// fine here — refresh the view while it stays open.
setInterval(render, 10_000);
