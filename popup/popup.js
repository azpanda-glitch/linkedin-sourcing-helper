import { extractLocal } from "../lib/extract.js";
import { buildQueries } from "../lib/query.js";

const $ = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text || "";
  el.classList.toggle("error", isError);
  el.hidden = !text;
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

function sendToBg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

function renderLinks(ulId, items) {
  const ul = $(ulId);
  ul.innerHTML = "";
  for (const { label, url } of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = label;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    li.appendChild(a);
    ul.appendChild(li);
  }
}

// Rebuild the persona link lists from whatever is in the Boolean box.
function renderFromExt(ext) {
  const q = buildQueries(ext);
  $("boolean").value = q.boolean;
  renderLinks("sourcer-links", q.sourcer);
  renderLinks("hm-links", q.hiringManager);
}

// When the user edits the Boolean text, rebuild links using the edited string
// as the keyword core while keeping location/company from extraction.
function rebuildFromEditedBoolean(ext) {
  const edited = $("boolean").value.trim();
  const q = buildQueries(ext);
  const patch = (arr) =>
    arr.map((item) => ({
      label: item.label,
      url: item.url.includes("google.com")
        ? `https://www.google.com/search?q=${encodeURIComponent(
            item.url.includes("linkedin.com/posts") ? `site:linkedin.com/posts ${edited}` : `site:linkedin.com/in ${edited}`
          )}`
        : item.url.replace(/keywords=[^&]*/, `keywords=${encodeURIComponent(edited)}`)
    }));
  renderLinks("sourcer-links", patch(q.sourcer));
  renderLinks("hm-links", patch(q.hiringManager));
}

function renderPeople(people) {
  const ul = $("pdl-results");
  ul.innerHTML = "";
  if (!people.length) {
    $("pdl-status").textContent = "No matches returned.";
    return;
  }
  for (const p of people) {
    const li = document.createElement("li");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = p.name;
    const role = document.createElement("div");
    role.className = "role";
    role.textContent = [p.title, p.company, p.location].filter(Boolean).join(" · ");
    li.append(name, role);
    if (p.linkedin) {
      const a = document.createElement("a");
      a.href = p.linkedin;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "LinkedIn profile ↗";
      li.appendChild(a);
    }
    ul.appendChild(li);
  }
}

function wirePdl(ext) {
  const run = async (mode, label) => {
    const status = $("pdl-status");
    $("pdl-results").innerHTML = "";
    if (!ext.company) {
      status.textContent = "No company detected on this posting.";
      return;
    }
    status.textContent = `Searching ${label} at ${ext.company}…`;
    const res = await sendToBg({
      type: "PDL_SEARCH",
      params: { company: ext.company, titles: ext.titles, location: ext.location, mode }
    });
    if (!res?.ok) {
      const hints = {
        "no-key": "Add a People Data Labs API key in ⚙︎ settings.",
        "no-company": "No company detected on this posting.",
        exception: "Request failed — check your connection."
      };
      status.textContent = hints[res?.error] || `PDL error: ${res?.error}${res?.detail ? ` — ${res.detail}` : ""}`;
      return;
    }
    status.textContent = `${res.people.length} shown (of ~${res.total}).`;
    renderPeople(res.people);
  };

  $("find-recruiters").addEventListener("click", () => run("recruiters", "recruiters / hiring managers"));
  $("find-peers").addEventListener("click", () => run("peers", "people in this role"));
}

async function main() {
  $("settings-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.linkedin\.com\/jobs\//.test(tab.url || "")) {
    setStatus("Open a LinkedIn job posting, then click the extension.", true);
    return;
  }

  setStatus("Reading posting…");
  const scraped = await sendToTab(tab.id, { type: "SCRAPE_POSTING" });
  if (!scraped?.ok || !scraped.posting?.title) {
    setStatus("Couldn't read this page. Scroll the description into view and retry.", true);
    return;
  }

  const posting = scraped.posting;
  $("job-title").textContent = posting.title;
  $("job-company").textContent = [posting.company, posting.location].filter(Boolean).join(" · ");

  const { extractionMode } = await chrome.storage.sync.get(["extractionMode"]);
  let ext = null;

  if (extractionMode === "claude") {
    setStatus("Extracting with Claude…");
    const res = await sendToBg({ type: "EXTRACT_CLAUDE", posting });
    if (res?.ok) {
      ext = res.ext;
    } else {
      setStatus(
        res?.error === "no-key"
          ? "No API key set — using local extraction. Add a key in ⚙︎ settings."
          : `Claude extraction failed (${res?.error}) — using local extraction.`,
        true
      );
    }
  }

  if (!ext) ext = extractLocal(posting);

  $("src-badge").textContent = ext.source;
  if (ext.source === "local" && extractionMode !== "claude") setStatus("");
  else if (ext.source === "claude") setStatus("");

  $("posting").hidden = false;
  renderFromExt(ext);

  wirePdl(ext);

  $("rebuild").addEventListener("click", () => rebuildFromEditedBoolean(ext));
  $("copy-bool").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("boolean").value);
    $("copy-bool").textContent = "Copied";
    setTimeout(() => ($("copy-bool").textContent = "Copy"), 1200);
  });
}

main();
