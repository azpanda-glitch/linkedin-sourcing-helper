#!/usr/bin/env python3
"""End-to-end checks for the extraction + query pipeline.

There is no node on the dev box, so the real lib/*.js modules are executed with
QuickJS (pip install quickjs). import/export lines are stripped and the modules
are concatenated, so this tests the shipping code rather than a Python port of
it -- which is the whole point: a port would have hidden the bugs this found.

Run from the repo root:  python3 test/run.py
"""
import json
import os
import re
import sys

try:
    import quickjs
except ImportError:
    sys.exit("pip install quickjs")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(rel):
    src = open(os.path.join(ROOT, rel)).read()
    src = re.sub(r"^import .*$", "", src, flags=re.M)
    return re.sub(r"^export ", "", src, flags=re.M)


def context():
    ctx = quickjs.Context()
    # Browser global, absent in QuickJS. Only toString() is exercised by the
    # URL builders.
    ctx.eval(
        "globalThis.URLSearchParams=function(o){this.o=o||{};"
        "this.toString=function(){return Object.keys(this.o)"
        '.map(k=>k+"="+encodeURIComponent(this.o[k])).join("&")}};'
    )
    ctx.eval(_load("lib/extract.js") + "\n" + _load("lib/query.js"))
    return ctx


def run(ctx, title, company, description, location="", slug=None):
    """Mirror popup.js:448-452 -- roleName, description and companySlug are all
    attached after extractLocal. Omitting companySlug silently exercises the
    search-bar fallback instead of the company People tab the browser uses."""
    if slug is None:
        slug = re.sub(r"[^a-z0-9]+", "-", company.lower()).strip("-")
    posting = {
        "title": title,
        "company": company,
        "description": description,
        "location": location,
        "companySlug": slug,
    }
    ctx.eval("globalThis.P=" + json.dumps(posting))
    ctx.eval(
        'globalThis.E=extractLocal(P); E.roleName=P.title||""; '
        'E.description=P.description||""; '
        'E.companySlug=P.companySlug||""; '
        'if(!E.company)E.company=P.company||"";'
    )
    return json.loads(ctx.eval("globalThis.R=JSON.stringify(buildQueries(E))"))


# --- fixtures ---------------------------------------------------------------

# Degree-requirement boilerplate that appears in almost every full-time req and
# used to flip the whole posting into an intern search.
FULLTIME_BOILERPLATE = (
    "Bachelor's degree from an accredited university or equivalent experience. "
    "We are an equal opportunity employer and value diversity. "
    "Entry level candidates are welcome to apply."
)

PAYPAL = (
    "PayPal has been revolutionizing commerce globally for more than 25 years. "
    + FULLTIME_BOILERPLATE
    + " You will build machine learning models and machine learning pipelines. "
    "You will measure product performance and measure product impact."
)

ATLASSIAN_INTERN = (
    "Join the Demand Intelligence team at Atlassian. You will support demand "
    "intelligence work, build demand intelligence dashboards, and report to the "
    "Director of Analytics. This is part of our Atlassian Internship Program. "
    "Must be currently enrolled with an expected graduation of 2027."
)

STATEFARM = (
    "Our Client Relations organization serves millions. You will report to the "
    "Client Relations Manager and work with the whole team. Part of the State "
    "Farm University Internship Program. " + FULLTIME_BOILERPLATE
)

MARKETING = (
    "You will join the Earned Media team. Responsibilities include media "
    "relations, press releases, and media relations strategy. You will own "
    "press releases end to end. " + FULLTIME_BOILERPLATE
)


# --- checks -----------------------------------------------------------------
# Each is (label, assertion_fn) evaluated against the result dict.

