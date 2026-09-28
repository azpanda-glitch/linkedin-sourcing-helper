# Sourcing Helper — Boolean & X-ray Builder

A Chrome extension that reads the LinkedIn job posting you're viewing and gives
you one-click searches for the people behind it: recruiters, the hiring team,
past interns, and people posting about the role. It **does not** scrape people
results or automate LinkedIn. It only reads the posting on screen and hands you
searches to run yourself.

<!-- DEMO VIDEO: in GitHub's web editor, drag an .mp4 (under 10 MB) onto the line below
     and it becomes an embedded player. Or commit docs/demo.gif and use ![Demo](docs/demo.gif). -->
**Demo:** _coming soon_

## Install (about 1 minute)

Not in the Chrome Web Store yet, so it installs as an "unpacked" extension:

1. **Download:** click the green **Code** button at the top of this page, then **Download ZIP**, and unzip it.
   (Or `git clone https://github.com/azpanda-glitch/linkedin-sourcing-helper.git`.)
2. **Open** `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder, the one containing `manifest.json`.
5. **Pin it:** click the puzzle-piece icon in the toolbar, then the pin next to *Sourcing Helper*.

Keep the folder where it is. Chrome loads the extension from it, so deleting or
moving it removes the extension.

## Use it

1. Open a job posting on LinkedIn (`linkedin.com/jobs/view/...`).
2. Click the Sourcing Helper icon.
3. Check the **Role** and **Company** it read. Edit either one if it's wrong, then click **Rebuild links**.
4. Click any link to run that search in a new tab:
   - **Hiring manager posts:** people posting that they're hiring for this kind of role.
   - **Recruiters & people:** recruiters, the team named in the posting, and people doing the work.
   - **Google X-ray:** wider Google searches over LinkedIn profiles and posts, with no operator limit.
5. **Copy** puts the Boolean string on your clipboard so you can paste it into LinkedIn search yourself.

## Optional: better results with API keys

Everything above works with no setup. Two optional keys, added under the ⚙︎ in the popup:

| Key | What it adds | Cost |
|---|---|---|
| [Anthropic (Claude)](https://console.anthropic.com/) | Reads the posting with AI instead of rules, so it catches the team, program, and reporting line more reliably | Pay per use; well under a cent per posting on Haiku 4.5 |
| [People Data Labs](https://dashboard.peopledatalabs.com/) | "Find people at this company" buttons that return actual people | Free tier available; some plans don't include Person Search |

## Updating

- **Downloaded the ZIP:** download it again, replace the old folder with the new one (same location), then click the ↻ reload icon on the extension's card in `chrome://extensions`.
- **Cloned:** `git pull`, then click ↻ reload.

## Privacy

- It reads the job posting on LinkedIn job pages, inside your browser. It doesn't read other pages or collect search results.
- With no keys set, nothing leaves your browser.
- **Claude mode:** when you open the popup, the posting text is sent to `api.anthropic.com`.
- **People Data Labs:** when you click a "Find people" button, the company name and search terms are sent to `api.peopledatalabs.com`.
- Keys are stored in Chrome's extension storage on your device (`chrome.storage.sync`, not encrypted). Use a key with a spending limit.
- No analytics, and no server of its own.

## Troubleshooting

