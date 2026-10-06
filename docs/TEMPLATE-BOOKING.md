# template-booking

Status: `[specced]`. Build status lives in `STATE.md`. First client: a vehicle-decal shop.

**AVEL agents: start at *For AVEL agents*, near the end. Read only the sections it sends you to.**

A public booking site. Customers open a link, pick a service and a time, and leave their details — no account. The owner is notified by email, and manages his schedule from an admin page he signs into with Google.

Related: `TEMPLATES.md` for how templates work, `ROSTER-V2.md` for names and the merge rule, `GOLDEN-FIXTURE.md` for Fenn's scenarios, `SANDBOX.md` for where agents run.

---

## Template first, client second

| | Mission 1 | Mission 2 |
|---|---|---|
| Builds | `template-booking`, generic | The decal shop's site, created from the template |
| `origin` | `internal` | `client` |
| Lives in | The `avelco` org | The client's repository |
| Starts | Now | When the client is ready |

**The template stays generic.** No industry terms, client names, brand assets, or client data anywhere in it. Anything learned during the client build that would help every booking client goes back into the template by hand. Nothing client-specific ever does.

**Mission 2 is AVEL's first `recorded · client` mission** — the first real measurement of what a delivery costs. Every field on `CompletionReport` gets filled. It is never combined with Mission 1's numbers.

---

## Tech stack

Pin exact versions when scaffolding; this document names choices, not versions.

**Five outside services, every one owned by the client. Everything else is a library inside the app.** Each outside service is another account the client has to own, pay for, and keep working, so the list is kept as short as the requirements allow.

### Outside services

| Service | Used for |
|---|---|
| **Vercel** | Hosting, the scheduled retry job, and logs |
| **Neon** | Postgres |
| **Resend** | Email |
| **Google Cloud** | The OAuth client behind "Sign in with Google" |
| **Cloudflare** | Turnstile, the spam check on the public booking form — free |

**Notifications are email only in this version.** Texting the owner is deferred: US carriers require a business to register before an app can text, and approval takes days. When it is added, Twilio becomes the sixth service, and registration starts during that client's intake — not the week of launch.

### Libraries

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js**, App Router, TypeScript in strict mode | Pages and API in one deployable |
| Database access | **Drizzle** | SQL-first migrations, and allows the raw SQL the overlap constraint needs |
| Validation and contract | **Zod** | One schema for the form, the API, and the database layer; the OpenAPI contract is generated from it |
| Owner sign-in | **Better Auth**, Google provider | Auth.js's maintainers now recommend Better Auth for new projects |
| Dates and time zones | **Luxon** | Explicit time zones, and it can say when a local time does not exist |
| UI | **Tailwind** and **shadcn/ui** | Mobile-first |
| CI | **GitHub Actions** running `gate.yml` | |
| Package manager | **pnpm** | |

### What was removed, and what replaced it

| Removed | Replaced by |
|---|---|
| Inngest | The app sends notifications right after the booking commits, without making the customer wait, and a scheduled job on Vercel retries anything still unsent |
| Upstash Redis | Rate-limit counters in Postgres |
| Sentry and an uptime monitor | Vercel's logs and the outbox's own record of failed sends. Add either later if the site ever needs it. |
| React Email | Plain HTML emails — booking confirmations are short |
| React Hook Form | Native forms validated with Zod — every form in the app is short |
| Lighthouse CI | Nothing. A booking page is not performance-sensitive, so the `performance` role is not composed for this template, per the composition rule in `ROSTER-V2.md`. |

**Removing Inngest doesn't weaken the delivery guarantee,** because the guarantee was never Inngest — it is the outbox table. Bookings and their notification rows still commit together, and every booking still appears in the admin whether or not a message went out (R16). How often the retry job can run depends on the Vercel plan; check it before launch, since it sets how long a failed send waits for its next attempt.

### Testing stack, mapped to roles

| Tool | Role | What it does |
|---|---|---|
| Vitest | `backend-tests`, `frontend-tests` | Unit and component tests |
| Playwright | `frontend-tests`, golden runner | End-to-end flows; replays Fenn's scenarios |
| fast-check | `property-tests`, `adversarial` | Raze's invariants, and malformed input against the public API |
| Stryker | Mutation gate | Proves the tests actually catch defects |
| `@axe-core/playwright` | `accessibility` | Accessibility violations on every page |

