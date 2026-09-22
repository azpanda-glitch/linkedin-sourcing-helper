// Rule-based extraction: pull candidate job titles and skills out of a
// posting with no network calls. Coarser than the Claude path but free/offline.

// Common skill/tech terms. Extend freely — this is the maintained term list.
export const SKILL_DICTIONARY = [
  // languages
  "java", "python", "javascript", "typescript", "go", "golang", "rust", "c++",
  "c#", "kotlin", "scala", "ruby", "swift", "php", "sql",
  // web / frontend
  "react", "angular", "vue", "next.js", "node.js", "graphql", "html", "css",
  // cloud / infra
  "aws", "azure", "gcp", "kubernetes", "docker", "terraform", "ansible",
  "lambda", "ec2", "s3", "dynamodb", "serverless", "microservices",
  // data / ml
  "machine learning", "deep learning", "nlp", "pytorch", "tensorflow",
  "spark", "hadoop", "kafka", "airflow", "etl", "data engineering",
  "data science", "llm", "generative ai", "computer vision",
  // practices
  "ci/cd", "devops", "agile", "scrum", "rest", "grpc", "distributed systems",
  // roles-as-skills
  "product management", "ux", "ui", "figma"
];

// Seniority modifiers that help title matching.
const SENIORITY = ["principal", "staff", "senior", "sr", "lead", "junior", "jr", "entry"];

const TITLE_KEYWORDS = [
  "engineer", "developer", "manager", "architect", "scientist", "analyst",
  "designer", "recruiter", "sourcer", "director", "specialist", "consultant",
  "administrator", "lead"
];

function normalize(s) {
  return (s || "").toLowerCase();
}

// Pull out the qualifications/requirements portion of a posting, where the
// signal is densest. Falls back to the whole text when no heading matches.
const QUAL_HEADING_RE =
  /\b(basic|minimum|preferred)?\s*(qualifications|requirements|what you'?ll need|what we'?re looking for|about you|skills)\b/i;

export function qualificationsSection(text) {
  const t = String(text || "");
  const idx = t.search(QUAL_HEADING_RE);
  if (idx === -1) return t;
  // Take from the first qualifications heading onward, capped so a single
  // enormous posting doesn't drown the frequency counts.
  return t.slice(idx, idx + 4000);
}

function countOccurrences(hay, term) {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9+#.])${esc}([^a-z0-9+#.]|$)`, "gi");
  return (hay.match(re) || []).length;
}

// Extract skills, ranked by how strongly the posting emphasizes them:
// mentions anywhere + a bonus for appearing in the qualifications section.
export function extractSkills(text, limit = 6) {
  const full = normalize(text);
  const quals = normalize(qualificationsSection(text));
  const scored = [];
  for (const skill of SKILL_DICTIONARY) {
    const n = countOccurrences(full, skill);
    if (!n) continue;
    const inQuals = countOccurrences(quals, skill) > 0 ? 2 : 0;
    scored.push({ skill, score: n + inQuals });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.skill);
}

