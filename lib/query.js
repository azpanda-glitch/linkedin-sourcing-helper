// Builds Boolean strings and one-click search URLs for both personas
// (sourcer = find people; hiring manager = find related people/posts).

function orGroup(terms) {
  const q = terms.filter(Boolean).map((t) => (t.includes(" ") ? `"${t}"` : t));
  if (q.length === 0) return "";
  return q.length === 1 ? q[0] : `(${q.join(" OR ")})`;
}

// Core Boolean string: (title OR ...) AND (skill OR ...)
export function booleanString(ext, { includeSkills = true, extra = [] } = {}) {
  const parts = [];
  const titleGroup = orGroup(ext.titles);
  if (titleGroup) parts.push(titleGroup);
  if (includeSkills && ext.skills.length) {
    // top skills only — too many ANDs over-constrains
    parts.push(orGroup(ext.skills.slice(0, 4)));
  }
  parts.push(...extra.filter(Boolean));
  return parts.join(" AND ");
}

function enc(s) {
  return encodeURIComponent(s);
}

// LinkedIn people search over keywords.
export function linkedinPeopleUrl(boolean, location) {
  const base = "https://www.linkedin.com/search/results/people/";
  const params = new URLSearchParams({ keywords: boolean, origin: "GLOBAL_SEARCH_HEADER" });
  if (location) params.set("keywords", `${boolean} ${location}`);
  return `${base}?${params.toString()}`;
}

// LinkedIn content/post search.
export function linkedinPostsUrl(boolean) {
  const params = new URLSearchParams({ keywords: boolean, origin: "GLOBAL_SEARCH_HEADER" });
  return `https://www.linkedin.com/search/results/content/?${params.toString()}`;
}

// Google X-ray over public LinkedIn profiles.
export function xrayProfilesUrl(ext, boolean) {
  const bits = ['site:linkedin.com/in'];
  if (boolean) bits.push(boolean);
  if (ext.location) bits.push(`"${ext.location}"`);
  return `https://www.google.com/search?q=${enc(bits.join(" "))}`;
}

// Google X-ray over public LinkedIn posts (proxy for "who's talking about this").
export function xrayPostsUrl(ext, boolean) {
  const bits = ['site:linkedin.com/posts', boolean].filter(Boolean);
  return `https://www.google.com/search?q=${enc(bits.join(" "))}`;
}

// Company-scoped people search ("people at $company with $title").
export function companyPeopleUrl(ext) {
  if (!ext.company) return null;
  const bool = booleanString(ext, { includeSkills: false, extra: [`"${ext.company}"`] });
  return linkedinPeopleUrl(bool, ext.location);
}

// "Open to work" flavored search — best non-partner proxy for hiring status.
const OPEN_TERMS = ["#OpenToWork", "open to work", "seeking", "available"];

export function openToWorkUrl(ext) {
  const bool = booleanString(ext, { includeSkills: true, extra: [orGroup(OPEN_TERMS)] });
  return linkedinPeopleUrl(bool, ext.location);
}

// The role/internship name to anchor searches on: prefer the original posting
// title carried as roleName, else the first extracted title.
function roleName(ext) {
  return (ext.roleName || ext.titles?.[0] || "").trim();
}

// Detect internship / new-grad / early-career postings.
const EARLY_CAREER_RE =
  /\b(intern(ship)?|co-?op|new[\s-]?grad(uate)?|early[\s-]?career|university|campus|apprentic\w*|student)\b/i;

export function isEarlyCareer(ext) {
  const hay = `${roleName(ext)} ${(ext.titles || []).join(" ")}`;
  return EARLY_CAREER_RE.test(hay);
}

// Recruiter title terms — university/early-career flavored for internships.
function recruiterTerms(ext) {
  return isEarlyCareer(ext)
    ? [
        "university recruiter",
        "early career recruiter",
        "campus recruiter",
        "early talent",
        "university talent acquisition"
      ]
    : ["recruiter", "technical recruiter", "talent acquisition", "hiring manager"];
}

// Find the right recruiters at the company (university recruiters for interns).
export function recruiterPeopleUrl(ext) {
  if (!ext.company) return null;
  const bool = `${orGroup(recruiterTerms(ext))} AND "${ext.company}"`;
  return linkedinPeopleUrl(bool, ext.location);
}

// Always-on verification search: exact role name + "hiring" (+ company).
// Surfaces the actual hiring announcement / who's recruiting for this role.
export function roleHiringUrl(ext, { posts = false } = {}) {
  const name = roleName(ext);
  if (!name) return null;
  const parts = [`"${name}"`, "hiring"];
  if (ext.company) parts.push(`"${ext.company}"`);
  const q = parts.join(" ");
  return posts ? linkedinPostsUrl(q) : linkedinPeopleUrl(q, ext.location);
}

// Assemble the full set of links for the popup, grouped by persona.
export function buildQueries(ext) {
  const coreBool = booleanString(ext, { includeSkills: true });
  const titleBool = booleanString(ext, { includeSkills: false });
  const earlyCareer = isEarlyCareer(ext);

  return {
    boolean: coreBool,
    earlyCareer,
    sourcer: [
      { label: "LinkedIn people search", url: linkedinPeopleUrl(coreBool, ext.location) },
      { label: "Google X-ray (profiles)", url: xrayProfilesUrl(ext, titleBool) },
      { label: "People at this company", url: companyPeopleUrl(ext) },
      {
        label: earlyCareer
          ? "University / early-career recruiters"
          : "Recruiters at this company",
        url: recruiterPeopleUrl(ext)
      },
      { label: "Open to work", url: openToWorkUrl(ext) }
    ].filter((x) => x.url),
    hiringManager: [
      { label: '"Role name" + hiring (people)', url: roleHiringUrl(ext) },
      { label: '"Role name" + hiring (posts)', url: roleHiringUrl(ext, { posts: true }) },
      { label: "LinkedIn posts search", url: linkedinPostsUrl(coreBool) },
      { label: "Google X-ray (posts)", url: xrayPostsUrl(ext, titleBool) }
    ].filter((x) => x.url)
  };
}
