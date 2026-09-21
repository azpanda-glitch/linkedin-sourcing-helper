import { extractLocal } from "../lib/extract.js";
import { buildQueries, isEarlyCareer } from "../lib/query.js";

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

// Self-contained scrape run in the page via chrome.scripting.executeScript.
// Must not reference anything outside its own body (it is serialized).
function scrapePostingInPage() {
  const pick = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return "";
  };
  const meta = (prop) =>
    document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.content?.trim() || "";
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // --- Source 1: JSON-LD JobPosting (most reliable; survives CSS churn) -----
  let ld = {};
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(node.textContent);
      const items = Array.isArray(parsed) ? parsed : [parsed, ...(parsed["@graph"] || [])];
      for (const it of items) {
        if (it && /JobPosting/i.test(it["@type"] || "")) {
          const loc = it.jobLocation?.address || it.jobLocation?.[0]?.address || {};
          ld = {
            title: clean(it.title),
            company: clean(it.hiringOrganization?.name),
            location: clean(
              [loc.addressLocality, loc.addressRegion, loc.addressCountry]
                .filter((x) => typeof x === "string")
                .join(", ")
            ),
            // description is HTML — strip tags for text extraction
            description: clean(
              String(it.description || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ")
            )
          };
          break;
        }
      }
    } catch (e) {
      /* malformed JSON-LD block — ignore and try the next source */
    }
    if (ld.company) break;
  }

  // --- Source 2: og:title / document.title -> "<Company> hiring <Role> in <Loc>"
  let ogCompany = "";
  let ogTitle = "";
  let ogLocation = "";
  for (const raw of [meta("og:title"), document.title]) {
    const s = clean(raw).replace(/\s*\|\s*LinkedIn.*$/i, "");
    const m = s.match(/^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+(.+))?$/i);
    if (m) {
      ogCompany = ogCompany || clean(m[1]);
      ogTitle = ogTitle || clean(m[2]);
      ogLocation = ogLocation || clean(m[3] || "");
      break;
    }
  }

  // --- Source 3: URL slug -> /jobs/view/<role>-at-<company>-<id> ------------
  let slugCompany = "";
  const slug = window.location.pathname.match(/\/jobs\/view\/([^/?]+)/)?.[1] || "";
  if (slug) {
    const m = slug.replace(/-\d+$/, "").split("-at-");
    if (m.length > 1) {
      slugCompany = m[m.length - 1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  // --- Source 4: DOM selectors (current LinkedIn markup) -------------------
  const domTitle = pick([
    ".job-details-jobs-unified-top-card__job-title",
    ".jobs-unified-top-card__job-title",
    ".t-24.job-details-jobs-unified-top-card__job-title",
    "h1.t-24",
    "h1"
  ]);

  let domCompany = pick([
    ".job-details-jobs-unified-top-card__company-name",
    ".jobs-unified-top-card__company-name",
    ".job-details-jobs-unified-top-card__company-name a",
    ".topcard__org-name-link",
    'a[href*="/company/"]'
  ]);
  domCompany = clean(domCompany.split("\n")[0]);

  const domLocation = pick([
    ".job-details-jobs-unified-top-card__primary-description-container",
    ".jobs-unified-top-card__primary-description",
    ".topcard__flavor--bullet",
    ".jobs-unified-top-card__bullet"
  ]);

  // Merge with precedence: structured data > og:title > DOM > URL slug.
  const title = ld.title || ogTitle || domTitle || "";
  const company = ld.company || ogCompany || domCompany || slugCompany || "";
  // Trim trailing bullets/dots LinkedIn appends to the location line.
  const jobLocation = clean((ld.location || ogLocation || domLocation || "").split("·")[0]);

  let description = pick([
    "#job-details",
    ".jobs-description__content",
    ".jobs-box__html-content",
    ".jobs-description-content__text",
    "article.jobs-description__container"
  ]);
  if (!description) description = ld.description || "";
  if (!description) {
    // Fallback: largest visible text block on the page.
    let best = "";
    for (const el of document.querySelectorAll("article, section, div")) {
      const t = (el.innerText || "").trim();
      if (t.length > best.length && t.length < 20000) best = t;
    }
    description = best;
  }

  return {
    title,
    company,
    location: jobLocation,
    description,
    url: window.location.href,
    // which source won — surfaced in the popup so failures are diagnosable
    companySource: ld.company ? "json-ld" : ogCompany ? "og:title" : domCompany ? "dom" : slugCompany ? "url" : "none"
  };
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
  renderLinks("hm-links", q.hiringManager);
  renderLinks("sourcer-links", q.sourcer);
}

// Rebuild after the user edits the Company field or the Boolean box.
// The company change re-derives every query; the edited Boolean is applied only
// to the two generic keyword searches, so recruiter/manager searches keep their
// own purpose-built term lists.
function rebuild(ext) {
  ext.company = $("company").value.trim();
  const edited = $("boolean").value.trim();
  const q = buildQueries(ext);

  // The edited Boolean drives the two primary hiring-manager searches; the
  // recruiter/manager searches keep their own purpose-built term lists.
  const applyEdited = (items) =>
    items.map((item) => {
      if (!/^Hiring manager posts/.test(item.label)) return item;
      return {
        label: item.label,
        url: item.url.replace(/keywords=[^&]*/, `keywords=${encodeURIComponent(edited)}`)
      };
    });

  renderLinks("hm-links", applyEdited(q.hiringManager));
  renderLinks("sourcer-links", q.sourcer);
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
    // Honor a company typed into the field even if nothing was scraped.
    ext.company = $("company").value.trim() || ext.company;
    if (!ext.company) {
      status.textContent = "No company detected on this posting.";
      return;
    }
    status.textContent = `Searching ${label} at ${ext.company}…`;
    const res = await sendToBg({
      type: "PDL_SEARCH",
      params: {
        company: ext.company,
        titles: ext.titles,
        mode,
        earlyCareer: isEarlyCareer(ext)
      }
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

  const early = isEarlyCareer(ext);
  const recruiterLabel = early ? "university / early-career recruiters" : "recruiters / hiring managers";
  if (early) $("find-recruiters").textContent = "Find university recruiters";
  $("find-recruiters").addEventListener("click", () => run("recruiters", recruiterLabel));
  $("find-peers").addEventListener("click", () => run("peers", "people in this role"));
}

async function main() {
  $("settings-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/([\w-]+\.)?linkedin\.com\//.test(tab.url || "")) {
    setStatus("Open a LinkedIn job posting, then click the extension.", true);
    return;
  }

  setStatus("Reading posting…");

  // Primary: inject the scrape on demand (works regardless of when the
  // extension was loaded). Fallback: message the declared content script.
  let posting = null;
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapePostingInPage
    });
    if (inj?.result?.title || inj?.result?.description) posting = inj.result;
  } catch (e) {
    // executeScript can fail on restricted pages; fall through to messaging.
  }
  if (!posting) {
    const scraped = await sendToTab(tab.id, { type: "SCRAPE_POSTING" });
    if (scraped?.ok && scraped.posting) posting = scraped.posting;
  }

  if (!posting || !(posting.title || posting.description)) {
    setStatus(
      "Couldn't read this page. Make sure a job posting is open (URL has /jobs/view/…), " +
        "scroll the description into view, then reopen the extension. If you just installed it, reload the LinkedIn tab first.",
      true
    );
    return;
  }
  if (!posting.title) posting.title = posting.company || "this role";
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

  // Carry the original posting title and description so "role + hiring" and
  // early-career detection anchor on the real text, not a derived title.
  ext.roleName = posting.title;
  ext.description = posting.description || "";
  if (!ext.company) ext.company = posting.company || "";

  $("src-badge").textContent = ext.source;
  if (ext.source === "local" && extractionMode !== "claude") setStatus("");
  else if (ext.source === "claude") setStatus("");

  $("posting").hidden = false;
  renderFromExt(ext);

  wirePdl(ext);

  $("company").value = ext.company || "";
  if (!ext.company) {
    $("company").placeholder = "Not detected — type the company name";
    setStatus("Company not detected on this page — enter it above to enable company-scoped searches.", true);
  }
  $("company").addEventListener("change", () => rebuild(ext));
  $("rebuild").addEventListener("click", () => rebuild(ext));
  $("copy-bool").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("boolean").value);
    $("copy-bool").textContent = "Copied";
    setTimeout(() => ($("copy-bool").textContent = "Copy"), 1200);
  });
}

main();
