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

function quote(term) {
  const t = String(term).trim();
  if (!t) return "";
  // Hashtags and single words don't need quoting; phrases do.
  if (t.startsWith("#") || !/\s/.test(t)) return t;
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
function roleName(ext) {
  return (ext.roleName || ext.titles?.[0] || "").trim();
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

function companyGroup(ext, dialect) {
  return ext.company ? quote(ext.company) : "";
}

// Core Boolean: (title OR ...) AND (skill OR ...) [AND company] [AND extra]
export function booleanString(ext, opts = {}) {
  const {
    includeSkills = true,
    includeCompany = false,
    extra = [],
    dialect = LINKEDIN
  } = opts;
  const groups = [orGroup(ext.titles, dialect)];
  if (includeSkills && ext.skills?.length) {
    // Top skills only — too many required groups over-constrains the search.
    groups.push(orGroup(ext.skills.slice(0, 4), dialect));
  }
  if (includeCompany) groups.push(companyGroup(ext, dialect));
  groups.push(...extra.filter(Boolean));
  return andJoin(groups, dialect);
}

function enc(s) {
  return encodeURIComponent(s);
}

// ---- LinkedIn URLs ---------------------------------------------------------

export function linkedinPeopleUrl(boolean, location) {
  const keywords = location ? `${boolean} ${quote(location)}` : boolean;
  const params = new URLSearchParams({ keywords, origin: "GLOBAL_SEARCH_HEADER" });
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
  return googleUrl(["site:linkedin.com/in", bool, ext.location ? quote(ext.location) : ""]);
}

export function xrayPostsUrl(ext) {
  const bool = booleanString(ext, { includeSkills: false, dialect: GOOGLE });
  return googleUrl(["site:linkedin.com/posts", bool, companyGroup(ext, GOOGLE)]);
}

// Google X-ray for the right recruiters at the company.
export function xrayRecruitersUrl(ext) {
  const bool = orGroup(recruiterTerms(ext), GOOGLE);
  return googleUrl([
    "site:linkedin.com/in",
    bool,
    companyGroup(ext, GOOGLE),
    ext.location ? quote(ext.location) : ""
  ]);
}

// ---- Persona searches -----------------------------------------------------

// Company-scoped people search ("people in this role at $company").
export function companyPeopleUrl(ext) {
  if (!ext.company) return null;
  const bool = booleanString(ext, { includeSkills: false, includeCompany: true });
  return linkedinPeopleUrl(bool, ext.location);
}

// "Open to work" flavored search — best non-partner proxy for hiring status.
const OPEN_TERMS = ["#OpenToWork", "open to work", "seeking", "available"];

export function openToWorkUrl(ext) {
  const bool = booleanString(ext, { extra: [orGroup(OPEN_TERMS)] });
  return linkedinPeopleUrl(bool, ext.location);
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
const EARLY_CAREER_RECRUITER_TERMS = [
  "university recruiter",
  "university recruiting",
  "campus recruiter",
  "campus recruiting",
  "early career recruiter",
  "early careers",
  "early talent",
  "emerging talent",
  "student programs",
  "intern program",
  "new grad recruiter",
  "technical recruiter",
  "technical sourcer",
  "engineering recruiter"
];

const STANDARD_RECRUITER_TERMS = [
  "recruiter",
  "technical recruiter",
  "talent acquisition",
  "technical sourcer",
  "engineering recruiter",
  "hiring manager"
];

export function recruiterTerms(ext) {
  return isEarlyCareer(ext) ? EARLY_CAREER_RECRUITER_TERMS : STANDARD_RECRUITER_TERMS;
}

// Recruiters at the company — company is always required here.
export function recruiterPeopleUrl(ext) {
  if (!ext.company) return null;
  const bool = andJoin([orGroup(recruiterTerms(ext)), companyGroup(ext)], LINKEDIN);
  return linkedinPeopleUrl(bool, ext.location);
}

// Hiring managers / team leads for the role's domain at the company.
const MANAGER_TERMS = [
  "hiring manager",
  "engineering manager",
  "software development manager",
  "director of engineering",
  "team lead",
  "tech lead"
];

export function hiringManagerUrl(ext) {
  if (!ext.company) return null;
  const bool = andJoin([orGroup(MANAGER_TERMS), companyGroup(ext)], LINKEDIN);
  return linkedinPeopleUrl(bool, ext.location);
}

// Always-on verification search: exact role name + "hiring" + company.
export function roleHiringUrl(ext, { posts = false } = {}) {
  const name = cleanRoleName(roleName(ext));
  if (!name) return null;
  const bool = andJoin([quote(name), "hiring", companyGroup(ext)], LINKEDIN);
  return posts ? linkedinPostsUrl(bool) : linkedinPeopleUrl(bool, ext.location);
}

// ---- Assembly -------------------------------------------------------------

export function buildQueries(ext) {
  const coreBool = booleanString(ext, { includeSkills: true });
  const earlyCareer = isEarlyCareer(ext);
  const recruiterLabel = earlyCareer
    ? "University / early-career recruiters"
    : "Recruiters at this company";

  return {
    boolean: coreBool,
    earlyCareer,
    sourcer: [
      { label: "LinkedIn people search", url: linkedinPeopleUrl(coreBool, ext.location) },
      { label: "People in this role at company", url: companyPeopleUrl(ext) },
      { label: recruiterLabel, url: recruiterPeopleUrl(ext) },
      { label: `${recruiterLabel} (Google X-ray)`, url: xrayRecruitersUrl(ext) },
      { label: "Google X-ray (profiles)", url: xrayProfilesUrl(ext) },
      { label: "Open to work", url: openToWorkUrl(ext) }
    ].filter((x) => x.url),
    hiringManager: [
      { label: "Hiring managers / eng leads at company", url: hiringManagerUrl(ext) },
      { label: '"Role" + hiring + company (people)', url: roleHiringUrl(ext) },
      { label: '"Role" + hiring + company (posts)', url: roleHiringUrl(ext, { posts: true }) },
      { label: "LinkedIn posts search", url: linkedinPostsUrl(coreBool) },
      { label: "Google X-ray (posts)", url: xrayPostsUrl(ext) }
    ].filter((x) => x.url)
  };
}
