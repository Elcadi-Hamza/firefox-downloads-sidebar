"use strict";

const COMMAND_NAME = "toggle-downloads-sidebar";
const SVG_NS = "http://www.w3.org/2000/svg";

const SECTIONS = [
  { key: "downloading", title: "Downloading" },
  { key: "paused", title: "Paused" },
  { key: "completed", title: "Completed" },
  { key: "failed", title: "Failed" },
];

const ACTIONS_BY_SECTION = {
  downloading: ["pause", "cancel"],
  paused: ["resume", "cancel"],
  completed: ["open", "show", "remove"],
  failed: ["retry", "remove"],
};

// Icons are [pathData, filled] pairs on a 16x16 grid.
const ACTIONS = {
  pause: { title: "Pause", paths: [["M5 3h2v10H5zM9 3h2v10H9z", true]] },
  resume: { title: "Resume", paths: [["M5 3l8 5-8 5z", true]] },
  cancel: { title: "Cancel", paths: [["M4 4l8 8M12 4l-8 8"]] },
  retry: { title: "Retry", paths: [["M13 8A5 5 0 1 1 11.5 4.5"], ["M12.5 2.5v3h-3"]] },
  open: { title: "Open file", paths: [["M6.5 3H3v10h10V9.5M9 3h4v4M13 3L7.5 8.5"]] },
  show: { title: "Show in folder", paths: [["M2 4.5h4l1.5 1.5H14v6.5H2z"]] },
  remove: {
    title: "Remove from list",
    paths: [["M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 9h6l.5-9M7 7v4M9 7v4"]],
  },
};

const PAGE_OUTLINE = [["M3.5 1.5h6l3 3v10h-9z"], ["M9.5 1.5v3h3"]];
const FILE_GLYPHS = {
  generic: [],
  image: [["M5 12l2-3 1.5 2 1-1.2L11 12z", true]],
  audio: [["M9 12V7"], ["M6 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0z", true]],
  video: [["M6.5 7.5l3.5 2.5-3.5 2.5z", true]],
  archive: [["M7 2.5v1M7 4.5v1M7 6.5v1"], ["M6 8.5h2v3H6z"]],
  document: [["M5.5 8h5M5.5 10h5M5.5 12h3"]],
  code: [["M7 8l-1.5 2L7 12M9.5 8L11 10l-1.5 2"]],
  app: [["M6 8h4v4H6z"]],
};

const EXTENSIONS = {
  image: "png jpg jpeg gif webp svg bmp ico avif tif tiff heic",
  audio: "mp3 wav flac ogg oga m4a aac opus",
  video: "mp4 mkv webm avi mov wmv flv m4v",
  archive: "zip rar 7z tar gz bz2 xz tgz iso",
  document: "pdf doc docx odt rtf txt md xls xlsx ods csv ppt pptx odp epub",
  code: "js ts json html css xml py java c cpp h php sh yml yaml sql",
  app: "exe msi dmg pkg deb rpm apk appimage bat",
};
const KIND_BY_EXTENSION = {};
for (const [kind, list] of Object.entries(EXTENSIONS)) {
  for (const ext of list.split(" ")) KIND_BY_EXTENSION[ext] = kind;
}

const items = new Map(); // download id -> DownloadItem
const rows = new Map(); // download id -> cached row elements
const speeds = new Map(); // download id -> { bytes, time, speed }
const sections = {}; // section key -> { el, countEl, listEl }

let query = "";
let pollTimer = null;
let renderTimer = null;
let noticeTimer = null;

const $ = (id) => document.getElementById(id);

/* ---------- Formatting ---------- */

function baseName(item) {
  let name = (item.filename || "").split(/[\\/]/).pop();
  if (!name) {
    const url = item.url || "";
    if (url.startsWith("data:")) return "download";
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop());
    } catch (err) {
      name = "";
    }
  }
  return name || item.url || "(unknown)";
}

function formatBytes(n) {
  if (!(n >= 0)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : 1)) + " " + units[i];
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s + " s";
  if (s < 3600) return Math.floor(s / 60) + " min " + (s % 60) + " s";
  return Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min";
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (isNaN(date)) return "";
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString();
}

function totalOf(d) {
  if (d.totalBytes > 0) return d.totalBytes;
  if (d.fileSize > 0) return d.fileSize;
  return -1;
}

