// Service worker: proxies Claude extraction so the API key and CORS handling
// stay out of page context. Falls back to null on any failure (popup then
// uses local extraction).

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// The reader is a job seeker trying to find the right humans to talk to, so the
// fields asked for here are the ones that name humans: the team, the program,
// the reporting line. Titles/skills alone produced generic searches.
const SYSTEM_PROMPT = `You extract structured signals from a job posting for a job seeker who wants to find the right people to contact.
Return ONLY minified JSON matching:
{"titles":[string],"skills":[string],"team":string,"program":string,"reportsTo":string,"keyPhrases":[string],"company":string,"location":string}
- titles: 3-6 likely job titles a matching candidate would use, including seniority and common synonyms/abbreviations (e.g. "Senior Software Engineer","SDE").
- skills: up to 10 concrete skills/technologies/domain competencies named or strongly implied. For non-technical roles use the domain terms the posting actually uses (e.g. "media relations","earned media"), not technologies.
- team: the specific team/org/group/division the role sits in, exactly as named in the posting (e.g. "Earned Media","Payments Platform"). "" if not stated. Do NOT guess from the title.
- program: the named early-career/internship program, if any (e.g. "State Farm University Internship Program"). "" otherwise.
- reportsTo: the job title this role reports to, if the posting states one (e.g. "Director of Analytics"). "" otherwise. Never invent one.
- keyPhrases: up to 5 short phrases that are the recurring themes of the responsibilities/qualifications, in the posting's own words.
- company/location: as stated, else "".
Anything not actually stated in the posting must be "" or []. No prose, no markdown fences.`;

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
      keyPhrases: Array.isArray(parsed.keyPhrases) ? parsed.keyPhrases : [],
      team: typeof parsed.team === "string" ? parsed.team.trim() : "",
      program: typeof parsed.program === "string" ? parsed.program.trim() : "",
      // Claude's reading of the reporting line, used only when the regex in
      // lib/query.js finds nothing in the raw text.
      reportsToHint: typeof parsed.reportsTo === "string" ? parsed.reportsTo.trim() : "",
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

// At tech companies the people who own intern/new-grad pipelines are often
// titled "technical sourcer" / "engineering recruiter", not "university".
const EARLY_CAREER_RECRUITER_TERMS = [
  "university recruiter", "university recruiting", "campus recruiter",
  "campus recruiting", "early career recruiter", "early careers",
  "early talent", "emerging talent", "student programs", "intern program",
  "new grad recruiter", "technical recruiter", "technical sourcer",
  "engineering recruiter"
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

  // Company only. A location filter here excluded too many valid people
  // (remote recruiters, HQ-based staff) for the value it added.
  const must = [{ match: { job_company_name: company } }];

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