// Derive candidate titles from the posting title plus keyword scan of the body.
export function extractTitles(postingTitle, description) {
  const titles = new Set();
  const cleanTitle = (postingTitle || "").split(/[,|\-–—(]/)[0].trim();
  if (cleanTitle) titles.add(cleanTitle);

  const words = normalize(`${postingTitle} ${description}`).split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (TITLE_KEYWORDS.includes(words[i])) {
      const prev = words[i - 1] || "";
      const twoBack = words[i - 2] || "";
      if (SENIORITY.includes(twoBack) && /^[a-z]+$/.test(prev)) {
        titles.add(`${twoBack} ${prev} ${words[i]}`);
      } else if (/^[a-z+#.]+$/.test(prev) && prev.length > 2) {
        titles.add(`${prev} ${words[i]}`);
      }
    }
  }
  return [...titles].slice(0, 6);
}

// Lightweight synonym expansion for common role words.
const SYNONYMS = {
  "software engineer": ["software developer", "swe", "sde"],
  "developer": ["engineer", "programmer"],
  "engineer": ["developer"],
  "manager": ["lead", "head of"],
  "data scientist": ["ml engineer", "machine learning engineer"],
  "recruiter": ["talent acquisition", "talent partner"]
};

export function expandSynonyms(titles) {
  const out = new Set(titles);
  for (const t of titles) {
    const key = normalize(t);
    for (const [base, syns] of Object.entries(SYNONYMS)) {
      if (key.includes(base)) syns.forEach((s) => out.add(s));
    }
  }
  return [...out];
}

// ---- Description signals ---------------------------------------------------
//
// These are the reason to read the body at all. A job seeker can act on the team
// name, the program name and the reporting line; they cannot act on a skill list.
// Each is matched only in Title Case, which is what separates a real team name
// ("the Earned Media team") from prose ("work with the whole team").

const GENERIC_PHRASE_RE =
  /^(our|the|this|that|a|an|one|new|great|best|other|same|cross|multiple|various|different|several|many|small|large|global|entire|whole|core|key|you|we|us|i|it|all|both|more|most|each|every)$/i;

// A Title Case phrase, allowing the lowercase connectors that appear inside real
// org names ("Story and Franchise Development", "Head of Talent"). Without them
// the phrase stops at the connector and the match fails entirely.
const CAP_WORD = "[A-Z][A-Za-z0-9&/'’-]*";
const CAP_PHRASE = `${CAP_WORD}(?:\\s+(?:and|of|&|for)\\s+${CAP_WORD}|\\s+${CAP_WORD}){0,3}`;

// These patterns are deliberately case-sensitive: Title Case is what separates a
// real org name from prose ("the whole team"). But the leading verb/article is
// often sentence-initial and capitalized, so only its first letter is relaxed.
const anyCase = (s) => s.replace(/^([a-z])/, (c) => `[${c.toUpperCase()}${c}]`);
const alt = (words) => words.map(anyCase).join("|");

const TEAM_LEAD_IN = alt([
  "join", "joining", "part of", "member of", "embedded (?:in|with)", "within", "supporting", "sits? (?:in|with)"
]);
const ARTICLE = alt(["the", "our"]);

// "team" singular only: "teams" is almost always generic prose.
const TEAM_RE = [
  new RegExp(
    `\\b(?:${TEAM_LEAD_IN})\\s+(?:(?:${ARTICLE})\\s+)?(${CAP_PHRASE})\\s+(?:team|org(?:anization)?|group|division|department)\\b`
  ),
  new RegExp(`\\b(?:${ARTICLE})\\s+(${CAP_PHRASE})\\s+(?:team|org(?:anization)?|group)\\b`)
];

function firstCapture(text, patterns) {
  for (const re of patterns) {
    const m = String(text || "").match(re);
    if (!m) continue;
    const phrase = m[1].replace(/\s{2,}/g, " ").trim();
    if (phrase.length < 3) continue;
    if (phrase.split(/\s+/).every((w) => GENERIC_PHRASE_RE.test(w))) continue;
    return phrase;
  }
  return "";
}

// The team/org the role sits in — the most useful thing in the body, because
// "<team> at <company>" finds the people you would actually work with.
export function extractTeam(description) {
  return firstCapture(description, TEAM_RE);
}

// A named early-career program ("Blizzard University Program"). Recruiters and
// past interns both put the program name in their profiles.
const PROGRAM_RE = [
  new RegExp(`\\b(${CAP_PHRASE}\\s+(?:Internship|Intern|Co-?op|University|Campus)\\s+Program)\\b`),
  new RegExp(`\\b(${CAP_PHRASE}\\s+Program)\\b`)
];

export function extractProgram(description) {
  return firstCapture(description, PROGRAM_RE);
}

// Generic key-phrase extraction, so non-tech postings produce something.
//
// The skill dictionary only knows tech terms, which means a marketing or client
// relations posting scored zero on every one of them. This counts repeated
// content bigrams in the qualifications section instead, with no dictionary, so
// "earned media", "media relations", "press releases" surface on their own.
const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those of in on at to for with from by as is are was were be been "
    + "being have has had do does did will would shall should can could may might must not no nor so such own same too very "
    + "you your yours we our ours they their them he she his her it its i me my mine us who whom which what when where why how "
    + "all any both each few more most other some only own s t just don now also able ability across about after again against "
    + "among around because before below between during into over under up down out off through under while work working works "
    + "including include includes etc per via within without based upon role position candidate candidates applicant applicants "
    + "experience experiences year years month months day days team teams company companies opportunity opportunities strong "
    + "excellent good great ideal preferred required requirement requirements qualification qualifications skill skills plus "
    + "ability abilities knowledge understanding demonstrated proven ensure ensuring support supporting help helping assist "
    + "new current must please apply application internship intern program summer fall winter spring").split(/\s+/)
);

export function extractKeyPhrases(text, limit = 5) {
  const quals = qualificationsSection(text).toLowerCase();
  const tokens = quals
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-.]+|[-.]+$/g, ""))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  const counts = new Map();
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
  }
  // A phrase has to recur to count as a theme rather than a passing mention.
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([phrase]) => phrase);
}

// Full local extraction entrypoint.
export function extractLocal(posting) {
  // Derive titles mainly from the posting title — scanning the whole body for
  // title-ish word pairs produced noisy, overly broad queries.
  const titles = expandSynonyms(extractTitles(posting.title, ""));

  // Skills from the dictionary first (precise where it applies), then backfill
  // with key phrases mined from the body. Without the backfill a non-tech
  // posting produced an empty skill list and the description was read for
  // nothing at all.
  const dictSkills = extractSkills(posting.description, 6);
  const phrases = extractKeyPhrases(posting.description, 6);
  const skills = [...dictSkills];
  for (const p of phrases) {
    if (skills.length >= 6) break;
    if (!skills.some((s) => s.includes(p) || p.includes(s))) skills.push(p);
  }

  return {
    titles,
    skills,
    keyPhrases: phrases,
    team: extractTeam(posting.description),
    program: extractProgram(posting.description),
    company: posting.company || "",
    location: (posting.location || "").split("·")[0].trim(),
    source: "local"
  };
}