/* ---------- State helpers ---------- */

// In Firefox a paused download reports state "interrupted" with paused=true,
// so paused must be checked before state.
function sectionOf(d) {
  if (d.state === "complete") return "completed";
  if (d.paused) return "paused";
  if (d.state === "interrupted") return "failed";
  return "downloading";
}

// Estimate speed from bytesReceived samples (Firefox does not push progress
// events, so this is fed by the 1 s poll below).
function sample(d) {
  if (sectionOf(d) !== "downloading") {
    speeds.delete(d.id);
    return;
  }
  const now = Date.now();
  const prev = speeds.get(d.id);
  if (!prev) {
    speeds.set(d.id, { bytes: d.bytesReceived, time: now, speed: 0 });
    return;
  }
  const dt = (now - prev.time) / 1000;
  if (dt < 0.5) return;
  const instant = Math.max(0, d.bytesReceived - prev.bytes) / dt;
  const speed = prev.speed > 0 ? prev.speed * 0.6 + instant * 0.4 : instant;
  speeds.set(d.id, { bytes: d.bytesReceived, time: now, speed });
}

function iconKind(d) {
  const name = baseName(d);
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (KIND_BY_EXTENSION[ext]) return KIND_BY_EXTENSION[ext];
  const mime = d.mime || "";
  for (const kind of ["image", "audio", "video"]) {
    if (mime.startsWith(kind + "/")) return kind;
  }
  return "generic";
}

function describe(d, section) {
  const received = d.bytesReceived;
  const total = totalOf(d);
  const parts = [];

  if (section === "downloading" || section === "paused") {
    parts.push(section === "paused" ? "Paused" : "Downloading");
    if (total > 0) parts.push(Math.min(100, Math.floor((received / total) * 100)) + "%");
    parts.push(total > 0 ? formatBytes(received) + " of " + formatBytes(total) : formatBytes(received));
    if (section === "downloading") {
      const info = speeds.get(d.id);
      const speed = info ? info.speed : 0;
      if (speed >= 1) parts.push(formatBytes(speed) + "/s");
      let remaining = -1;
      if (total > 0 && speed >= 1) {
        remaining = (total - received) / speed;
      } else if (d.estimatedEndTime) {
        remaining = (Date.parse(d.estimatedEndTime) - Date.now()) / 1000;
      }
      if (remaining >= 0 && isFinite(remaining)) parts.push(formatDuration(remaining) + " left");
    }
  } else if (section === "completed") {
    parts.push(d.exists === false ? "File moved or deleted" : "Completed");
    const size = d.fileSize > 0 ? d.fileSize : d.totalBytes;
    if (size > 0) parts.push(formatBytes(size));
    if (d.endTime) parts.push(formatWhen(d.endTime));
  } else {
    if (d.error === "USER_CANCELED") {
      parts.push("Canceled");
    } else {
      parts.push("Failed" + (d.error ? " (" + d.error.toLowerCase().replace(/_/g, " ") + ")" : ""));
    }
    if (received > 0) parts.push(formatBytes(received) + " received");
    if (d.endTime) parts.push(formatWhen(d.endTime));
  }
  return parts.filter(Boolean).join(" \u00b7 ");
}

/* ---------- DOM building ---------- */

function makeSvg(paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const [data, filled] of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", data);
    if (filled) path.setAttribute("class", "f");
    svg.appendChild(path);
  }
  return svg;
}

function buildSections() {
  const list = $("list");
  for (const { key, title } of SECTIONS) {
    const el = document.createElement("section");
    el.className = "section";
    el.hidden = true;
    const heading = document.createElement("h2");
    const titleEl = document.createElement("span");
    titleEl.textContent = title;
    const countEl = document.createElement("span");
    countEl.className = "count";
    heading.append(titleEl, countEl);
    const listEl = document.createElement("ul");
    el.append(heading, listEl);
    list.appendChild(el);
    sections[key] = { el, countEl, listEl };
  }
}

