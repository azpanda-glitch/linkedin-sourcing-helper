#!/usr/bin/env python3
"""Checks for the email waterfall in lib/email.js.

Same approach as run.py: the shipping module runs in QuickJS. Provider APIs are
replaced by a routing table of canned responses, so each case says exactly what
Hunter / PDL / the verifier answered and asserts what the waterfall did with it,
including which calls it made (credits are the cost that matters).

Run from the repo root:  python3 test/email_test.py   (run.py also runs these)
"""
import json
import os
import re
import sys

import quickjs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MOCK = r"""
globalThis.CALLS = [];
globalThis.ROUTES = [];
globalThis.mockHttp = (url, opts) => {
  CALLS.push(url);
  for (const [re, resp] of ROUTES) if (new RegExp(re).test(url)) return Promise.resolve(resp);
  return Promise.resolve({ status: 599, json: null });
};
"""


def context():
    src = open(os.path.join(ROOT, "lib/email.js")).read()
    src = re.sub(r"^import .*$", "", src, flags=re.M)
    src = re.sub(r"^export ", "", src, flags=re.M)
    ctx = quickjs.Context()
    ctx.eval(src + "\n" + MOCK)
    return ctx


def call(ctx, expr):
    return json.loads(ctx.eval("JSON.stringify(%s)" % expr))


def waterfall(ctx, person, cfg, routes, patterns=None, catch_all=None):
    ctx.eval("CALLS.length = 0; ROUTES = %s;" % json.dumps(routes))
    ctx.eval(
        "globalThis.OUT = null; globalThis.PAT = %s; globalThis.CA = %s;"
        % (json.dumps(patterns or {}), json.dumps(catch_all or {}))
    )
    ctx.eval(
        "findEmail(%s, %s, {http: mockHttp, patterns: PAT, catchAll: CA})"
        ".then(r => OUT = JSON.stringify({r, PAT, CA, CALLS}), e => OUT = JSON.stringify({err: String(e)}))"
        % (json.dumps(person), json.dumps(cfg))
    )
    while ctx.execute_pending_job():
        pass
    out = json.loads(ctx.eval("OUT"))
    if "err" in out:
        raise AssertionError("threw: " + out["err"])
    return out


def ok(status, json_body):
    return {"status": status, "json": json_body}


ZB_VALID = ok(200, {"status": "valid"})
ZB_INVALID = ok(200, {"status": "invalid"})
ZB_CATCHALL = ok(200, {"status": "catch-all"})
ZB = {"keys": {"zerobounce": "zb"}}


def count(calls, needle):
    return sum(1 for c in calls if needle in c)


def t_names(ctx):
    got = call(ctx, 'splitName("Dr. Jane A. Doe-Smith, PHR (she/her)")')
    assert got == {"first": "jane", "last": "doesmith"}, got
    got = call(ctx, 'splitName("José Álvarez 🚀")')
    assert got == {"first": "jose", "last": "alvarez"}, got
    got = call(ctx, 'displayName("José Álvarez 🚀")')
    assert got == {"first": "José", "last": "Álvarez"}, got
    got = call(ctx, 'splitName("Cher")')
    assert got == {"first": "cher", "last": ""}, got
    got = call(ctx, "splitName(\"Mary Ann O'Brien | Talent Acquisition\")")
    assert got == {"first": "mary", "last": "obrien"}, got


def t_domains(ctx):
    assert call(ctx, 'normalizeDomain("https://www.Stripe.com/jobs?x=1")') == "stripe.com"
    assert call(ctx, 'normalizeDomain("careers.acme.co.uk")') == "careers.acme.co.uk"
    assert call(ctx, 'normalizeDomain("not a domain")') == ""
    assert call(ctx, 'applyPattern("{f}{last}", "jane", "doe", "acme.com")') == "jdoe@acme.com"
    assert call(ctx, 'applyPattern("{first}.{last}", "cher", "", "acme.com")') == ""
    assert call(ctx, 'inferPattern("jdoe@acme.com", "jane", "doe")') == "{f}{last}"


