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

// Extract skills present in the description via dictionary match.
export function extractSkills(text) {
  const hay = normalize(text);
  const found = [];
  for (const skill of SKILL_DICTIONARY) {
    // word-boundary-ish match; escape regex specials in the term
    const esc = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9+#.])${esc}([^a-z0-9+#.]|$)`, "i");
    if (re.test(hay)) found.push(skill);
  }
  return found;
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

// Full local extraction entrypoint.
export function extractLocal(posting) {
  const titles = expandSynonyms(extractTitles(posting.title, posting.description));
  const skills = extractSkills(posting.description).slice(0, 10);
  return {
    titles,
    skills,
    company: posting.company || "",
    location: (posting.location || "").split("·")[0].trim(),
    source: "local"
  };
}
