# Sourcing Helper — Boolean & X-ray Builder

A Chrome (Manifest V3) extension that reads the LinkedIn job posting you're
viewing and builds Boolean search strings + one-click search links to source
candidates and find related people/posts. It **does not** scrape people results
or automate LinkedIn — it only reads the posting on screen and hands you
searches to run yourself.

## Why not the LinkedIn API?
LinkedIn's public developer API only offers Sign-In, Share, and Marketing/Ads
scopes. People search, profile lookup, and hiring-status ("#OpenToWork") data
live behind **LinkedIn Talent Solutions / Recruiter System Connect**, a partner
program requiring a signed contract — not available to a personal extension.
This tool approximates the hiring-status signal with `#OpenToWork` Boolean
terms in normal search, which is the best a non-partner tool can do.

## Two personas
- **Sourcer** — LinkedIn people search, Google X-ray over profiles,
  company-scoped search, and an "open to work" search.
- **Hiring manager** — LinkedIn post search and Google X-ray over posts to see
  who's discussing the role's domain.

## What gets read out of the description

The title alone produces generic searches, so the body is mined for the things
that actually name humans:

| Signal | Where it comes from | What it powers |
|---|---|---|
| **Team / org** | "join the **Earned Media** team", "part of the **Story and Franchise Development** group" | people on that team via the company People tab, plus a "team + hiring" posts search |
| **Program** | "the **State Farm University Internship Program**" | past interns and the recruiters who ran the program |
| **Reporting line** | "you will report to the **Director of Analytics**" | the one manager search that isn't a guess |
| **Themes** | recurring bigrams in the qualifications section | "people doing *media relations*" at the company |

Team and program are matched **case-sensitively** on purpose: Title Case is what
separates a real org name ("the Payments Platform team") from prose ("work with
the whole team"). Only the leading verb/article is case-relaxed, for
sentence-initial matches.

Themes are extracted with **no dictionary** — just repeated content bigrams. That
matters because `SKILL_DICTIONARY` is tech-only, so a marketing or client
relations posting scored zero on every entry in it and the description
contributed nothing. Dictionary hits still come first where they apply; themes
backfill the rest.

## Extraction modes (⚙︎ Settings)
- **Local (rule-based)** — default, offline, free. Dictionary + heuristics in
  `lib/extract.js`. Extend `SKILL_DICTIONARY` / `SYNONYMS` to improve results.
- **Claude API** — paste an Anthropic API key; the service worker calls Claude
  (default model Haiku 4.5), which returns the same fields plus its own reading
  of team / program / reporting line. The regex reading of the raw text wins when
  both find a reporting line — a literal match beats a model's summary. Falls
  back to local automatically if the key is missing or a call fails.

## Install (unpacked)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open a `linkedin.com/jobs/view/...` posting, click the extension icon.
4. (Optional) Open Settings, switch to Claude, paste your API key.

## Files
- `manifest.json` — MV3 config, permissions, content-script match.
- `content/scrape.js` — reads the visible posting's title/company/location/description.
- `lib/extract.js` — local rule-based extraction.
- `lib/query.js` — Boolean strings + LinkedIn/Google X-ray URL builders.
- `background.js` — Claude API proxy (keeps key/CORS out of page context).
- `popup/` — UI: editable Boolean box + grouped search links.
- `options/` — settings (mode, API key, model).

## The Boolean operator budget (important)

LinkedIn [caps how many Boolean operators a free account may use in one
query](https://www.linkedin.com/help/linkedin/answer/a524411), does not publish
the number, and **when you exceed it the search returns zero results rather than
an error**. Recruiter / Recruiter Lite are uncapped; Sales Navigator allows 15.

This is the single biggest constraint on query design here, and the reason an
exhaustive OR-list is worse than useless. Every generated query is therefore kept
to `OPERATOR_BUDGET` (6) operators, counting each `AND`/`OR`/`NOT` plus each
opening parenthesis. Term lists in `lib/query.js` are ordered
most-distinct-first, because only the leading few survive the trim — so if you
add a term, put it where its value justifies its place.

Google X-ray has no such cap, which is why the wide searches go there and get the
fuller term lists.

Two related rules the popup follows:
- `"hiring"` appears only in **Posts** queries. On the People tab every `AND`
  term must be in the profile, and nobody writes "hiring" in their profile.
- The operator count is shown live under the Company field, and turns red when a
  hand-edited query goes over budget.

## Notes & caveats
- LinkedIn changes its DOM often; if scraping stops working, update the
  selectors in `scrapePostingInPage()` in `popup/popup.js`.
- Boolean support per result tab is not documented by LinkedIn. Operators are
  documented for the main search bar; behavior on the Posts tab is inferred, so
  prefer the Google X-ray links when a Posts search looks wrong.
- Storing an API key in `chrome.storage.sync` is convenient but not encrypted;
  use a scoped/limited key.
- Icons in `icons/` are generated placeholders — replace as desired.
