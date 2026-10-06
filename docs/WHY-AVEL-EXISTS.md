# Why AVEL Exists: The Research, In Plain Terms

Written for someone joining the team who has not read the strategy report. This explains what is happening in the market, why it matters, and why AVEL is built the way it is.

## The setup

For the last two years, tools like Lovable, Replit, Bolt, Emergent, and Wabi have made it possible for someone who cannot write code to describe an app and get a working app back. This is called vibe coding.

It works. Lovable has around 8 million users and reached roughly $500 million in annualized revenue by June 2026. Emergent went from nothing to about $50 million in revenue in seven months. People are genuinely building and shipping software this way, at enormous volume.

Wabi is the purest version of the idea. It raised $20 million from a16z in November 2025 and calls itself "the first personal software platform" — you describe a mini-app, it exists, and you share it with friends. The pitch is "YouTube for apps."

## The problem

The apps are frequently broken in a specific and dangerous way: **they work, and they are not safe.**

Here is what that looks like in practice.

**Moltbook, January 2026.** An AI social network built by a founder who said publicly that he did not write a single line of code. Three days after launch, security researchers found the production database completely open. 1.5 million API authentication tokens and 35,000 email addresses were readable by anyone with a normal account making normal API calls. No exploit. No clever attack. The database simply had no access rules on it.

**Lovable, April 2026.** A researcher found that any logged-in user could read the source code, database credentials, and AI chat histories of other people's projects. Lovable's first response was that this was intentional.

**Tea, July 2025.** An app for women's safety left its file storage open with no authentication. 72,000 images leaked, including 13,000 selfies and government IDs, plus around 1.1 million private messages.

**Base44, July 2025.** A flaw in the platform itself meant that knowing an app's non-secret ID was enough to create a verified account on any private app on the platform. Every app built there was affected until it was patched.

## This is not a handful of bad apps

The measurements are consistent across independent sources.

| Finding | Source |
|---|---|
| 183 of 200+ vibe-coded apps had at least one AI-caused vulnerability (91.5%) `[pending citation]` | GuardMint, Q1 2026 — see *Sources* |
| 5,600 production apps scanned: 2,000+ critical vulnerabilities, 400+ exposed secrets | Escape.tech |
| 74 real CVEs traced to AI-written code: about 18 in the second half of 2025, then 56 in the first three months of 2026, 35 of them in March | Georgia Tech SSLab, Vibe Security Radar — see *Sources* |
| 45% of AI-generated code introduces an OWASP Top 10 vulnerability | Veracode, 2025 |
| ~70% of production Lovable apps ship with row-level security disabled | Beesoul, via The Next Web |
| 20% of organizations had a breach involving AI-generated or shadow AI code | IBM Cost of a Data Breach, 2025 |

The Georgia Tech researcher running the CVE tracker, Hanqing Zhao, said their number is a floor — the real count is probably five to ten times higher, because they can only detect the cases where the AI authorship is visible in the commit metadata.

## Why this keeps happening

This is the part that matters for how we build.

A normal bug is a logic error. Something computes the wrong answer, and you notice, because the answer is wrong.

These are not that. These are **entire missing layers**. The AI was asked to build a feature. It built the feature. Nobody asked it to add row-level security, so it did not. The code does exactly what was requested and nothing that was assumed.

An experienced engineer writes secure-by-default code out of habit — they add the access check without being told, because they have seen what happens when it is missing. An AI has no such habit. It satisfies the stated requirement.

So the code compiles. It passes lint. It typechecks. It looks correct in review, because it *is* correct for what was asked. And the database is wide open.

**This is what "looks finished but isn't" means.** It is the entire reason AVEL exists.

## Why the existing fixes do not work

Lovable added a security scanner after the CVE. It checks whether a row-level security policy **exists**.

It does not check whether the policy actually stops anyone.

That distinction is the whole game. A check that confirms something is present is not the same as a check that confirms something works. You can have a policy that exists and denies nothing.

The same logic applies to tests. A test suite that runs and passes tells you the code executed. It does not tell you the tests checked anything. A test with no assertions passes every time.

## What AVEL does differently

Three mechanisms, and each one exists because of a specific failure above.