---

## How the stack enforces the hard parts

Each of these turns a rule someone could forget into one the system refuses to break.

**The database refuses double-booking.** Capacity is modelled as numbered units — capacity 3 means three units. Each booking holds one unit for a time range, and a Postgres exclusion constraint refuses two confirmed bookings on the same unit with overlapping times. The application checks first for a friendly error, but the database is the guarantee. Two customers submitting at the same instant cannot both succeed, whatever the application code does.

**Bookings and their notifications commit together.** Creating a booking writes the booking and its notification rows in one transaction. The app sends them immediately after the commit, and a scheduled job retries anything still unsent. If the transaction fails, nothing is sent; if a send fails, the booking still exists and still shows in the admin. Each notification row has a unique key, so a retried request cannot send twice. Use a database connection mode that supports transactions.

**Rate limits live in the same database.** Counters per IP address, per email, and per phone number are rows in Postgres, so there is no second data store to run or pay for. At one shop's traffic, Postgres handles this without strain.

**One API, through route handlers.** The public booking flow and the admin call the same `/api/*` route handlers rather than server actions, so there is exactly one contract to validate, rate-limit, fuzz, and test.

**The clock and identifiers are injectable.** All code reads the time from `lib/clock.ts` and creates identifiers through `lib/ids.ts`. In tests both are fixed, which is what lets Fenn's scenarios compare exactly. A lint rule rejects `Date.now()`, `new Date()`, and `crypto.randomUUID()` anywhere else.

**Secret links store only a hash.** A manage-booking link is 32 random bytes. The database keeps only its hash, so a leaked database cannot be used to open anyone's booking.

**Only allow-listed emails get in.** Google sign-in on its own accepts any Google account. The sign-in hook rejects every address not on the configured allow-list.

---

## Requirements

Each requirement has an ID. Acceptance criteria cite the requirement they come from, so every requirement traces to criteria, and every criterion to tests and Fenn's scenarios.

### Public booking — customers never log in

- **R1.** A customer picks a service, then a date and time, then enters name, email, phone, and an optional note, then confirms.
- **R2.** The booking is confirmed instantly, and a confirmation screen shows the details.
- **R3.** Only genuinely open times are offered. A time disappears as soon as it is booked.
- **R4.** Services vary in length, from under an hour to several days. A multi-day booking blocks every day it spans.
- **R5.** Each time slot has a capacity, default 1. Bookings never exceed it, including when two customers submit at the same moment.
- **R6.** Minimum notice and how far ahead customers may book are both configurable.
- **R7.** A shared link can open the flow on one service: `/book?service=<id>`.
- **R8.** The customer can view or cancel through a secret link in their confirmation email. Cancelling frees the time immediately.

### Admin — owner only

- **R9.** The owner signs in with Google. Only allow-listed addresses get in; every other account is refused. Sessions last about 30 days.
- **R10.** The owner sets weekly hours, days off, and blocked dates. Changes apply immediately. Existing bookings inside newly blocked time are flagged, never silently deleted.
- **R11.** The owner adds, edits, and removes services, each with a name, a duration, and a price shown one of three ways: a fixed price, a "starting at" price, or "quote on request" with no price.
- **R12.** The owner sees upcoming bookings, opens any one, and can cancel it. Cancelling emails the customer.
- **R13.** The owner can add a booking by hand for customers who call in. It blocks the time exactly like an online booking.

### Notifications

- **R14.** Every new booking emails the owner, and emails the customer a confirmation.
- **R15.** The app sends no text messages in this version. When texting is added, texts go only to the owner's configured number, never to a number a customer typed in.
- **R16.** The booking is saved before anything is sent. Failed sends retry and are logged. A failed notification never loses or undoes a booking, and every booking appears in the admin regardless.
- **R17.** One booking produces exactly one set of notifications, even when a request or a send is retried.

### Time

- **R18.** Times are stored in UTC and displayed in the shop's configured time zone, never the visitor's device time.
- **R19.** On a daylight-saving change, the skipped hour is never offered and the repeated hour cannot be double-booked.