def t_hunter_then_verify(ctx):
    out = waterfall(
        ctx,
        {"name": "Jane Doe", "company": "Acme"},
        {"keys": {"hunter": "h", "zerobounce": "zb"}},
        [
            ["hunter.io/v2/email-finder", ok(200, {"data": {"email": "jane.doe@acme.com", "domain": "acme.com"}})],
            ["zerobounce.*jane.doe%40acme.com", ZB_VALID],
        ],
    )
    r = out["r"]
    assert (r["email"], r["status"], r["source"]) == ("jane.doe@acme.com", "valid", "Hunter"), r
    # The format is learned, so the next person at Acme skips the finder.
    assert out["PAT"] == {"acme.com": "{first}.{last}"}, out["PAT"]


def t_known_pattern_skips_finder(ctx):
    out = waterfall(
        ctx,
        {"name": "John Smith", "company": "Acme", "domain": "acme.com"},
        {"keys": {"hunter": "h", "zerobounce": "zb"}},
        [["zerobounce.*john.smith%40acme.com", ZB_VALID]],
        patterns={"acme.com": "{first}.{last}"},
    )
    assert out["r"]["status"] == "valid", out["r"]
    assert count(out["CALLS"], "hunter.io") == 0, out["CALLS"]


def t_guess_until_valid(ctx):
    out = waterfall(
        ctx,
        {"name": "Jane Doe", "domain": "acme.com"},
        ZB,
        [["zerobounce.*jdoe%40acme.com", ZB_VALID], ["zerobounce", ZB_INVALID]],
    )
    r = out["r"]
    assert (r["email"], r["source"]) == ("jdoe@acme.com", "Guess"), r
    assert count(out["CALLS"], "zerobounce") == 2, out["CALLS"]  # jane.doe, then jdoe
    assert out["PAT"] == {"acme.com": "{f}{last}"}, out["PAT"]


def t_catch_all_stops_guessing(ctx):
    out = waterfall(ctx, {"name": "Jane Doe", "domain": "bigco.com"}, ZB, [["zerobounce", ZB_CATCHALL]])
    r = out["r"]
    assert (r["email"], r["status"]) == ("jane.doe@bigco.com", "risky"), r
    assert count(out["CALLS"], "zerobounce") == 1, out["CALLS"]
    assert out["CA"] == {"bigco.com": True}, out["CA"]
    # Risky results must not teach a format: nothing was confirmed.
    assert out["PAT"] == {}, out["PAT"]


def t_known_catch_all_costs_nothing(ctx):
    out = waterfall(
        ctx, {"name": "Jane Doe", "domain": "bigco.com"}, ZB, [], catch_all={"bigco.com": True}
    )
    assert out["r"]["status"] == "risky", out["r"]
    assert out["CALLS"] == [], out["CALLS"]


def t_bad_finder_key_falls_through(ctx):
    out = waterfall(
        ctx,
        {"name": "Jane Doe", "domain": "acme.com"},
        {"keys": {"hunter": "bad", "zerobounce": "zb"}},
        [
            ["hunter.io", ok(401, {"errors": [{"details": "No user found for the API key supplied"}]})],
            ["zerobounce.*jane.doe%40acme.com", ZB_VALID],
        ],
    )
    r = out["r"]
    assert r["status"] == "valid" and r["source"] == "Guess", r
    assert any("key rejected" in line for line in r["trace"]), r["trace"]


def t_dead_verifier_stops_spending(ctx):
    out = waterfall(
        ctx,
        {"name": "Jane Doe", "domain": "acme.com"},
        {"keys": {"millionverifier": "mv"}},
        [["millionverifier", ok(200, {"error": "Insufficient credits"})]],
    )
    r = out["r"]
    assert r["status"] == "unknown" and r["email"] == "jane.doe@acme.com", r
    assert count(out["CALLS"], "millionverifier") == 1, out["CALLS"]


def t_no_domain_explains(ctx):
    out = waterfall(ctx, {"name": "Jane Doe", "company": "Acme"}, ZB, [])
    r = out["r"]
    assert r["status"] == "not_found", r
    assert any("no company domain" in line for line in r["trace"]), r["trace"]


