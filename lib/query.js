// Builds Boolean strings and one-click search URLs.
//
// IMPORTANT: LinkedIn and Google speak different Boolean dialects.
//
// LinkedIn search:
//   - Supports uppercase AND / OR / NOT and parentheses.
//   - Quoted "exact phrases" work; wildcards (*) do NOT.
//   - Does NOT support field operators like site: / intitle:.
//   - Legacy +term / -term operators are no longer supported.
//
// Google (X-ray):
//   - AND is implicit — writing the word AND just adds noise.
//   - OR must be uppercase; parentheses group OR terms.
//   - Exclusion uses -term (not NOT).
//   - Field operators (site:) are how we scope to LinkedIn profiles/posts.
//
// So every query is assembled per-dialect rather than sharing one string.

export const LINKEDIN = "linkedin";
export const GOOGLE = "google";

// OPERATOR BUDGET — the reason queries must stay small.
//
// LinkedIn caps how many Boolean operators a free account may use in one query,
// does not publish the number, and when you exceed it the search returns NO
// RESULTS rather than an error. Recruiter / Recruiter Lite are uncapped; Sales
// Navigator allows 15. See:
//   https://www.linkedin.com/help/linkedin/answer/a524411
//
// So term lists here are deliberately short and high-signal instead of
// exhaustive — an exhaustive OR-list is worse than useless, it returns nothing.
// Google X-ray has no such limit, which is why the wide searches go there.
export const OPERATOR_BUDGET = 6;

