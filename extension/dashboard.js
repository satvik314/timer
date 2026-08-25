import { loadDays, dayKeyFor, formatDuration, sortedEntries } from "./common.js";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function lastSevenDays() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(d);
  }
  return days;
}

function labelFor(date, index) {
  if (index === 6) return "Today";
  return `${DAY_LABELS[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()}`;
}

async function render() {
  const dates = lastSevenDays();
  const days = await loadDays(dates);
  const buckets = dates.map((d) => days.get(dayKeyFor(d)));
  const dayTotals = buckets.map((b) =>
    Object.values(b).reduce((sum, ms) => sum + ms, 0)
  );

  renderChart(dates, dayTotals);
  renderWeekTotals(buckets);
  renderPerDay(dates, buckets);
}

function renderChart(dates, dayTotals) {
  const chart = document.getElementById("chart");
  chart.replaceChildren();
  const max = Math.max(...dayTotals, 1);

  dates.forEach((date, i) => {
    const col = document.createElement("div");
    col.className = "chart-col";

    const value = document.createElement("span");
    value.className = "chart-value";
    value.textContent = dayTotals[i] > 0 ? formatDuration(dayTotals[i]) : "–";

    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.style.height = `${Math.max(2, (dayTotals[i] / max) * 100)}%`;

    const barWrap = document.createElement("div");
    barWrap.className = "chart-bar-wrap";
    barWrap.append(bar);

    const label = document.createElement("span");
    label.className = "chart-label";
    label.textContent = labelFor(date, i);

    col.append(value, barWrap, label);
    chart.append(col);
  });
}

function renderWeekTotals(buckets) {
  const weekTotals = {};
  for (const bucket of buckets) {
    for (const [domain, ms] of Object.entries(bucket)) {
      weekTotals[domain] = (weekTotals[domain] || 0) + ms;
    }
  }
  const entries = sortedEntries(weekTotals).slice(0, 15);
  document.getElementById("empty").hidden = entries.length > 0;

  const list = document.getElementById("week-list");
  list.replaceChildren();
  const max = entries.length ? entries[0][1] : 1;
  for (const [domain, ms] of entries) {
    const li = document.createElement("li");

    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.width = `${Math.max(2, (ms / max) * 100)}%`;

    const name = document.createElement("span");
    name.className = "domain";
    name.textContent = domain;

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatDuration(ms);

    li.append(bar, name, time);
    list.append(li);
  }
}

function renderPerDay(dates, buckets) {
  const container = document.getElementById("days");
  container.replaceChildren();

  dates
    .map((date, i) => ({ date, i, entries: sortedEntries(buckets[i]) }))
    .reverse()
    .forEach(({ date, i, entries }) => {
      if (!entries.length) return;
      const details = document.createElement("details");
      if (i === 6) details.open = true;

      const total = entries.reduce((sum, [, ms]) => sum + ms, 0);
      const summary = document.createElement("summary");
      summary.textContent = `${labelFor(date, i)} — ${formatDuration(total)}`;

      const table = document.createElement("table");
      for (const [domain, ms] of entries) {
        const row = table.insertRow();
        row.insertCell().textContent = domain;
        row.insertCell().textContent = formatDuration(ms);
      }

      details.append(summary, table);
      container.append(details);
    });
}

render();
setInterval(render, 30_000);
