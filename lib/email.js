// Email waterfall: try sources cheapest-first and stop at the first verified
// address. Pure apart from the injected `http` function, so test/run.py can
// drive it with canned API responses.
//
// A "found" email only counts once a verifier says the mailbox exists. Finders
// (and pattern guesses) produce candidates; the verifier decides. On catch-all
// domains every address "exists", so those come back as risky, never valid.

export const STATUS = {
  VALID: "valid",       // verifier confirmed the mailbox
  RISKY: "risky",       // catch-all domain: accepts anything, so it can't be confirmed
  UNKNOWN: "unknown",   // couldn't verify (no verifier, budget spent, server didn't answer)
  INVALID: "invalid",
  NOT_FOUND: "not_found"
};

// Better-to-worse, for choosing a fallback when nothing verifies.
const STATUS_RANK = { valid: 3, risky: 2, unknown: 1, invalid: 0 };

// Default order. Free and already-paid-for data first, then the per-lookup
// finders, then guessing (which spends a verification per guess).
export const DEFAULT_STEPS = ["pdl-record", "known-pattern", "hunter", "pdl-enrich", "guess"];

export const STEP_LABELS = {
  "pdl-record": "Email already on the PDL result",
  "known-pattern": "Company's email format, learned from earlier finds",
  hunter: "Hunter email finder",
  "pdl-enrich": "People Data Labs enrich",
  guess: "Guess common formats and verify each"
};

// Hunter's pattern syntax. Ordered by how common each format is at US
// companies, so the few guesses we can afford go to the likeliest ones.
export const PATTERNS = [
  "{first}.{last}", "{f}{last}", "{first}", "{first}{last}", "{first}_{last}",
  "{f}.{last}", "{first}{l}", "{last}.{first}", "{last}", "{first}-{last}"
];

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

// Credentials and suffixes people put in their LinkedIn name.
const NAME_NOISE = /^(jr|sr|ii|iii|iv|phd|mba|cpa|phr|sphr|shrm-?cp|shrm-?scp|pmp|md|esq|dr|mr|mrs|ms|mx)\.?$/i;

// ---- Names and domains -------------------------------------------------------

function nameTokens(full) {
  const s = String(full || "")
    .replace(/\([^)]*\)/g, " ")   // pronouns, nicknames
    .split(/[,|]/)[0]             // "Jane Doe, PHR" / "Jane Doe | Recruiting"
    .replace(/[^\p{L}\p{M}'. -]/gu, " "); // emoji and symbols
  let tokens = s.split(/\s+/).filter((t) => t && !NAME_NOISE.test(t));
  // Middle initials ("A.") never appear in an address, but only drop them when
  // a real first and last name remain.
  if (tokens.length > 2) tokens = [tokens[0], ...tokens.slice(1).filter((t) => t.replace(/\./g, "").length > 1)];
  return tokens;
}

/** "Dr. Jane A. Doe-Smith, PHR (she/her)" -> {first: "jane", last: "doesmith"}, for building addresses. */
export function splitName(full) {
  const tokens = nameTokens(full);
  return { first: namePart(tokens[0]), last: tokens.length > 1 ? namePart(tokens[tokens.length - 1]) : "" };
}

/** Same split with the original spelling kept ("José", "Doe-Smith"), for mail-merge greetings. */
export function displayName(full) {
  const tokens = nameTokens(full);
  return { first: tokens[0] || "", last: tokens.length > 1 ? tokens[tokens.length - 1] : "" };
}

/** Lowercase ASCII letters only: "José" -> "jose", "O'Brien" -> "obrien". */
export function namePart(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** "https://www.Stripe.com/jobs" -> "stripe.com"; "" if it doesn't look like a domain. */
export function normalizeDomain(s) {
  const d = String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d) ? d : "";
}

function domainOf(email) {
  return email.split("@")[1] || "";
}

export function applyPattern(pattern, first, last, domain) {
  if (!first || !domain) return "";
  if (/\{(last|l)\}/.test(pattern) && !last) return "";
  const local = pattern
    .replace(/\{first\}/g, first)
    .replace(/\{last\}/g, last)
    .replace(/\{f\}/g, first[0])
    .replace(/\{l\}/g, last ? last[0] : "");
  return `${local}@${domain}`;
}

/** Which known pattern produced this address, so the next person at the company is one verification away. */
export function inferPattern(email, first, last) {
  const domain = domainOf(email);
  return PATTERNS.find((p) => applyPattern(p, first, last, domain) === email) || "";
}

// ---- Provider errors -----------------------------------------------------------

export class ProviderError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // "auth" | "quota" | "error"
  }
}