def t_trusts_hunter_valid(ctx):
    out = waterfall(
        ctx,
        {"name": "Jane Doe", "company": "Acme"},
        {"keys": {"hunter": "h", "zerobounce": "zb"}},
        [["hunter.io", ok(200, {"data": {"email": "jane@acme.com", "verification": {"status": "valid"}}})]],
    )
    assert out["r"]["status"] == "valid", out["r"]
    assert count(out["CALLS"], "zerobounce") == 0, out["CALLS"]


def t_pdl_record_first(ctx):
    out = waterfall(
        ctx,
        {"name": "Jane Doe", "workEmail": "JDoe@Acme.com", "domain": "acme.com"},
        {"keys": {"zerobounce": "zb", "hunter": "h"}},
        [["zerobounce.*jdoe%40acme.com", ZB_VALID]],
    )
    r = out["r"]
    assert (r["email"], r["source"]) == ("jdoe@acme.com", "PDL record"), r
    assert count(out["CALLS"], "hunter.io") == 0, out["CALLS"]


def t_pdl_enrich(ctx):
    out = waterfall(
        ctx,
        {"name": "Jane Doe", "linkedin": "https://www.linkedin.com/in/janedoe"},
        {"keys": {"pdl": "p", "zerobounce": "zb"}},
        [
            ["person/enrich\\?profile=", ok(200, {"data": {"work_email": "jane@acme.com", "job_company_website": "acme.com"}})],
            ["zerobounce.*jane%40acme.com", ZB_VALID],
        ],
    )
    r = out["r"]
    assert (r["email"], r["source"]) == ("jane@acme.com", "PDL enrich"), r


def t_verification_budget(ctx):
    out = waterfall(
        ctx,
        {"name": "Jane Doe", "domain": "acme.com"},
        {"keys": {"zerobounce": "zb"}, "maxVerifications": 2, "maxGuesses": 5},
        [["zerobounce", ZB_INVALID]],
    )
    assert count(out["CALLS"], "zerobounce") == 2, out["CALLS"]


def t_all_invalid_is_not_found(ctx):
    out = waterfall(ctx, {"name": "Jane Doe", "domain": "acme.com"}, ZB, [["zerobounce", ZB_INVALID]])
    assert (out["r"]["email"], out["r"]["status"]) == ("", "not_found"), out["r"]


def t_csv(ctx):
    csv = call(
        ctx,
        'contactsToCsv([{first: "=HYPERLINK(\\"x\\")", last: "Doe, Jr", email: "j@acme.com", status: "valid"}])',
    )
    header, row = csv.split("\r\n")
    assert header.startswith("First Name,Last Name,Email,Email Status"), header
    # Formula neutralized, then CSV-quoted because it contains quotes.
    assert row.startswith('"\'=HYPERLINK(""x"")","Doe, Jr",j@acme.com,valid'), row


CASES = [
    ("Names: credentials, pronouns, accents, emoji", t_names),
    ("Domains and patterns", t_domains),
    ("Hunter finds, verifier confirms, format learned", t_hunter_then_verify),
    ("Known company format skips the finder", t_known_pattern_skips_finder),
    ("Guesses until one verifies", t_guess_until_valid),
    ("Catch-all domain stops guessing", t_catch_all_stops_guessing),
    ("Known catch-all costs no credits", t_known_catch_all_costs_nothing),
    ("Rejected finder key falls through to guessing", t_bad_finder_key_falls_through),
    ("Out-of-credit verifier stops spending", t_dead_verifier_stops_spending),
    ("No domain explains why", t_no_domain_explains),
    ("Hunter's own 'valid' is trusted", t_trusts_hunter_valid),
    ("Email on the PDL record is tried first", t_pdl_record_first),
    ("PDL enrich by LinkedIn URL", t_pdl_enrich),
    ("Verification budget is respected", t_verification_budget),
    ("All guesses invalid is not found", t_all_invalid_is_not_found),
    ("CSV quoting and formula neutralizing", t_csv),
]


def main():
    ctx = context()
    failures = []
    for name, fn in CASES:
        try:
            fn(ctx)
            print("PASS %s" % name)
        except AssertionError as e:
            print("FAIL %s\n       -> %s" % (name, e))
            failures.append(name)
    print("\n%d/%d email checks passed" % (len(CASES) - len(failures), len(CASES)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