// AND/OR/NOT tokens plus each opening parenthesis (a group is itself an
// operator as far as the cap is concerned).
export function countOperators(bool) {
  const s = String(bool || "");
  return (s.match(/\b(?:AND|OR|NOT)\b/g) || []).length + (s.match(/\(/g) || []).length;
}

export function withinBudget(bool) {
  return countOperators(bool) <= OPERATOR_BUDGET;
}

// Keep the first n terms — callers pass lists ordered most-useful-first.
function top(terms, n) {
  return (terms || []).slice(0, n);
}

function quote(term) {
  const t = String(term).trim();
  if (!t) return "";
  if (t.startsWith("#")) return t; // hashtags must stay bare
  // Quote phrases and hyphenated terms ("co-op"); bare single words are fine.
  if (!/[\s-]/.test(t)) return t;
  return `"${t}"`;
}

// OR-group of alternatives, parenthesized when there's more than one.
function orGroup(terms, dialect = LINKEDIN) {
  const q = (terms || []).map(quote).filter(Boolean);
  if (q.length === 0) return "";
  if (q.length === 1) return q[0];
  return `(${q.join(" OR ")})`;
}

// Join required groups: explicit AND on LinkedIn, implicit (space) on Google.
function andJoin(groups, dialect = LINKEDIN) {
  const g = groups.filter(Boolean);
  return dialect === GOOGLE ? g.join(" ") : g.join(" AND ");
}

// The role/internship name to anchor searches on.
//
// A title that is just the company name is a scrape failure, not a role
// ("Blizzard Entertainment" came from an h1 that held the company). Treating it
// as a role poisons every query, so drop it and let callers degrade to the
// company-only searches.
function roleName(ext) {
  const name = (ext.roleName || ext.titles?.[0] || "").trim();
  const company = (ext.company || "").trim();
  if (company && name.toLowerCase() === company.toLowerCase()) return "";
  return name;
}

// Strip common posting-title noise so quoted phrases still match.
export function cleanRoleName(name) {
  return String(name || "")
    .replace(/\(.*?\)/g, " ")
    .split(/[|·•]/)[0]
    .replace(/\b(full[\s-]?time|part[\s-]?time|remote|hybrid|on[\s-]?site|contract)\b/gi, " ")
    .replace(/[,\-–—]+\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Posting titles carry scheduling and program noise that nobody writes in a
// post or profile ("Summer 2027 Intern - Marketing-Earned Media Specialist").
// Reduce the title to the durable role concept so the search generalizes:
//   "2027 Summer Client Relations"                         -> "Client Relations"
//   "Summer 2027 Intern - Marketing-Earned Media Specialist"-> "Marketing-Earned Media Specialist"
const TITLE_NOISE_RE =
  /\b(intern(ship)?s?|co-?op|program(me)?|new\s*grad(uate)?s?|university|campus|student|undergraduate|graduate|early\s*career|opportunit(y|ies)|requisition|req|job\s*id|full[\s-]?time|part[\s-]?time|remote|hybrid|on[\s-]?site|paid|summer|fall|autumn|winter|spring)\b/gi;

export function generalizeRole(name) {
  let s = String(name || "")
    .replace(/\(.*?\)/g, " ")
    .replace(/#?\b\d{3,}\b/g, " ") // req / job ID numbers
    .replace(/\b(19|20)\d{2}\b/g, " ") // years
    .replace(TITLE_NOISE_RE, " ");

  // Split only on separators that divide phrases (spaced dash, colon, comma,
  // pipe) — never on intra-word hyphens, which would split "Marketing-Earned".
  const segments = s
    .split(/\s+[-–—:]\s+|[|·•:,]/)
    .map((t) => t.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);

  // The longest remaining segment is the descriptive one.
  s = segments.sort((a, b) => b.length - a.length)[0] || "";
  return s.replace(/^[-–—\s,]+|[-–—\s,]+$/g, "").replace(/\s{2,}/g, " ").trim();
}

// ---- Head noun -------------------------------------------------------------
//
// The single most important reduction. A req title is a stack of qualifiers on
// one head noun, and the qualifiers are what nobody else writes:
//   "Consumer Insight Analyst"              -> "analyst"
//   "Marketing-Earned Media Specialist"     -> "specialist"
//   "Software Engineer Intern"              -> "engineer"
// Searching the full phrase requires every qualifier to appear; searching the
// head noun asks for the only word that reliably will.

// Connector words are never the head of a title.
const HEAD_STOP_RE = /^(and|or|of|the|for|in|at|to|with|a|an|&)$/i;
// Level suffixes: "Analyst I", "Engineer II", "Analyst 2".
const LEVEL_SUFFIX_RE = /^(i{1,3}|iv|v|vi{1,3}|ix|x|\d+)$/i;

// Occupation nouns, preferred over positional guessing. English usually puts the
// head last, but job titles often don't: "Sr. Manager, Product Marketing" ends in
// a domain, not a role. Matching this list first yields "manager" there instead of
// "marketing". Extend it freely — it only ever makes the head noun more accurate.
const HEAD_NOUN_WORDS = [
  "analyst", "engineer", "developer", "programmer", "scientist", "architect",
  "designer", "researcher", "manager", "director", "supervisor", "coordinator",
  "administrator", "specialist", "consultant", "strategist", "planner", "buyer",
  "recruiter", "sourcer", "accountant", "auditor", "controller", "actuary",
  "underwriter", "adjuster", "paralegal", "attorney", "counsel", "producer",
  "editor", "writer", "copywriter", "marketer", "technician", "operator",
  "representative", "agent", "advisor", "associate", "assistant", "clerk",
  "nurse", "therapist", "pharmacist", "teacher", "instructor", "trainer",
  "lead", "leader", "head", "chief", "principal", "officer", "president", "vp",
  "partner", "owner", "generalist", "banker", "trader", "economist", "statistician"
];
const HEAD_NOUN_SET = new Set(HEAD_NOUN_WORDS);

function titleWords(name) {
  return String(name || "")
    .replace(/\(.*?\)/g, " ")
    .split(/[\s/&,–—-]+/)
    .map((w) => w.replace(/[^A-Za-z0-9+#]/g, ""))
    .filter(Boolean);
}

// The one word from the title worth searching, lowercased (LinkedIn search is
// case-insensitive, and lowercase reads as a keyword rather than a proper noun).
export function headNoun(name) {
  // Pass 1: a known occupation noun, rightmost first — "Engineering Manager"
  // should give "manager", not "engineering".
  const raw = titleWords(name);
  for (let i = raw.length - 1; i >= 0; i--) {
    const w = raw[i].toLowerCase();
    if (HEAD_NOUN_SET.has(w)) return w;
  }
  // Pass 2: no occupation noun in the title, so fall back to position. Generalize
  // and strip the level first, or noise ("Intern", "Summer", "2027", "II")
  // becomes the head.
  const words = titleWords(ladderBase(generalizeRole(name))).filter(
    (w) => !HEAD_STOP_RE.test(w) && !LEVEL_SUFFIX_RE.test(w) && w.length >= 3
  );
  if (!words.length) return "";
  // A short phrase is the concept ("Machine Learning", "Client Relations") and
  // splitting it destroys the meaning; a long one needs its last word.
  if (words.length <= 2) return words.join(" ").toLowerCase();
  return words[words.length - 1].toLowerCase();
}

export function roleHeadNoun(ext) {
  return headNoun(roleName(ext));
}

// Early-career postings should match how people actually phrase it, including
// the co-op wording many programs use instead of "intern".
//
// Trimmed to three under the operator budget: "interns" and "coop" were dropped
// because they cost an operator each while adding almost nothing next to
// "intern" / "co-op".
const INTERN_TERMS = ["intern", "internship", "co-op"];

function companyGroup(ext, dialect) {
  return ext.company ? quote(ext.company) : "";
}

// The title list actually worth searching.
//
// Two things had been leaking into it. The company name, when the title scrape
// failed, producing `"Blizzard Entertainment" "Blizzard Entertainment"`. And raw
// scheduling noise like "Summer 2027 Intern", which nobody has in a profile. The
// generalized role goes first so the durable concept outranks the raw title.
export function searchTitles(ext) {
  const company = (ext.company || "").trim().toLowerCase();
  const out = [];
  const seen = new Set();
  for (const t of [generalizeRole(roleName(ext)), ...(ext.titles || [])]) {
    const v = String(t || "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (key === company || seen.has(key)) continue;
    // Nothing survives generalization => the title was pure noise.
    if (!generalizeRole(v)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// Core Boolean: (title OR ...) AND (skill OR ...) [AND company] [AND extra]
export function booleanString(ext, opts = {}) {
  const {
    includeSkills = true,
    includeCompany = false,
    extra = [],
    dialect = LINKEDIN
  } = opts;
  // On LinkedIn the lists are trimmed hard to stay inside the operator budget;
  // Google has no cap, so it gets the fuller lists.
  const wide = dialect === GOOGLE;
  const groups = [orGroup(top(searchTitles(ext), wide ? 6 : 3), dialect)];
  if (includeSkills && ext.skills?.length) {
    // Top skills only — too many required groups over-constrains the search.
    groups.push(orGroup(top(ext.skills, wide ? 4 : 2), dialect));
  }
  if (includeCompany) groups.push(companyGroup(ext, dialect));
  groups.push(...extra.filter(Boolean));
  return andJoin(groups, dialect);
}

function enc(s) {
  return encodeURIComponent(s);
}

// ---- Plain keyword searches (no operators) ---------------------------------
//
// WHY THESE EXIST, AND WHY THEY ARE THE DEFAULT:
//
// Boolean strings against LinkedIn's own search kept returning nothing. LinkedIn
// caps operators on free accounts without saying how many, never documents which
// result tabs honor Boolean at all, and has been moving consumer search toward
// natural-language/semantic matching — where a long quoted AND-chain matches
// nothing. Rather than keep guessing at a syntax we cannot test, the LinkedIn
// links now send plain keywords, exactly what a person would type.
//
// Boolean lives on Google X-ray, where it is real, uncapped, and verifiable.

// LinkedIn's `+` syntax: each required term quoted, joined by " + ".
//   "analyst" + "hiring" + "State Farm"
//
// This is what the global search bar gets now. Note that LinkedIn's own help
// pages say the legacy `+` / `-` operators were retired — but AND-chains
// demonstrably returned nothing, so this is the form to test next. Swap
// LINKEDIN_JOINER if `+` also comes up empty; everything routes through it.
export const LINKEDIN_JOINER = " + ";

function quoteAlways(term) {
  const t = String(term || "").trim();
  if (!t) return "";
  if (t.startsWith("#")) return t; // hashtags must stay bare
  if (/^".*"$/.test(t)) return t; // already quoted
  return `"${t}"`;
}

export function plusString(terms) {
  return (terms || [])
    .map(quoteAlways)
    .filter(Boolean)
    .join(LINKEDIN_JOINER);
}

export function keywordString(terms) {
  return (terms || [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ");
}

// LinkedIn's own company People tab — the most reliable people search available
// without Boolean or a partner API, because the company scope comes from the URL
// instead of from a keyword the profile has to contain.
//   linkedin.com/company/<slug>/people/?keywords=university recruiter
export function companyPeopleTabUrl(ext, keywords) {
  if (!ext.companySlug) return null;
  const params = new URLSearchParams({ keywords: keywordString([keywords]) });
  return `https://www.linkedin.com/company/${ext.companySlug}/people/?${params.toString()}`;
}

// ---- LinkedIn URLs ---------------------------------------------------------

// Location is deliberately NOT folded into the keywords: adding a city name to
// a keyword search filters on profile text rather than real geography, which
// dropped the people we actually want. Use LinkedIn's own location facet if
// narrowing is needed.
export function linkedinPeopleUrl(boolean) {
  const params = new URLSearchParams({ keywords: boolean, origin: "GLOBAL_SEARCH_HEADER" });
  return `https://www.linkedin.com/search/results/people/?${params.toString()}`;
}

export function linkedinPostsUrl(boolean) {
  const params = new URLSearchParams({ keywords: boolean, origin: "GLOBAL_SEARCH_HEADER" });
  return `https://www.linkedin.com/search/results/content/?${params.toString()}`;
}

// ---- Google X-ray URLs ----------------------------------------------------

function googleUrl(bits) {
  return `https://www.google.com/search?q=${enc(bits.filter(Boolean).join(" "))}`;
}

export function xrayProfilesUrl(ext) {
  // Google dialect: no AND keywords, site: scopes to public profiles.
  const bool = booleanString(ext, {
    includeSkills: false,
    includeCompany: true,
    dialect: GOOGLE
  });
  return googleUrl(["site:linkedin.com/in", bool]);
}

export function xrayPostsUrl(ext) {
  const bool = booleanString(ext, { includeSkills: false, dialect: GOOGLE });
  return googleUrl(["site:linkedin.com/posts", bool, companyGroup(ext, GOOGLE)]);
}

// Google X-ray for the right recruiters at the company.
export function xrayRecruitersUrl(ext) {
  const bool = orGroup(recruiterTerms(ext), GOOGLE);
  return googleUrl(["site:linkedin.com/in", bool, companyGroup(ext, GOOGLE)]);
}

// ---- Persona searches -----------------------------------------------------

// Company-scoped people search ("people in this role at $company").
export function companyPeopleUrl(ext) {
  if (!ext.company) return null;
  const bool = booleanString(ext, { includeSkills: false, includeCompany: true });
  return linkedinPeopleUrl(bool);
}

// "Open to work" flavored search — best non-partner proxy for hiring status.
// Two terms only, and skills are dropped: with the titles group and the open-to-
// work group this is already at the operator budget.
const OPEN_TERMS = ["#OpenToWork", "open to work"];

export function openToWorkUrl(ext) {
  const bool = booleanString(ext, { includeSkills: false, extra: [orGroup(top(OPEN_TERMS, 2))] });
  return linkedinPeopleUrl(bool);
}

// Detect internship / new-grad / early-career postings.
const EARLY_CAREER_RE =
  /\b(intern(ship)?s?|co-?op|new[\s-]?grad(uate)?s?|early[\s-]?career|early[\s-]?talent|university|campus|apprentice(ship)?|student|entry[\s-]?level|rotational|summer\s+20\d\d)\b/i;

export function isEarlyCareer(ext) {
  const hay = `${roleName(ext)} ${(ext.titles || []).join(" ")} ${ext.description || ""}`;
  return EARLY_CAREER_RE.test(hay);
}

// Early-career recruiting goes by many names, and at tech companies the people
// who own intern/new-grad pipelines are often titled "technical sourcer" or
// "engineering recruiter" rather than anything with "university" in it.
// Ordered most-distinct-first, because only the leading few survive the
// operator budget on LinkedIn. Near-duplicates ("university recruiting" next to
// "university recruiter") are pushed to the back where they only affect the
// uncapped Google X-ray.
const EARLY_CAREER_RECRUITER_TERMS = [
  "university recruiter",
  "campus recruiter",
  "early career",
  "technical recruiter",
  "university recruiting",
  "campus recruiting",
  "early career recruiter",
  "early careers",
  "early talent",
  "emerging talent",
  "student programs",
  "intern program",
  "new grad recruiter",
  "technical sourcer",
  "engineering recruiter"
];

const STANDARD_RECRUITER_TERMS = [
  "recruiter",
  "talent acquisition",
  "technical sourcer",
  "hiring manager",
  "technical recruiter",
  "engineering recruiter"
];

export function recruiterTerms(ext) {
  return isEarlyCareer(ext) ? EARLY_CAREER_RECRUITER_TERMS : STANDARD_RECRUITER_TERMS;
}

// Recruiters at the company — company is always required here.
//
// Only the first few terms go into the LinkedIn query: the full 14-term list
// costs 15 operators and returns nothing on a free account. The complete list
// is still used for the Google X-ray, which has no operator cap.
export function recruiterPeopleUrl(ext) {
  if (!ext.company) return null;
  const bool = andJoin([orGroup(top(recruiterTerms(ext), 4)), companyGroup(ext)], LINKEDIN);
  return linkedinPeopleUrl(bool);
}

// Who actually decides on a hire, by level.
//
// For full-time roles this is the hiring manager / eng leadership. For
// internships it is deliberately NOT tech leads or directors: intern
// req owners are front-line managers, and the people who pick and run interns
// are hosts, mentors and program coordinators — a fair bit lower in the org.
const MANAGER_TERMS = [
  "hiring manager",
  "engineering manager",
  "software development manager",
  "director of engineering",
  "team lead",
  "tech lead"
];

const EARLY_CAREER_MANAGER_TERMS = [
  "intern manager",
  "intern host",
  "intern mentor",
  "intern coordinator",
  "intern program manager",
  "engineering manager",
  "software development manager",
  "development manager",
  "mentor"
];

export function managerTerms(ext) {
  return isEarlyCareer(ext) ? EARLY_CAREER_MANAGER_TERMS : MANAGER_TERMS;
}

// Only search for a manager when the posting actually names the reporting line
// ("you will report to the Client Relations Manager"). Guessing at manager
// titles otherwise returns leadership who have nothing to do with the req.
const REPORTS_TO_RE = [
  /\breport(?:s|ing)?\s+(?:directly\s+)?(?:in)?to:?\s*(?:the\s+|a\s+|an\s+|our\s+)?([A-Za-z][A-Za-z0-9/&,'\- ]{2,60})/i,
  /\byou(?:'ll| will)?\s+report\s+to:?\s*(?:the\s+|a\s+|an\s+|our\s+)?([A-Za-z][A-Za-z0-9/&,'\- ]{2,60})/i,
  /\bthis (?:role|position)\s+reports\s+to:?\s*(?:the\s+|a\s+|an\s+|our\s+)?([A-Za-z][A-Za-z0-9/&,'\- ]{2,60})/i
];

// Words that start the prose following a title. "of" and "&" are deliberately
// absent — they appear inside real titles ("Director of Marketing").
const CLAUSE_BOUNDARY_RE =
  /\s\b(?:and|who|which|that|you|we|they|where|with|while|as|in|into|within|on|at|to|for|based|located|reporting|along|plus|supporting)\b/i;

// A reporting line always names someone's title. Requiring a role noun keeps
// prose like "reporting to stakeholders on campaign metrics" out.
const ROLE_NOUN_RE =
  /\b(manager|director|lead|leader|head|supervisor|principal|chief|vp|president|owner|coordinator|partner|architect|engineer|officer|specialist|analyst|producer|editor|recruiter|scientist|designer|controller)\b/i;

export function extractReportsTo(description) {
  const text = String(description || "");
  for (const re of REPORTS_TO_RE) {
    const m = text.match(re);
    if (!m) continue;
    const title = m[1]
      // cut at the clause boundary so we keep just the title
      .split(CLAUSE_BOUNDARY_RE)[0]
      .replace(/\s{2,}/g, " ")
      .replace(/[,;.\s-]+$/, "")
      .trim();
    // Reject sentence fragments that clearly aren't a job title.
    if (title.split(/\s+/).length > 6 || title.length < 3) continue;
    if (!ROLE_NOUN_RE.test(title)) continue;
    return title;
  }
  return "";
}

// Manager search, only meaningful when a reporting line was found. The company
// narrows it when known, but the title alone is still a usable search.
export function reportsToUrl(ext) {
  const title = extractReportsTo(ext.description);
  if (!title) return null;
  return linkedinPeopleUrl(andJoin([quote(title), companyGroup(ext)], LINKEDIN));
}

export function hiringManagerUrl(ext) {
  if (!ext.company) return null;
  const bool = andJoin([orGroup(managerTerms(ext)), companyGroup(ext)], LINKEDIN);
  return linkedinPeopleUrl(bool);
}

// ---- Level ladder ---------------------------------------------------------
// The people worth talking to about an internship are the ones a step or two
// up the same ladder, not leadership: a Software Engineer Intern maps to
// SWE I/II and Senior SWE.

const ABBREVIATIONS = [
  [/\bsoftware development engineer\b/i, "SDE"],
  [/\bsoftware engineer\b/i, "SWE"],
  [/\bproduct manager\b/i, "PM"],
  [/\bprogram manager\b/i, "TPM"]
];

// Strip any level already present so we can re-add a clean ladder.
function ladderBase(role) {
  return String(role || "")
    .replace(/\b(senior|sr\.?|junior|jr\.?|associate|staff|principal|lead|entry[\s-]?level)\b/gi, " ")
    .replace(/\b(i{1,3}|iv|v|[1-5])\b\s*$/i, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Ordered by how much each term adds, because only the leading few fit the
// operator budget. The unsuffixed base comes first: it already matches "Software
// Engineer II" as a phrase prefix in practice, so the numbered variants are the
// cheapest things to drop.
export function ladderTerms(ext) {
  const base = ladderBase(generalizeRole(roleName(ext)));
  if (!base) return [];
  const abbr = (ABBREVIATIONS.find(([re]) => re.test(base)) || [])[1];
  const terms = [base, `Senior ${base}`];
  if (abbr) terms.push(abbr, `Senior ${abbr}`);
  terms.push(`${base} II`, `${base} I`, `${base} 2`, `${base} 1`, `Junior ${base}`, `Associate ${base}`);
  if (abbr) terms.push(`${abbr} II`, `${abbr} I`, `${abbr} 2`, `${abbr} 1`);
  return terms;
}

// Entry-level peers on the same ladder at the company.
export function ladderPeopleUrl(ext) {
  const terms = top(ladderTerms(ext), 4);
  if (!terms.length) return null;
  return linkedinPeopleUrl(andJoin([orGroup(terms), companyGroup(ext)], LINKEDIN));
}

// The primary query: generalized role concept AND company AND exact "hiring".
// "hiring" is the one term quoted verbatim — it's the signal that the post is
// an actual announcement rather than an unrelated mention.
//   "Client Relations" AND (intern OR interns OR internship)
//     AND "State Farm" AND "hiring"
export function roleHiringBoolean(ext) {
  const role = generalizeRole(roleName(ext));
  if (!role) return "";
  const groups = [quote(role)];
  if (isEarlyCareer(ext)) groups.push(orGroup(INTERN_TERMS));
  groups.push(companyGroup(ext), '"hiring"');
  return andJoin(groups, LINKEDIN);
}

export function roleHiringUrl(ext, { posts = true } = {}) {
  const bool = roleHiringBoolean(ext);
  if (!bool) return null;
  return posts ? linkedinPostsUrl(bool) : linkedinPeopleUrl(bool);
}

// People currently in this role at the company.
//
// Deliberately WITHOUT "hiring": on the People tab every AND term must appear in
// the profile itself, and almost nobody writes "hiring" in their profile — so
// role AND company AND "hiring" reliably returns nothing. "hiring" only belongs
// in a Posts query, where it is what the post says.
export function rolePeopleUrl(ext) {
  const role = generalizeRole(roleName(ext));
  if (!role) return null;
  return linkedinPeopleUrl(andJoin([quote(role), companyGroup(ext)], LINKEDIN));
}

// Broad early-career variant: skip the role phrase entirely. Team-specific
// titles ("Marketing-Earned Media Specialist") rarely appear in the post
// announcing the req, so intern + company + "hiring" catches announcements the
// role-specific query misses. This is also the only usable query when the
// posting title couldn't be read.
//   (intern OR interns OR internship OR "co-op" OR coop)
//     AND "Blizzard Entertainment" AND "hiring"
export function internHiringBoolean(ext) {
  if (!ext.company) return "";
  return andJoin([orGroup(INTERN_TERMS), companyGroup(ext), '"hiring"'], LINKEDIN);
}

export function internHiringUrl(ext, { posts = true } = {}) {
  const bool = internHiringBoolean(ext);
  if (!bool) return null;
  return posts ? linkedinPostsUrl(bool) : linkedinPeopleUrl(bool);
}

// ---- Description-derived searches -----------------------------------------
//
// The team name and program name come from the posting body (see
// lib/extract.js). They are the highest-value things in a description for a job
// seeker: "<team> at <company>" finds the people you'd actually work with, and
// the program name is what past interns and their recruiters put in a profile.

export function teamPeopleUrl(ext) {
  if (!ext.team) return null;
  return (
    companyPeopleTabUrl(ext, ext.team) ||
    linkedinPeopleUrl(keywordString([ext.team, ext.company]))
  );
}

export function teamPostsUrl(ext) {
  if (!ext.team) return null;
  return linkedinPostsUrl(plusString([ext.team, "hiring", ext.company]));
}

// Program name is usually distinctive enough to search on its own; the company
// is added only as an extra keyword, not a hard scope.
export function programPeopleUrl(ext) {
  if (!ext.program) return null;
  // Quoted as one phrase: the program name only means anything intact.
  return linkedinPeopleUrl(plusString([ext.program]));
}

// Kept as an escape hatch for when the generalized phrase is too loose.
export function exactTitleUrl(ext) {
  const name = cleanRoleName(roleName(ext));
  if (!name) return null;
  return linkedinPostsUrl(andJoin([quote(name), companyGroup(ext)], LINKEDIN));
}

// ---- Assembly -------------------------------------------------------------

export function buildQueries(ext) {
  // Boolean is still built, but only the Google X-ray links consume it.
  const broadBool = booleanString(ext, { includeSkills: true });
  const earlyCareer = isEarlyCareer(ext);
  const recruiterLabel = earlyCareer
    ? "University / early-career recruiters"
    : "Recruiters";

  // A manager search is only offered when the posting states the reporting
  // line; otherwise we point at the ladder instead of guessing titles.
  // Regex on the raw text first; Claude's reading is only a fallback, because a
  // literal match in the posting is stronger evidence than a model's summary.
  const reportsTo = extractReportsTo(ext.description) || (ext.reportsToHint || "").trim();
  const base = ladderBase(generalizeRole(roleName(ext)));
  const ladderLabel = base ? `${base} (peers)` : "Same-ladder peers";

  const role = generalizeRole(roleName(ext));
  const company = ext.company || "";
  // "Consumer Insight Analyst" -> "analyst". The qualifiers in a req title are
  // exactly the words nobody else uses, so the head noun is what gets searched.
  const head = roleHeadNoun(ext);

  // LinkedIn `+` syntax, head noun first:  "analyst" + "hiring" + "State Farm"
  const rolePostKeywords = head ? plusString([head, "hiring", company]) : "";
  // The full phrase, kept as a narrower second option when it differs.
  const exactRoleKeywords = role ? plusString([role, "hiring", company]) : "";
  const internPostKeywords = company ? plusString(["intern", "hiring", company]) : "";
  // Last resort when the role couldn't be read at all: everything the company is
  // hiring for. Each of these is empty unless its own inputs exist, so the box
  // never shows a query that no link actually runs.
  const companyHiringKeywords = company ? plusString(["hiring", company]) : "";
  const shown =
    rolePostKeywords || (earlyCareer ? internPostKeywords : companyHiringKeywords);

  const recruiterKeyword = earlyCareer ? "university recruiter" : "recruiter";

  return {
    // The editable box now holds plain keywords, matching what the LinkedIn
    // links use. The Boolean forms are still exported for the Google links.
    boolean: shown,
    broadBoolean: broadBool,
    // A count of 0 is the expected, healthy state for LinkedIn searches now.
    operatorCount: countOperators(shown),
    operatorBudget: OPERATOR_BUDGET,
    earlyCareer,
    // Surfaced in the popup so a bad read is visible instead of silent.
    rolePhrase: role,
    headNoun: head,
    reportsTo,
    team: ext.team || "",
    program: ext.program || "",
    keyPhrases: ext.keyPhrases || [],
    hiringManager: [
      // `editable` marks the links the keyword box drives.
      head
        ? {
            label: `Posts: ${rolePostKeywords}`,
            url: linkedinPostsUrl(rolePostKeywords),
            editable: true
          }
        : companyHiringKeywords
          ? {
              // No role was readable — search everything the company is hiring
              // for rather than dropping the primary link entirely.
              label: `Posts: ${companyHiringKeywords}`,
              url: linkedinPostsUrl(companyHiringKeywords),
              editable: true
            }
          : { label: "", url: null },
      // Narrower fallback for when the head noun is too broad. Second, because
      // the full phrase is the one that returns nothing.
      role && role.toLowerCase() !== head
        ? { label: `Posts: ${exactRoleKeywords} (narrower)`, url: linkedinPostsUrl(exactRoleKeywords) }
        : { label: "", url: null },
      // Broad variant: team-specific titles rarely appear in the announcement.
      earlyCareer && company
        ? { label: `Posts: ${internPostKeywords}`, url: linkedinPostsUrl(internPostKeywords) }
        : { label: "", url: null },
      // From the description: the named team is the most specific hiring signal
      // available, and far more likely to appear in a post than the req title.
      ext.team
        ? { label: `Posts: ${plusString([ext.team, "hiring", company])}`, url: teamPostsUrl(ext) }
        : { label: "", url: null },
      // Only when the posting names the reporting line. No guessed titles.
      // The People tab takes plain keywords: its company scope is in the URL, so
      // there is nothing here for `+` to join.
      reportsTo
        ? {
            label: `Reports to: ${reportsTo}`,
            url:
              companyPeopleTabUrl(ext, reportsTo) ||
              linkedinPeopleUrl(plusString([reportsTo, company]))
          }
        : { label: "", url: null },
      // Boolean belongs here: Google honors it, uncapped and testable.
      { label: "Google X-ray: posts (Boolean)", url: xrayPostsUrl(ext) }
    ].filter((x) => x.url),
    sourcer: [
      // Description-derived first: these are specific to this posting, unlike
      // the generic recruiter/ladder term lists below.
      ext.team
        ? { label: `${ext.team} team members`, url: teamPeopleUrl(ext) }
        : { label: "", url: null },
      ext.program
        ? { label: `${ext.program} alumni & recruiters`, url: programPeopleUrl(ext) }
        : { label: "", url: null },
      // The dominant theme of the responsibilities, in the posting's own words —
      // this finds the people who actually do the work, which the generic role
      // ladder misses on non-technical postings.
      ext.keyPhrases?.[0]
        ? {
            label: `People doing “${ext.keyPhrases[0]}”`,
            url:
              companyPeopleTabUrl(ext, ext.keyPhrases[0]) ||
              linkedinPeopleUrl(plusString([ext.keyPhrases[0], company]))
          }
        : { label: "", url: null },
      // Best available people search without Boolean or a partner API: the
      // company's own People tab, scoped by URL rather than by keyword. Plain
      // keywords here on purpose — the tab filters profile text, so quoting and
      // `+` only narrow a search that is already company-scoped.
      { label: `${recruiterLabel} (company People tab)`, url: companyPeopleTabUrl(ext, recruiterKeyword) },
      // Peers by head noun: "analyst" finds the ladder, "Consumer Insight
      // Analyst" finds the one person who held this exact req.
      head
        ? { label: `${head} peers (company People tab)`, url: companyPeopleTabUrl(ext, head) }
        : { label: "", url: null },
      base && base.toLowerCase() !== head
        ? { label: `${ladderLabel} (company People tab, narrower)`, url: companyPeopleTabUrl(ext, base) }
        : { label: "", url: null },
      // Fallbacks for when the company slug wasn't found and the search has to go
      // through the global bar, where `+` applies.
      { label: `${recruiterLabel} (search bar)`, url: linkedinPeopleUrl(plusString([recruiterKeyword, company])) },
      head
        ? { label: `${head} peers (search bar)`, url: linkedinPeopleUrl(plusString([head, company])) }
        : { label: "", url: null },
      { label: `${recruiterLabel} (Google X-ray)`, url: xrayRecruitersUrl(ext) },
      { label: "Google X-ray: profiles (Boolean)", url: xrayProfilesUrl(ext) }
    ].filter((x) => x.url)
  };
}