function fail(provider, resp, detail) {
  // Some providers report a bad key or empty balance as a 200 with an error
  // string, so the text decides when the status code can't.
  const text = String(detail || "");
  const kind = resp.status === 401 || resp.status === 403 ? "auth"
    : resp.status === 402 || resp.status === 429 ? "quota"
      : /credit|balance|quota|limit|exceeded/i.test(text) ? "quota"
        : /api ?key|unauthori[sz]ed|invalid key/i.test(text) ? "auth"
          : "error";
  const what = { auth: "key rejected", quota: "out of credits or rate-limited", error: `HTTP ${resp.status}` }[kind];
  return new ProviderError(kind, `${provider}: ${what}${detail ? ` (${String(detail).slice(0, 120)})` : ""}`);
}

const enc = encodeURIComponent;

// ---- Verifiers -------------------------------------------------------------------

const VERIFY_MAP = {
  valid: STATUS.VALID, ok: STATUS.VALID, deliverable: STATUS.VALID, webmail: STATUS.VALID,
  "catch-all": STATUS.RISKY, catch_all: STATUS.RISKY, accept_all: STATUS.RISKY, risky: STATUS.RISKY,
  invalid: STATUS.INVALID, undeliverable: STATUS.INVALID, disposable: STATUS.INVALID,
  spamtrap: STATUS.INVALID, abuse: STATUS.INVALID, do_not_mail: STATUS.INVALID
};

const mapVerify = (s) => VERIFY_MAP[String(s || "").toLowerCase()] || STATUS.UNKNOWN;

export const VERIFIERS = {
  millionverifier: {
    label: "MillionVerifier",
    async verify(email, key, http) {
      const r = await http(`https://api.millionverifier.com/api/v3/?api=${enc(key)}&email=${enc(email)}&timeout=10`);
      // Errors come back as 200 with an "error" string.
      if (r.status !== 200 || r.json?.error) throw fail("MillionVerifier", r, r.json?.error);
      return mapVerify(r.json?.result);
    }
  },
  zerobounce: {
    label: "ZeroBounce",
    async verify(email, key, http) {
      const r = await http(`https://api.zerobounce.net/v2/validate?api_key=${enc(key)}&email=${enc(email)}&ip_address=`);
      if (r.status !== 200 || r.json?.error) throw fail("ZeroBounce", r, r.json?.error);
      return mapVerify(r.json?.status);
    }
  },
  hunter: {
    label: "Hunter verifier",
    async verify(email, key, http) {
      const r = await http(`https://api.hunter.io/v2/email-verifier?email=${enc(email)}&api_key=${enc(key)}`);
      if (r.status !== 200) throw fail("Hunter", r, r.json?.errors?.[0]?.details);
      return mapVerify(r.json?.data?.status || r.json?.data?.result);
    }
  }
};

/** The verifier to use: the one picked in settings, else the first with a key. */
export function pickVerifier(cfg) {
  const keys = cfg.keys || {};
  if (cfg.verifier && cfg.verifier !== "auto") return keys[cfg.verifier] ? cfg.verifier : "";
  return ["millionverifier", "zerobounce", "hunter"].find((v) => keys[v]) || "";
}

// ---- The waterfall -------------------------------------------------------------------

/**
 * person: {name, first?, last?, company, domain?, linkedin?, workEmail?}
 * cfg:    {keys: {hunter, pdl, zerobounce, millionverifier}, steps, verifier,
 *          maxVerifications, maxGuesses}
 * deps:   {http(url, opts) -> Promise<{status, json}>,
 *          patterns: {domain: pattern}, catchAll: {domain: true}}  (both mutated)
 *
 * Returns {email, status, source, domain, pattern, trace: [string]}.
 */