### Security and privacy

- **R20.** The public booking endpoint has rate limiting, a spam check, and limits per email address and per phone number.
- **R21.** Secret links are unguessable, and no link reveals anyone else's booking.
- **R22.** A privacy page explains what is collected and why. Nothing beyond what R1 lists is collected.

### Quoted services

- **R23.** A quoted service books a short consultation, not the job itself. The owner then schedules the actual job as a manual booking (R13) once the price is agreed.

### Service length and options

- **R24.** Every service is one of two kinds:
  - **Timed** — the customer picks a date and a time. The whole job must fit within one day's opening hours; a job never starts so late that it would run past closing.
  - **Day-based** — the customer picks only a start date. The job starts at opening time and is counted in working days, skipping days off and blocked dates. It holds its capacity unit continuously from that opening until closing on its last working day, including any closed days in between, because the work in progress stays on site.
- **R25.** A service may have one set of options, each with its own length and price, and the customer picks one while booking. A service without options behaves exactly as before. Only one set of options per service — no combinations of several.
- **R26.** When a booking is made, the service name, the chosen option, the length, and the price are copied onto the booking. Editing or removing a service never changes a booking that already exists.

### Privacy over time

- **R27.** After a configurable period — default 24 months after the appointment — the customer's name, email, and phone are removed from the booking. The booking itself remains, so the owner keeps his history without keeping anyone's contact details indefinitely.

**Requirement IDs are permanent.** New requirements are added at the end with the next number; existing ones are never renumbered, because acceptance criteria, tests, and Fenn's scenarios all cite them.

**Write the most precise criteria for R5, R13, R16, R19, R23, R24, and R26.** Fenn's scenarios test them exactly, and they are where booking apps usually break.

---

## Configuration

Set per deployment, never hardcoded:

- Shop name and time zone
- Owner email
- Admin allow-list
- Brand colours and logo
- How long customer details are kept, default 24 months
- Default capacity, minimum notice, and booking window
- Sender email address

## Out of scope

Not built, and not designed around: payments and deposits, customer accounts, text messages of any kind, file uploads, rescheduling (customers cancel and rebook), multiple locations, and individual staff calendars.

---

## Routes

### Public pages

| Route | Purpose |
|---|---|
| `/` | Shop information, services, and a Book button. This is the link the owner shares. It needs a proper preview image and title for when the link is texted or posted. |
| `/book` | The booking flow: service, then option if the service has any, then a date — plus a time for timed services — then details, then confirm |
| `/book?service=<id>` | The same flow, starting on one service |
| `/booking/[token]` | The customer views or cancels their booking |
| `/privacy` | What is collected and why |

### Admin pages

| Route | Purpose |
|---|---|
| `/admin/login` | Sign in with Google |
| `/admin` | Upcoming bookings, with flagged bookings at the top |
| `/admin/schedule` | Weekly hours, days off, blocked dates |
| `/admin/services` | Services, durations, prices |
| `/admin/bookings/new` | Add a booking by hand |
| `/admin/bookings/[id]` | One booking, with cancel |

### API

| Method | Route | Access |
|---|---|---|
| GET | `/api/services` | Public |
| GET | `/api/availability?service=&option=&from=&to=` | Public |
| POST | `/api/bookings` | Public — rate-limited, spam-checked |
| GET | `/api/bookings/[token]` | Secret link |
| POST | `/api/bookings/[token]/cancel` | Secret link |
| GET, POST, PATCH, DELETE | `/api/admin/services` | Owner |
| GET, PUT | `/api/admin/schedule` | Owner |
| GET, POST | `/api/admin/bookings` | Owner — POST is a manual booking |
| POST | `/api/admin/bookings/[id]/cancel` | Owner |
| GET | `/api/health` | Public |
| — | `/api/auth/*` | Better Auth's own routes |

---

## Data model