function createRow(d) {
  const el = document.createElement("li");
  el.dataset.id = String(d.id);
  const iconEl = document.createElement("span");
  iconEl.className = "ficon";
  const body = document.createElement("div");
  const nameEl = document.createElement("div");
  nameEl.className = "name";
  const metaEl = document.createElement("div");
  metaEl.className = "meta";
  const barEl = document.createElement("div");
  barEl.className = "bar";
  const fillEl = document.createElement("i");
  barEl.appendChild(fillEl);
  body.append(nameEl, metaEl, barEl);
  const actionsEl = document.createElement("div");
  actionsEl.className = "actions";
  el.append(iconEl, body, actionsEl);

  const row = { el, iconEl, nameEl, metaEl, barEl, fillEl, actionsEl, iconKey: "", actionKey: "" };
  rows.set(d.id, row);
  return row;
}

function rebuildActions(row, section, d, actionKey) {
  row.actionsEl.replaceChildren();
  for (const name of ACTIONS_BY_SECTION[section]) {
    const action = ACTIONS[name];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.dataset.action = name;
    button.title = action.title;
    button.setAttribute("aria-label", action.title);
    if (name === "open" && d.exists === false) button.disabled = true;
    button.appendChild(makeSvg(action.paths));
    row.actionsEl.appendChild(button);
  }
  row.actionKey = actionKey;
}

function updateRow(row, d) {
  const section = sectionOf(d);
  const name = baseName(d);

  row.el.className = "item " + section;
  row.el.title = d.filename || d.url || "";
  if (row.nameEl.textContent !== name) row.nameEl.textContent = name;
  row.metaEl.textContent = describe(d, section);

  const kind = iconKind(d);
  if (row.iconKey !== kind) {
    row.iconEl.replaceChildren(makeSvg(PAGE_OUTLINE.concat(FILE_GLYPHS[kind])));
    row.iconKey = kind;
  }

  const total = totalOf(d);
  const active = section === "downloading" || section === "paused";
  row.barEl.hidden = !(active && total > 0);
  if (!row.barEl.hidden) {
    row.fillEl.style.width = Math.min(100, (d.bytesReceived / total) * 100) + "%";
  }

  const actionKey = section + (section === "completed" && d.exists === false ? ":missing" : "");
  if (row.actionKey !== actionKey) rebuildActions(row, section, d, actionKey);
}

/* ---------- Rendering ---------- */

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, 30);
}

function render() {
  const q = query.trim().toLowerCase();
  const groups = { downloading: [], paused: [], completed: [], failed: [] };
  const sorted = [...items.values()].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
  let shown = 0;
  for (const d of sorted) {
    if (q && !baseName(d).toLowerCase().includes(q)) continue;
    groups[sectionOf(d)].push(d);
    shown++;
  }

  const visible = new Set();
  for (const { key } of SECTIONS) {
    const section = sections[key];
    const list = groups[key];
    section.el.hidden = list.length === 0;
    section.countEl.textContent = list.length ? String(list.length) : "";
    list.forEach((d, i) => {
      visible.add(d.id);
      const row = rows.get(d.id) || createRow(d);
      updateRow(row, d);
      // Only touch the DOM when the position is wrong, so focus is kept.
      if (section.listEl.children[i] !== row.el) {
        section.listEl.insertBefore(row.el, section.listEl.children[i] || null);
      }
    });
  }

  for (const [id, row] of rows) {
    if (!visible.has(id)) {
      row.el.remove();
      rows.delete(id);
    }
  }

  const empty = $("empty");
  empty.hidden = shown > 0;
  if (shown === 0) empty.textContent = items.size === 0 ? "No downloads" : "No matching downloads";
}

/* ---------- Data and events ---------- */

async function refresh(id) {
  try {
    const [d] = await browser.downloads.search({ id });
    if (d) {
      items.set(id, d);
      sample(d);
    } else {
      items.delete(id);
      speeds.delete(id);
    }
  } catch (err) {
    console.error("refresh failed", err);
  }
  scheduleRender();
  ensurePolling();
}