**1. The gate reads artifacts, not claims.**

An export does not deliver unless build, tests, static analysis, coverage delta, and mutation score all come back green — from a file produced by a real CI runner, never from an agent saying "the tests pass." `[specced]`

An agent will tell you it succeeded. That is not evidence. The artifact is evidence.

**2. Mutation scoring proves the tests are real.**

Mutation testing takes your source code, changes it slightly — flips a comparison, deletes a line — and re-runs the test suite. If the tests still pass, the tests were not checking that behavior.

This catches the exact problem where the same agent writes both the code and its tests. A suite that asserts nothing passes an ordinary green check and fails mutation scoring immediately. And it does not care who wrote the tests, which is why it works where a rule about roles would not.

Almost nobody does this commercially. It is our most defensible mechanism.

**3. Blast radius shows what a delivery will actually touch.**

Before anything is written to a client's repository, we compute exactly which files get created, which get overwritten, and which are left alone — using locally computed git hashes, so no file is ever downloaded. We record the commit we computed against, and if the repository moved in between, we refuse, and the operator previews again.

A preview that can quietly go stale is worse than no preview, because it manufactures confidence.

## What we concluded about the market

There was a claim going around that what the world needs is "GitHub for normies" — somewhere for non-technical people to store and share the apps they build.

The research says that is half right and the wrong half.

**Storage and sharing already exist.** Wabi, Lovable, Replit, and Emergent all host apps and have discovery feeds. That layer is built and well funded.

**What GitHub actually gives you that this ecosystem lacks is the green check** — a visible, independent signal that the code passed real tests. That does not exist for personal software. Nobody can look at a shared app and know whether it is safe.

So the missing layer is not storage. It is **trust**, and specifically trust backed by something a machine can verify rather than something a vendor asserts.

## What this means for our work

Three things follow directly.

**We are not building a security scanner.** There are at least eight of those already, most free or under thirty dollars. That market is a race to the bottom.

**We are not building a consumer platform.** That is a funding and network-effects race, and Wabi has a16z behind it.

**We are building the verification layer**, and proving it works by shipping real software through it — which is what CounselOS is for. Regulated industries like law are the right first customers, because "it looked done" is not an acceptable outcome when a missed deadline is a malpractice claim.

## The habits this should give you

Everything above turns into a small number of rules for how you work here.

**Green does not mean done.** A passing test suite means the code ran. Ask what it proved.

**Write the assertion, not just the test.** If you deleted a line of the code under test and your test still passed, the test is decoration.

**Security is a layer, not a feature.** Nobody will ask you to add access control. Add it anyway, and assume an agent will not.

**Never trust a report over an artifact.** If an agent says the tests pass, run them. If a document says the schema is empty, check the schema. We have been wrong in both directions on this project, and the fix was always the same — go look.

**A preview must be able to go stale.** Anything that tells someone what will happen has to know when its information expired.

## Sources

Checked 2026-10-05. Figures not listed here have not been re-checked.

- **Georgia Tech SSLab, Vibe Security Radar.** "Bad Vibes: AI-Generated Code is Vulnerable, Researchers Warn," Georgia Tech Research news, 13 April 2026: https://news.research.gatech.edu/2026/04/13/bad-vibes-ai-generated-code-vulnerable-researchers-warn. It reports 74 confirmed cases, about 18 across seven months in the second half of 2025, 56 in the first three months of 2026, and 35 in March 2026. It gives no separate January or February counts. *Corrected 2026-10-05:* the table said "by March 2026, growing 6 → 15 → 35 per month". Those three months sum to 56, not 74, and the article does not state the January and February figures.
- **The 91.5% figure** `[pending citation]`. No primary report was found. GuardMint's own article on vibe-coding risks (https://guardmint.io/articles/article-vibe-coding-security-risks.html) does not contain the figure. Secondary write-ups disagree on the source: one attributes it to GuardMint's Q1 2026 assessment of "200+" apps, another to a Kingbird Solutions Q1 2026 audit of "over 200" apps. 183 of exactly 200 is 91.5%, so "200+" and "91.5%" cannot both be exact. The sentence stays marked until the primary report is found.