```
shop_settings        one row: name, time_zone, owner_email, owner_phone,
                     default_capacity, min_notice_minutes, booking_window_days,
                     sender_email, brand
admin_allowlist      email
services             id, name, kind ('timed' | 'day_based'),
                     duration_minutes (timed) or duration_days (day_based),
                     price_mode ('fixed' | 'from' | 'quote'),
                     price_cents (null when price_mode is 'quote'), active, sort_order
service_options      id, service_id, label, duration_minutes or duration_days,
                     price_mode, price_cents, sort_order — each overrides its service
weekly_hours         weekday, opens_at, closes_at — more than one row per day allowed
blocked_periods      id, starts_at, ends_at, reason
capacity_units       id, label — capacity N means N rows
bookings             id, service_id, option_id, unit_id, period (tstzrange),
                     status ('confirmed' | 'cancelled'), source ('online' | 'manual'),
                     service_name, option_label, kind, duration, price_mode,
                       price_cents — copied at booking time, never updated (R26)
                     customer_name, customer_email, customer_phone, note
                       — removed after the retention period (R27)
                     manage_token_hash, flagged, created_at, cancelled_at, anonymized_at
notification_outbox  id, booking_id, kind, channel ('email'; 'sms' added with texting), recipient,
                     idempotency_key (unique), status, attempts, last_error,
                     next_attempt_at, sent_at
Better Auth tables   user, session, account, verification
```

The constraint that makes double-booking impossible:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (unit_id WITH =, period WITH &&)
  WHERE (status = 'confirmed');