- **"Role not detected":** LinkedIn changes its page layout often. Type the job title into **Role** and click **Rebuild links**, and please [open an issue](https://github.com/azpanda-glitch/linkedin-sourcing-helper/issues) with the posting URL.
- **A LinkedIn search returns zero results:** free accounts get zero results, with no error, once a query uses too many Boolean operators. Try the Google X-ray link instead (see [the operator budget](#the-boolean-operator-budget-important)).
- **Nothing happens when you click the icon:** reload the LinkedIn tab after installing or updating the extension.

## Feedback

Found a bug or have an idea? [Open an issue](https://github.com/azpanda-glitch/linkedin-sourcing-helper/issues).
To work on the code, see **How it works** below. Run the tests with `python3 test/run.py`.

---

## How it works
### Why not the LinkedIn API?
LinkedIn's public developer API only offers Sign-In, Share, and Marketing/Ads
scopes. People search, profile lookup, and hiring-status ("#OpenToWork") data
live behind **LinkedIn Talent Solutions / Recruiter System Connect**, a partner
program requiring a signed contract — not available to a personal extension.
This tool approximates the hiring-status signal with `#OpenToWork` Boolean
terms in normal search, which is the best a non-partner tool can do.

### Two personas
- **Sourcer** — LinkedIn people search, Google X-ray over profiles,
  company-scoped search, and an "open to work" search.
- **Hiring manager** — LinkedIn post search and Google X-ray over posts to see
  who's discussing the role's domain.

### What gets read out of the description

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

### Extraction modes (⚙︎ Settings)
- **Local (rule-based)** — default, offline, free. Dictionary + heuristics in
  `lib/extract.js`. Extend `SKILL_DICTIONARY` / `SYNONYMS` to improve results.
- **Claude API** — paste an Anthropic API key; the service worker calls Claude
  (default model Haiku 4.5), which returns the same fields plus its own reading
  of team / program / reporting line. The regex reading of the raw text wins when
  both find a reporting line — a literal match beats a model's summary. Falls
  back to local automatically if the key is missing or a call fails.

### Files
- `manifest.json` — MV3 config, permissions, content-script match.
- `content/scrape.js` — reads the visible posting's title/company/location/description.
- `lib/extract.js` — local rule-based extraction.
- `lib/query.js` — Boolean strings + LinkedIn/Google X-ray URL builders.
- `background.js` — Claude API proxy (keeps key/CORS out of page context).
- `popup/` — UI: editable Boolean box + grouped search links.
- `options/` — settings (mode, API key, model).

### The two rules that decide whether a search returns anything

#### 1. Search the head noun, not the req title

A req title is a stack of qualifiers on one head noun, and the qualifiers are
exactly the words nobody else writes:

| Posting title | Searched as |
|---|---|
| Consumer Insight Analyst | `"analyst"` |
| Sr. Manager, Product Marketing | `"manager"` |
| Summer 2027 Intern - Marketing-Earned Media Specialist | `"specialist"` |
| Machine Learning Intern | `"machine learning"` |
| 2026 Client Relations Co-op | `"client relations"` |

`headNoun()` matches a known occupation noun rightmost-first (so "Engineering
Manager" gives `manager`, not `engineering`), and falls back to position when the
title contains no occupation noun — keeping the whole phrase when it's short
enough that splitting it would destroy the meaning. Add to `HEAD_NOUN_WORDS` to
improve it. The full phrase is still offered as a *narrower* second link.

#### 2. LinkedIn terms are joined with `+`

The global search bar gets `plusString()` output — each required term quoted,
joined by `" + "`:

```
"analyst" + "hiring" + "State Farm"
"demand intelligence" + "intern" + "hiring" + "Atlassian"
```

`"intern"` is added on early-career postings. It has to be explicit: `+` requires
every term, and `generalizeRole()` strips "Intern" out of the title on purpose
(nobody writes "Demand Intelligence Intern" in a post), which would otherwise
leave the query pointing at the full-time req. One bare term, never an OR-group —
`"intern" + "internship"` would demand both words appear.

Note: LinkedIn's own help pages say the legacy `+` / `-` operators were retired,
so this is asserted against the docs. It is here because `AND` chains
demonstrably returned nothing. Everything routes through `LINKEDIN_JOINER`, so if
`+` also comes up empty, change that one constant.

Company **People tab** links are the exception and stay as plain unquoted
keywords: that tab's company scope comes from the URL, so quoting and `+` would
only narrow a search that is already correctly scoped.

### The Boolean operator budget (important)

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

### Notes & caveats
- LinkedIn changes its DOM often; if scraping stops working, update the
  selectors in `scrapePostingInPage()` in `popup/popup.js`.
- Boolean support per result tab is not documented by LinkedIn. Operators are
  documented for the main search bar; behavior on the Posts tab is inferred, so
  prefer the Google X-ray links when a Posts search looks wrong.
- Storing an API key in `chrome.storage.sync` is convenient but not encrypted;
  use a scoped/limited key.
- Icons in `icons/` are generated placeholders — replace as desired.
