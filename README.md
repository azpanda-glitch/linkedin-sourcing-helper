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

## Extraction modes (⚙︎ Settings)
- **Local (rule-based)** — default, offline, free. Dictionary + heuristics in
  `lib/extract.js`. Extend `SKILL_DICTIONARY` / `SYNONYMS` to improve results.
- **Claude API** — paste an Anthropic API key; the service worker calls Claude
  (default model Haiku 4.5) for higher-quality titles/skills/synonyms. Falls
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

## Notes & caveats
- LinkedIn changes its DOM often; if scraping stops working, update the
  selectors in `content/scrape.js`.
- Storing an API key in `chrome.storage.sync` is convenient but not encrypted;
  use a scoped/limited key.
- Icons in `icons/` are generated placeholders — replace as desired.