```

Rate-limit counters are a Postgres table too:

```
rate_limits          key (for example 'ip:…', 'email:…', 'phone:…'), window_start, count
```

---

## Roster — ten model agents plus the operator

| Phase | Agent | Covers |
|---|---|---|
| A | Axis | `foundations` — the operator |
| A | Fantem | `design-system`, mobile-first, brand tokens swappable per deployment |
| A | Fenn | `fixture`, written from the acceptance criteria with the application absent from his room |
| B | Atlas · scheduling | Services, hours, capacity, availability, bookings, and the admin pages that edit them |
| B | Atlas · notifications | Every email, the outbox, retries |
| B | Atlas · accounts | Owner sign-in and the allow-list only |
| C | Nemi | `backend-tests`, `frontend-tests` |
| C | Raze | `property-tests` |
| D | Brennan | `spec-judgment` |
| D | Zane | `security-review` |
| D | Kodie | `concurrency` |

The admin pages for schedule, services, and bookings belong to Atlas · scheduling, because they edit scheduling's own data. A separate admin agent would put two agents on the same tables.

**The checks that matter most:**

- **Raze** — bookings never exceed capacity; a taken time is never offered; exactly one set of notifications per booking
- **Kodie** — two customers submitting the same time at once; the exclusion constraint must be the thing that stops the second
- **Zane** — the admin allow-list, the secret links, the public booking endpoint, and personal data
- **Fuzzer** — `POST /api/bookings`, since it accepts input from anyone on the internet
- **Accessibility** — every public page, since most customers book on a phone

Every row stays on one side — author, tester, judge, or fixture — per the merge rule in `ROSTER-V2.md`.

---

## Build by modules

The template is built one module at a time. Each module is a complete, working piece with its own requirements, acceptance criteria, Fenn scenarios, and green gate. **No module starts until the one before it is green.**

| Module | Builds | Requirements | Built by | Needs |
|---|---|---|---|---|
| **M0 Foundation** | Next.js scaffold, Postgres and Drizzle, settings, injectable clock and IDs with the lint rule, the shared rate-limit utility, **the outbox table and its `enqueue` function**, CI and `gate.yml`, design tokens, test harness, golden-scenario runner, `/api/health` | — | Axis, Fantem | — |
| **M1 Owner sign-in** | Better Auth with Google, the allow-list, sessions, and `requireOwner` — the session check every admin route calls | R9 | Atlas · accounts | M0 |
| **M2 Services** | The admin layout, services, timed and day-based kinds, options, price modes, the services admin page, the public services API | R11, R25, and the kinds in R24 | Atlas · scheduling | M1 |
| **M3 Schedule** | Weekly hours, days off, blocked dates, capacity units, the schedule admin page | R10, except flagging | Atlas · scheduling | M1 |
| **M4 Availability** | Open times for timed and day-based jobs, minimum notice, booking window, time zone, daylight saving | R3, R4, R6, R18, R19, R24 | Atlas · scheduling | M2, M3 |
| **M5 Booking** | The public flow, creating bookings under the overlap constraint, capacity, snapshots, confirmation, the manage link, deep links, quoted consultations, writing outbox rows | R1, R2, R5, R7, R8, R21, R23, R26 | Atlas · scheduling | M4 |
| **M6 Admin bookings** | Booking list and detail, owner cancel, manual bookings, flagging bookings caught in newly blocked time | R10 flagging, R12, R13 | Atlas · scheduling | M5 |
| **M7 Notifications** | The worker that delivers outbox rows, owner and customer emails, retries, exactly-once delivery, cancellation emails | R14, R15, R16, R17 | Atlas · notifications | M5 |
| **M8 Protection** | Rate limits, the spam check, per-email and per-phone limits on the public endpoint | R20 | Atlas · scheduling | M5 |
| **M9 Public site and privacy** | The landing page with its link preview, the privacy page, the retention job | R22, R27 | Atlas · scheduling | M5 |

Every requirement belongs to at least one module. R10 and R24 are split across two, and R12's cancellation email is delivered by M7.

**The outbox is built in M0, not M7.** M5 writes notification rows when a booking is made, so the table has to exist before M5. An earlier version of this plan built it in M7, two modules too late. M0 provides the table and `enqueue`; M7 provides only the worker that delivers what is already queued. Likewise the admin layout moved from M1 to M2, because the admin pages belong to Atlas · scheduling, not Atlas · accounts.

### Why modules

- **Smaller dispatches.** Each agent works on one module's scope rather than its whole territory at once, which keeps its context small — the concern the grain thresholds were written for.
- **Something working at every step.** After M5 the site takes real bookings, even before notifications exist.
- **Ten measured runs instead of one.** Each module is recorded as its own mission, `origin: internal`. Discipline numbers compare across modules. Outcome numbers compare only between runs of the *same* module, because M4 and M7 are different jobs.

### Who works each module

Every module that writes source has an author, a tester, a judge, and Fenn — the floor from the merge rule.

| Module | Author | Testers | Judges | Fenn writes |
|---|---|---|---|---|
| M0 | Axis, Fantem | Nemi | Brennan | `seed.json` and `clock.json` |
| M1 | Atlas · accounts | Nemi | Brennan, Zane | Allowed and refused sign-ins |
| M2 | Atlas · scheduling | Nemi | Brennan | Services, options, price modes |
| M3 | Atlas · scheduling | Nemi | Brennan | Hours, days off, blocked dates |
| M4 | Atlas · scheduling | Nemi, Raze | Brennan | Open times, including the daylight-saving cases |
| M5 | Atlas · scheduling | Nemi, Raze | Brennan, Zane, Kodie | Bookings, including two customers on one slot |
| M6 | Atlas · scheduling | Nemi | Brennan | Manual bookings, flagging |
| M7 | Atlas · notifications | Nemi, Raze | Brennan, Zane | Failed sends, exactly-once delivery |
| M8 | Atlas · scheduling | Nemi | Zane, Brennan | Abuse of the public endpoint |
| M9 | Atlas · scheduling | Nemi | Brennan, Zane | Retention |

Code roles run on every module where they apply: mutation testing always, accessibility on any module with pages, and the fuzzer on M5 and M8.

### A module is done when

- Every acceptance criterion for its requirements passes
- Fenn's scenarios for its requirements pass against the running application
- The gate is green: types, lint, tests, the mutation floor, and accessibility where it has pages
- Every earlier module's tests and scenarios still pass
- Its mission record is complete, including `estimated_tokens` and `actual_tokens`

### Order

Sequential by default. **M6 and M7 are the one pair that can run in parallel** — both depend only on M5, and they belong to different agents. Running them together would be the first real test of two feature agents working at the same time, which is where misunderstandings between agents show up, and what recording artifact hashes is meant to catch. Optional; sequential is safe.

---

## For AVEL agents

This section is written for the agents that build the template. Each dispatch covers **one module**. Read only:

1. This section's **rules**
2. **Your brief**, below
3. **Your module's row** in *Build by modules*
4. **Your module's requirements** and their acceptance criteria — nothing else from *Requirements*

Everything else in this document is context for the operator. Reading more than you need costs context and buys nothing.

### Rules for every agent

1. **Write only inside your mount.** If the work needs a file outside it, file a blocker. Never work around a mount.
2. **Builders never write tests. Testers never write source. Fenn never sees source** — not read-only; absent.
3. **Record the SHA-256 of every artifact you read** in your completion report.
4. **Cite requirement IDs.** Every acceptance criterion and every test names the requirement it serves. IDs are permanent.
5. **The stack is fixed.** Adding a dependency or an outside service is a blocker, not a decision. In particular, nothing re-adds a queue, Redis, an error tracker, or a texting service.
6. **Time comes from `src/lib/clock.ts` and identifiers from `src/lib/ids.ts`.** Nowhere else. The lint rule enforces it.
7. **Email only.** Nothing in this version sends a text message.
8. **Report, don't fix,** anything outside your module — including problems in earlier modules.
9. **Close every dispatch with a completion report:** `actual_tokens`, artifacts read and written with their hashes, and every blocker, marked as a provisioning gap or not.

### Layout and mounts

**Proposed — confirmed or corrected in M0 before any mount is enforced.**

Every boundary is a directory or a single named file. Tests live in their own directories, never beside source, so no boundary needs the exit checkpoint. Next.js route groups — folders in parentheses, which do not appear in the URL — let each agent own its own routes.

| Path | Owner |
|---|---|
| `src/app/layout.tsx` | Axis |
| `src/app/(public)/` — landing, booking flow, manage link, privacy | Atlas · scheduling |
| `src/app/admin/login/` | Atlas · accounts |
| `src/app/admin/(manage)/` — admin layout, bookings, schedule, services | Atlas · scheduling |
| `src/app/api/auth/` | Atlas · accounts |
| `src/app/api/(scheduling)/` — services, availability, bookings, admin | Atlas · scheduling |
| `src/app/api/cron/` — the retry job | Atlas · notifications |
| `src/app/api/health/` | Axis |
| `src/middleware.ts` | Atlas · accounts |
| `src/features/scheduling/` — including `sql/` for the overlap constraint | Atlas · scheduling |
| `src/features/notifications/` | Atlas · notifications |
| `src/features/accounts/` | Atlas · accounts |
| `src/lib/` — clock, IDs, database, environment, rate limits, outbox | Axis |
| `src/ui/`, `src/styles/` | Fantem |
| `drizzle/` — migrations | No agent. Generated by a code step from each feature's `schema.ts`. |
| `tests/unit/`, `tests/e2e/` | Nemi |
| `tests/property/` | Raze |
| `fixtures/golden/` | Fenn |
| `findings/<role>/` | Brennan, Zane, Kodie — each in their own |
| `.avel/` | The operator, by hand |

**Migrations are generated, not written.** Feature agents edit their own `schema.ts`; a code step generates the migration. The one exception is the overlap constraint, which is raw SQL kept in `src/features/scheduling/sql/` and included by that step.

### Edges

| From | Artifact | To |
|---|---|---|
| Axis | `src/lib/` — clock, IDs, database, rate limits | Every Atlas |
| Axis | `src/lib/outbox` — `enqueue` | Atlas · scheduling, from M5 |
| Axis | `src/lib/outbox` — queued rows | Atlas · notifications, in M7 |
| Fantem | `src/ui/`, `src/styles/` | Atlas · scheduling, Atlas · accounts |
| Atlas · accounts | `requireOwner` | Atlas · scheduling |
| The operator | Approved acceptance criteria | Fenn, Nemi, Raze, Brennan |
| Brennan, Zane, Kodie | `findings/` | The ship decision — a function |

### Skills to write before dispatch

None exist yet. Each is written by the operator, reviewed, and approved before it can attach. See `SKILLS.md`.

**Stack** — given at dispatch to the agents whose roles they are recommended for:

| Skill | Recommended for |
|---|---|
| Next.js route groups and route handlers | `api-surface`, `interface`, `auth` |
| Drizzle schemas and generated migrations | `schema` |
| Postgres exclusion constraints for overlapping ranges | `schema`, `domain`, `concurrency` |
| The outbox pattern: commit, then send, then retry | `domain`, `integration` |
| Better Auth with a Google allow-list | `auth`, `security-review` |
| Luxon, shop time zones, and daylight saving | `domain`, `property-tests` |

**Domain** — the booking vocabulary, and the difference between timed and day-based services. Recommended for every role on the roster.

**Role** — the skills that become part of each identity file. The first to write are the ones this template leans on hardest: Raze's property testing, Brennan's search for code and tests that agree and are both wrong, and Zane's rule that middleware alone does not protect an admin route.

A capability skill also needs writing for the running room's headless browser, which `frontend-tests` and the accessibility scan both use.

### Briefs

**Axis — the operator.** M0. Writes `src/app/layout.tsx`, `src/lib/`, `api/health/`, CI, and `.avel/`. Provides the clock, IDs, database connection, environment loading, rate-limit utility, and outbox. Runs the migration step.

**Fantem.** M0, and whenever brand tokens change. Writes `src/ui/` and `src/styles/`. Every colour, font, and radius is a token swappable per deployment — none hardcoded in a component. Mobile-first. Visible focus states and sufficient contrast in every primitive, since the accessibility scan runs on every page built from them.

**Fenn.** Every module. Writes `fixtures/golden/` and nothing else. Reads only the approved acceptance criteria and the requirements in this document — never `src/`, never `tests/`, never application output. In M0, writes `seed.json` and `clock.json`. In each later module, writes scenarios for that module, each citing the criteria it covers. Changes a scenario only when the specification changes.

**Atlas · accounts.** M1. Writes `src/features/accounts/`, `src/app/admin/login/`, `src/app/api/auth/`, and `src/middleware.ts`. Owns R9. Provides `requireOwner`. The allow-list check lives in the sign-in hook. **Middleware alone is not enough:** in 2025 a Next.js flaw let crafted requests skip middleware entirely. Every admin route handler calls `requireOwner` itself.

**Atlas · scheduling.** M2–M6, M8, M9. Writes `src/features/scheduling/`, `src/app/(public)/`, `src/app/admin/(manage)/`, and `src/app/api/(scheduling)/`. Owns every requirement except R9 and R14–R17. Calls `requireOwner` in every admin handler and `enqueue` inside the same transaction as the booking it notifies about. Watch: the overlap constraint is the guarantee, not the application check; snapshots are written once and never updated; every displayed time is in the shop's time zone; day-based jobs skip closed days but hold their unit through them.

**Atlas · notifications.** M7. Writes `src/features/notifications/` and `src/app/api/cron/`. Owns R14–R17. Delivers queued rows, retries failures, and marks each row sent exactly once using its idempotency key. A failed send never throws into the booking path. Email only.

**Nemi.** Every module. Writes `tests/unit/` and `tests/e2e/`. Reads all source; writes none of it. Every test names the acceptance criterion it covers, which is what lets `spec-check` find a criterion with no test.

**Raze.** M4, M5, M7. Writes `tests/property/`. Properties: bookings never exceed capacity; a taken time is never offered; a day-based job skips closed days but holds its unit through them; one booking always produces exactly one set of notifications, under any sequence of retries.

**Brennan.** Every module. Writes `findings/spec-judgment/`. Judges each module's implementation against its requirements and criteria. Above all, looks for code and tests that agree with each other and are both wrong — the failure mutation testing cannot catch.

**Zane.** M1, M5, M7, M8, M9. Writes `findings/security-review/`. The allow-list; `requireOwner` in every admin handler, not only middleware; secret links stored only as hashes; abuse of the public booking endpoint; personal data and its removal after the retention period.

**Kodie.** M5. Writes `findings/concurrency/`. Two customers submitting the same time at the same instant: the overlap constraint, not the application check, must be what stops the second. Also the same race at capacity greater than one.

---

## The client instance: vehicle decals

Created from the template when the client is ready. Canon runs intake first, turning the client's answers into the brief.

### Service catalog

The client's services, seeded into his instance and editable from the admin. **None of this goes into the template.**

Booking lengths below are starting values. They sit at the longer end of each typical range, so the calendar doesn't overbook when a job runs long. The client confirms or corrects every one during intake.

| Service | Typical length | Booked as | Price shown |
|---|---|---|---|
| Small decals — window or bumper | Under an hour | 1 hour | Fixed or starting at |
| Windshield banner or sun strip | Under an hour | 1 hour | Fixed |
| Business lettering or door logos | 1–3 hours | 3 hours | Starting at |
| Racing stripes | 2–4 hours | 4 hours | Starting at |
| Decal or adhesive removal | 1–3 hours | 3 hours | Starting at |
| Partial wrap — hood, roof, or mirrors | Half a day | 4 hours | Starting at |
| Chrome delete | Half a day to a full day | 1 working day, day-based | Starting at |
| Full color-change wrap | 2–5 days | Day-based, with size options below | Starting at |
| Commercial or fleet graphics | Varies | 30-minute consultation | Quote on request |
| Design consultation | About 30 minutes | 30 minutes | Fixed, or free |

**Quoted work books a consultation, not the job.** Fleet graphics can't be priced or timed until the owner has seen the vehicles and the artwork. So the customer books a 30-minute consultation, and once a price is agreed, the owner adds the real job himself as a manual booking. That uses features the template already has, rather than inventing a quoting system.

**Vehicle size is handled with options (R25).** The full wrap starts with three:

| Option | Booked as |
|---|---|
| Compact | 2 working days |
| Sedan | 3 working days |
| SUV or truck | 4 working days |

Other services can gain size options later if the client prices them by vehicle. Prices are the client's to set during intake.

**How a multi-day job lands on the calendar (R24).** A sedan wrap starting on a Friday runs Friday, Monday, and Tuesday. The weekend doesn't count as work time, but the car is in the bay all weekend, so the bay stays booked.

### What to collect from the client

- For every service in the catalog above: whether he offers it, how long it really takes, its price, and which ones he only quotes
- Whether vehicle size changes the length or price, and for which services
- How many jobs can run at once — this sets capacity
- Shop hours and regular days off
- Cancellation policy
- Logo, colours, and fonts
- The domain name, and who owns the hosting and email accounts
- The owner's email and mobile number, and any other emails allowed into the admin

### Client-only work

- Brand tokens and copy
- **Email deliverability** — SPF, DKIM, and DMARC records on the client's domain, so booking emails don't land in spam. The owner receives bookings by email; if they go to spam, he never sees them.
- Seeding his services, hours, and capacity
- Fenn's client scenarios — a sedan wrap starting Friday that skips the weekend but holds the bay through it, a timed job that would run past closing being refused, a quoted service booking a consultation rather than a job, a price change that leaves existing bookings untouched, and every unit booked solid

### Who owns the accounts

**The client owns every account** — the five outside services in the tech stack, plus his domain, all in his name — and AVEL is given access to work on them. He pays his own usage. Handover means nothing to transfer. And it matches AVEL's own terms of fixed prices and no retainers: a client whose site runs on the agency's accounts depends on the agency whether either side intends it or not.

### Likely later additions

Each needs its own agent and its own review if added: **texting the owner**, the first addition expected, with carrier registration started during intake; deposits through a hosted payment page, so card details never touch the application; texting customers, with protection against SMS pumping; and customer artwork uploads, with file-type, size, and storage checks.

---

## Decisions

All five are decided. Nothing in this document blocks scaffolding or acceptance criteria.

| # | Question | Decided |
|---|---|---|
| 1 | Stack | `template-booking` is a separate template on Next.js. `template-fullstack` on FastAPI and React is deferred; FastAPI interview practice happens separately. |
| 2 | How multi-day jobs map onto working hours | **Whole working days.** A day-based job counts working days only and holds its unit continuously through closed days in between. Timed jobs must fit inside one day's hours. — R24 |
| 3 | How vehicle size is handled | **Options on a service,** one set per service, each with its own length and price. What was agreed is copied onto the booking. — R25, R26 |
| 4 | How long customer details are kept | **24 months after the appointment, then removed;** the booking record stays. Configurable. — R27 |
| 5 | Whose accounts the client's site runs on | **The client's,** with access granted to AVEL. |
