// Service worker: proxies Claude extraction so the API key and CORS handling
// stay out of page context. Falls back to null on any failure (popup then
// uses local extraction).

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You extract structured sourcing signals from a job posting.
Return ONLY minified JSON matching:
{"titles":[string],"skills":[string],"company":string,"location":string}
- titles: 3-6 likely job titles a matching candidate would use, including seniority and common synonyms/abbreviations (e.g. "Senior Software Engineer","SDE").
- skills: up to 10 concrete skills/technologies named or strongly implied.
- company/location: as stated, else "".
No prose, no markdown fences.`;

async function extractWithClaude(posting) {
  const { anthropicApiKey, model } = await chrome.storage.sync.get(["anthropicApiKey", "model"]);
  if (!anthropicApiKey) return { ok: false, error: "no-key" };

  const userContent = `TITLE: ${posting.title}
COMPANY: ${posting.company}
LOCATION: ${posting.location}
DESCRIPTION:
${(posting.description || "").slice(0, 8000)}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }]
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    return { ok: false, error: `api-${resp.status}`, detail: body.slice(0, 500) };
  }

  const data = await resp.json();
  const raw = (data.content?.[0]?.text || "").trim().replace(/^```(json)?|```$/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "parse", detail: raw.slice(0, 300) };
  }

  return {
    ok: true,
    ext: {
      titles: Array.isArray(parsed.titles) ? parsed.titles : [],
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      company: parsed.company || posting.company || "",
      location: parsed.location || posting.location || "",
      source: "claude"
    }
  };
}

// ---- People Data Labs person search ----------------------------------------
// mode "recruiters": people in HR/recruiting/hiring-manager roles at the company
//   (who a job seeker would contact). mode "peers": people already in the role.

const RECRUITER_TITLE_TERMS = [
  "recruiter", "technical recruiter", "talent acquisition",
  "hiring manager", "talent partner", "sourcer", "people operations"
];

const EARLY_CAREER_RECRUITER_TERMS = [
  "university recruiter", "early career recruiter", "campus recruiter",
  "early talent", "university talent acquisition", "early careers"
];

function pdlQuery({ company, titles, location, mode, earlyCareer }) {
  const should = [];
  if (mode === "recruiters") {
    const terms = earlyCareer ? EARLY_CAREER_RECRUITER_TERMS : RECRUITER_TITLE_TERMS;
    for (const t of terms) should.push({ match: { job_title: t } });
    should.push({ term: { job_title_role: "human_resources" } });
  } else {
    for (const t of (titles || []).slice(0, 6)) should.push({ match: { job_title: t } });
  }

  const must = [{ match: { job_company_name: company } }];
  if (location) must.push({ match: { location_name: location } });

  return {
    bool: {
      must,
      should,
      minimum_should_match: should.length ? 1 : 0
    }
  };
}

async function pdlSearch(params) {
  const { pdlApiKey } = await chrome.storage.sync.get(["pdlApiKey"]);
  if (!pdlApiKey) return { ok: false, error: "no-key" };
  if (!params.company) return { ok: false, error: "no-company" };

  const resp = await fetch("https://api.peopledatalabs.com/v5/person/search", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Api-Key": pdlApiKey },
    body: JSON.stringify({ query: pdlQuery(params), size: 10, pretty: false })
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { ok: false, error: `api-${resp.status}`, detail: (data?.error?.message || "").slice(0, 300) };
  }

  const people = (data.data || []).map((p) => ({
    name: p.full_name || "(name withheld)",
    title: p.job_title || "",
    company: p.job_company_name || "",
    location: p.location_name || "",
    linkedin: p.linkedin_url ? (/^https?:\/\//.test(p.linkedin_url) ? p.linkedin_url : `https://www.${p.linkedin_url}`) : ""
  }));
  return { ok: true, people, total: data.total ?? people.length };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PDL_SEARCH") {
    pdlSearch(msg.params)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: "exception", detail: String(e) }));
    return true;
  }
  if (msg?.type === "EXTRACT_CLAUDE") {
    extractWithClaude(msg.posting)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: "exception", detail: String(e) }));
    return true; // async
  }
});