export async function findEmail(person, cfg, deps) {
  const keys = cfg.keys || {};
  const steps = cfg.steps || DEFAULT_STEPS;
  const maxVerifications = cfg.maxVerifications ?? 4;
  const maxGuesses = cfg.maxGuesses ?? 3;
  const { http } = deps;
  const patterns = deps.patterns || {};
  const catchAll = deps.catchAll || {};

  const split = splitName(person.name);
  const first = namePart(person.first) || split.first;
  const last = namePart(person.last) || split.last;
  let domain = normalizeDomain(person.domain);

  const trace = [];
  const tried = new Set();
  let verifierId = pickVerifier(cfg);
  let verifications = 0;
  let best = null;

  if (!first) {
    return { email: "", status: STATUS.NOT_FOUND, source: "", domain, pattern: "", trace: ["No usable name"] };
  }
  if (!verifierId) trace.push("No verifier key set, so results are unverified");

  // Verify one candidate. Returns the result if it's a confirmed address.
  async function consider(email, source, preStatus) {
    email = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || tried.has(email)) return null;
    tried.add(email);
    const d = domainOf(email);
    let status = preStatus;

    if (!status && catchAll[d]) {
      status = STATUS.RISKY;
      trace.push(`${source}: ${email} (catch-all domain, not verified)`);
    } else if (!status) {
      if (!verifierId) {
        status = STATUS.UNKNOWN;
        trace.push(`${source}: ${email} (unverified)`);
      } else if (verifications >= maxVerifications) {
        status = STATUS.UNKNOWN;
        trace.push(`${source}: ${email} (verification limit reached)`);
      } else {
        verifications++;
        try {
          status = await VERIFIERS[verifierId].verify(email, keys[verifierId], http);
          trace.push(`${source}: ${email} → ${VERIFIERS[verifierId].label}: ${status}`);
        } catch (e) {
          // A dead verifier key would otherwise fail every remaining candidate.
          trace.push(`${source}: ${email}, ${e.message}`);
          if (e.kind === "auth" || e.kind === "quota") verifierId = "";
          status = STATUS.UNKNOWN;
        }
      }
    } else {
      trace.push(`${source}: ${email} (${status} per ${source})`);
    }

    if (status === STATUS.RISKY) catchAll[d] = true;
    const result = { email, status, source };
    if (status === STATUS.VALID) return result;
    if (status !== STATUS.INVALID && (!best || STATUS_RANK[status] > STATUS_RANK[best.status])) best = result;
    return null;
  }

  const STEPS = {
    // PDL search results can carry a work email on paid plans (free plans send
    // `true` instead of the address).
    async "pdl-record"() {
      if (typeof person.workEmail !== "string") return null;
      return consider(person.workEmail, "PDL record");
    },

    async "known-pattern"() {
      const p = domain && patterns[domain];
      if (!p) return null;
      return consider(applyPattern(p, first, last, domain), `Known format ${p}`);
    },

    async hunter() {
      if (!keys.hunter) return null;
      if (!last) { trace.push("Hunter: skipped, needs a last name"); return null; }
      if (!domain && !person.company) { trace.push("Hunter: skipped, needs a company or domain"); return null; }
      const where = domain ? `domain=${enc(domain)}` : `company=${enc(person.company)}`;
      const r = await http(`https://api.hunter.io/v2/email-finder?${where}&first_name=${enc(first)}&last_name=${enc(last)}&api_key=${enc(keys.hunter)}`);
      if (r.status === 404) { trace.push("Hunter: no match"); return null; }
      if (r.status !== 200) throw fail("Hunter", r, r.json?.errors?.[0]?.details);
      const data = r.json?.data || {};
      if (!domain && data.domain) domain = normalizeDomain(data.domain);
      if (!data.email) { trace.push("Hunter: no match"); return null; }
      // Hunter sometimes verifies as part of the lookup. Trust a "valid",
      // re-check anything else with the configured verifier.
      const pre = mapVerify(data.verification?.status) === STATUS.VALID ? STATUS.VALID : undefined;
      return consider(data.email, "Hunter", pre);
    },

    async "pdl-enrich"() {
      if (!keys.pdl) return null;
      const q = person.linkedin
        ? `profile=${enc(person.linkedin)}`
        : person.company ? `name=${enc(person.name || `${first} ${last}`)}&company=${enc(person.company)}` : "";
      if (!q) { trace.push("PDL enrich: skipped, needs a LinkedIn URL or company"); return null; }
      const r = await http(`https://api.peopledatalabs.com/v5/person/enrich?${q}`, { headers: { "X-Api-Key": keys.pdl } });
      if (r.status === 404) { trace.push("PDL enrich: no match"); return null; }
      if (r.status !== 200) throw fail("PDL", r, r.json?.error?.message);
      const data = r.json?.data || {};
      if (!domain && data.job_company_website) domain = normalizeDomain(data.job_company_website);
      const emails = [data.work_email, ...(Array.isArray(data.emails) ? data.emails.map((e) => e?.address) : [])]
        .filter((e) => typeof e === "string");
      if (!emails.length) { trace.push("PDL enrich: matched, but no email on this plan"); return null; }
      // Prefer an address at the company's own domain over personal ones.
      emails.sort((a, b) => (domainOf(b) === domain) - (domainOf(a) === domain));
      for (const e of emails.slice(0, 2)) {
        const hit = await consider(e, "PDL enrich");
        if (hit) return hit;
      }
      return null;
    },

    async guess() {
      if (!domain) { trace.push("Guess: skipped, no company domain (enter one to enable)"); return null; }
      const candidates = PATTERNS.map((p) => applyPattern(p, first, last, domain)).filter((e) => e && !tried.has(e));
      // On a catch-all domain a verifier can't tell guesses apart, so don't pay
      // for it. Offer the most common format as a risky best guess.
      if (catchAll[domain]) {
        if (candidates[0]) await consider(candidates[0], "Guess");
        return null;
      }
      for (const e of candidates.slice(0, maxGuesses)) {
        const hit = await consider(e, "Guess");
        if (hit) return hit;
        if (catchAll[domain]) break; // first guess revealed a catch-all
      }
      return null;
    }
  };

  let found = null;
  for (const id of steps) {
    if (!STEPS[id]) continue;
    try {
      found = await STEPS[id]();
    } catch (e) {
      trace.push(e.message || String(e));
    }
    if (found) break;
  }

  const final = found || best;
  const pattern = found ? inferPattern(found.email, first, last) : "";
  if (found && pattern) patterns[domainOf(found.email)] = pattern;
  return {
    email: final?.email || "",
    status: final?.status || STATUS.NOT_FOUND,
    source: final?.source || "",
    domain: final ? domainOf(final.email) : domain,
    pattern,
    trace
  };
}