function ensurePolling() {
  const active = [...items.values()].some((d) => sectionOf(d) === "downloading");
  if (active && !pollTimer) {
    pollTimer = setInterval(poll, 1000);
  } else if (!active && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function poll() {
  try {
    const live = await browser.downloads.search({ state: "in_progress" });
    const seen = new Set();
    for (const d of live) {
      seen.add(d.id);
      items.set(d.id, d);
      sample(d);
    }
    // Anything we still think is running but that is no longer in the list
    // has changed state; fetch its final state.
    for (const d of [...items.values()]) {
      if (d.state === "in_progress" && !seen.has(d.id)) refresh(d.id);
    }
  } catch (err) {
    console.error("poll failed", err);
  }
  scheduleRender();
  ensurePolling();
}

/* ---------- Actions ---------- */

async function retry(d) {
  if (d.canResume) {
    try {
      await browser.downloads.resume(d.id);
      return;
    } catch (err) {
      // Fall through to a fresh download.
    }
  }
  await browser.downloads.download({
    url: d.url,
    conflictAction: "uniquify",
    incognito: !!d.incognito,
  });
}

async function runAction(action, id) {
  const d = items.get(id);
  if (!d) return;
  try {
    switch (action) {
      case "pause": await browser.downloads.pause(id); break;
      case "resume": await browser.downloads.resume(id); break;
      case "cancel": await browser.downloads.cancel(id); break;
      case "open": await browser.downloads.open(id); break;
      case "show": await browser.downloads.show(id); break;
      case "retry": await retry(d); break;
      case "remove":
        await browser.downloads.erase({ id });
        items.delete(id);
        speeds.delete(id);
        scheduleRender();
        ensurePolling();
        return;
    }
  } catch (err) {
    notify(ACTIONS[action].title + " failed: " + ((err && err.message) || err));
  }
  await refresh(id);
}

function notify(message) {
  const el = $("notice");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

/* ---------- Theme and shortcut ---------- */

function cssColor(c) {
  if (!c) return null;
  if (Array.isArray(c)) return (c.length === 4 ? "rgba(" : "rgb(") + c.join(",") + ")";
  return String(c);
}

function applyTheme(theme) {
  const style = document.documentElement.style;
  const colors = (theme && theme.colors) || {};
  const set = (prop, value) => (value ? style.setProperty(prop, value) : style.removeProperty(prop));
  const pair = (propA, a, propB, b) => {
    const ok = a && b;
    set(propA, ok ? a : null);
    set(propB, ok ? b : null);
  };
  pair("--bg", cssColor(colors.sidebar), "--fg", cssColor(colors.sidebar_text));
  pair("--field-bg", cssColor(colors.toolbar_field), "--field-fg", cssColor(colors.toolbar_field_text));
  set("--border", cssColor(colors.sidebar_border));
}

async function loadTheme() {
  try {
    applyTheme(await browser.theme.getCurrent());
    browser.theme.onUpdated.addListener(({ theme }) => applyTheme(theme));
  } catch (err) {
  }
}

async function loadShortcut() {
  const el = $("shortcut");
  try {
    const commands = await browser.commands.getAll();
    const command = commands.find((c) => c.name === COMMAND_NAME);
    if (command && command.shortcut) {
      el.textContent = "Shortcut: " + command.shortcut;
    } else {
      el.textContent =
        "No keyboard shortcut is assigned. Firefox may already use Ctrl+J. " +
        "Assign one in the Add-ons Manager: gear menu \u2192 Manage Extension Shortcuts.";
      el.classList.add("warn");
    }
    el.hidden = false;
  } catch (err) {
    console.error("commands.getAll failed", err);
  }
}

/* ---------- Startup ---------- */

async function init() {
  buildSections();

  const search = $("search");
  search.addEventListener("input", () => {
    query = search.value;
    scheduleRender();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      search.value = "";
      query = "";
      scheduleRender();
    }
  });

  $("list").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-action]");
    const item = button && button.closest(".item");
    if (button && item && !button.disabled) runAction(button.dataset.action, Number(item.dataset.id));
  });

  browser.downloads.onCreated.addListener((d) => {
    items.set(d.id, d);
    sample(d);
    scheduleRender();
    ensurePolling();
  });
  browser.downloads.onChanged.addListener((delta) => refresh(delta.id));
  browser.downloads.onErased.addListener((id) => {
    items.delete(id);
    speeds.delete(id);
    scheduleRender();
    ensurePolling();
  });

  try {
    const all = await browser.downloads.search({ orderBy: ["-startTime"], limit: 500 });
    for (const d of all) {
      items.set(d.id, d);
      sample(d);
    }
  } catch (err) {
    notify("Could not read downloads: " + ((err && err.message) || err));
  }
  render();
  ensurePolling();

  // loadTheme();
  loadShortcut();
}

init();