CASES = [
    dict(
        name="PayPal Data Scientist 1 (logged-in standalone)",
        title="Data Scientist 1",
        company="PayPal",
        description=PAYPAL,
        expect={
            "earlyCareer": False,
            "headNoun": "scientist",
            "rolePhrase": "Data Scientist 1",
            "boolean": '"scientist" + "hiring" + "PayPal"',
        },
        expect_not_in_boolean=["intern"],
    ),
    dict(
        name="Atlassian intern, named team + reporting line",
        title="Demand Intelligence Intern",
        company="Atlassian",
        description=ATLASSIAN_INTERN,
        expect={
            "earlyCareer": True,
            "team": "Demand Intelligence",
            "reportsTo": "Director of Analytics",
            "boolean": '"demand intelligence" + "intern" + "hiring" + "Atlassian"',
        },
    ),
    dict(
        name="State Farm co-op, program + manager reporting line",
        title="2026 Client Relations Co-op",
        company="State Farm",
        description=STATEFARM,
        expect={
            "earlyCareer": True,
            "headNoun": "client relations",
            "reportsTo": "Client Relations Manager",
            "program": "State Farm University Internship Program",
        },
    ),
    dict(
        name="Non-tech marketing role (dictionary scores zero)",
        title="Summer 2027 Intern - Marketing-Earned Media Specialist",
        company="Blizzard Entertainment",
        description=MARKETING,
        expect={
            "earlyCareer": True,
            "headNoun": "specialist",
            "team": "Earned Media",
        },
        # The dictionary-free theme extractor must carry this posting.
        expect_themes_nonempty=True,
    ),
    dict(
        name="Senior role with university/student prose",
        title="Senior Staff Engineer",
        company="Google",
        description="Requires a BS from a university. Mentor students at hackathons. "
        + FULLTIME_BOILERPLATE,
        expect={"earlyCareer": False, "headNoun": "engineer"},
        expect_not_in_boolean=["intern"],
    ),
    dict(
        name="Head noun when role noun precedes qualifiers",
        title="Sr. Manager, Product Marketing",
        company="Nike",
        description=FULLTIME_BOILERPLATE,
        expect={"earlyCareer": False, "headNoun": "manager"},
    ),
    dict(
        name="Short phrase must stay intact",
        title="Machine Learning Intern",
        company="Nvidia",
        description="You will train models. " + FULLTIME_BOILERPLATE,
        expect={"earlyCareer": True, "headNoun": "machine learning"},
    ),
    dict(
        name="Level suffix stripped",
        title="SDE II",
        company="Amazon",
        description=FULLTIME_BOILERPLATE,
        expect={"earlyCareer": False, "headNoun": "sde"},
    ),
    dict(
        name="Role unreadable, company only",
        title="",
        company="Stripe",
        description=FULLTIME_BOILERPLATE,
        expect={"earlyCareer": False, "rolePhrase": "", "boolean": '"hiring" + "Stripe"'},
    ),
    dict(
        name="No reporting line stated",
        title="Data Analyst",
        company="Figma",
        description="You will analyze usage. Reporting to stakeholders on campaign "
        "performance is expected. " + FULLTIME_BOILERPLATE,
        expect={"reportsTo": "", "earlyCareer": False},
    ),
]


def main():
    ctx = context()
    failures = []

    for case in CASES:
        r = run(ctx, case["title"], case["company"], case["description"])
        problems = []

        for key, want in case.get("expect", {}).items():
            got = r.get(key)
            if got != want:
                problems.append("%s: got %r want %r" % (key, got, want))

        for bad in case.get("expect_not_in_boolean", []):
            if bad in (r.get("boolean") or ""):
                problems.append("boolean contains %r: %r" % (bad, r["boolean"]))

        if case.get("expect_themes_nonempty") and not r.get("keyPhrases"):
            problems.append("keyPhrases empty -- description contributed nothing")

        # Invariants that must hold for every posting.
        if r.get("boolean") and r["boolean"].count('""'):
            problems.append("empty quoted term in %r" % r["boolean"])
        # The keyword box drives the primary link; an editable link must exist
        # whenever the box is non-empty, or the two disagree.
        editable = [h for h in r.get("hiringManager", []) if h.get("editable")]
        if r.get("boolean") and not editable:
            problems.append("boolean %r has no editable link" % r["boolean"])
        for link in r.get("hiringManager", []) + r.get("sourcer", []):
            if not link.get("url"):
                problems.append("link with no url: %r" % link)
        # Independent signals collapse onto the same search more often than you
        # would guess (head noun vs team name differ only in case), and LinkedIn
        # search is case-insensitive, so two links would run one query.
        for group in ("hiringManager", "sourcer"):
            urls = [l["url"].lower() for l in r.get(group, [])]
            dupes = {u for u in urls if urls.count(u) > 1}
            for d in dupes:
                labels = [l["label"] for l in r[group] if l["url"].lower() == d]
                problems.append("%s duplicate url for %s" % (group, labels))

        print("%-4s %s" % ("FAIL" if problems else "PASS", case["name"]))
        print("       %s" % (r.get("boolean") or "(empty)"))
        for p in problems:
            print("       -> %s" % p)
        if problems:
            failures.append(case["name"])

    print("\n%d/%d passed" % (len(CASES) - len(failures), len(CASES)))
    if failures:
        print("failed: " + ", ".join(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