// ---- Export --------------------------------------------------------------------

export const CONTACT_COLUMNS = [
  ["First Name", "first"], ["Last Name", "last"], ["Email", "email"], ["Email Status", "status"],
  ["Title", "title"], ["Company", "company"], ["LinkedIn", "linkedin"], ["Job", "job"],
  ["Job URL", "jobUrl"], ["Found Via", "source"], ["Found On", "foundOn"]
];

// Sheets and Excel run cells starting with these as formulas.
function safeCell(v) {
  const s = String(v ?? "").replace(/[\r\n\t]+/g, " ");
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

/** First/Last Name headers line up with Streak and Sheets mail-merge fields. */
export function contactsToCsv(contacts) {
  const quote = (s) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [CONTACT_COLUMNS.map(([h]) => h)]
    .concat(contacts.map((c) => CONTACT_COLUMNS.map(([, k]) => safeCell(c[k]))));
  return rows.map((r) => r.map(quote).join(",")).join("\r\n");
}

/** Tab-separated, for pasting straight into a Google Sheet. */
export function contactsToTsv(contacts) {
  const rows = [CONTACT_COLUMNS.map(([h]) => h)]
    .concat(contacts.map((c) => CONTACT_COLUMNS.map(([, k]) => safeCell(c[k]))));
  return rows.map((r) => r.join("\t")).join("\n");
}
