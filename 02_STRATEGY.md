---
file: 02_STRATEGY.md
version: v1.2
status: CURRENT
last_updated: 2026-04-25
supersedes: none
---

# StageLink365 — PRODUCT STRATEGY

*A reference document distilling the GigSalad competitive teardown and the customer-acquisition playbook into a permanent, in-repo strategy artifact. Source materials live in `strategy/`. Read this after `00_STAGELINK365_BRIEF_CURRENT.md` and `01_CURRENT_STATE.md` so positioning, moats, and the 90-day plan inform every change to the codebase.*

---

## 1. The one-paragraph strategy

StageLink365 is not a cold-start marketplace. TAD Shows already places talent on 30+ cruise lines, which gives Day-1 supply (a vetted roster) and Day-1 demand (existing cruise/corporate buyers). The job is to migrate a working operation onto software, then widen both ends — and to do it by serving the segments GigSalad architecturally ignores: cruise, casino, corporate, venue residency, and booking agencies. GigSalad has spent 19 years optimising for backyard birthdays and DIY event planners; they will not retool for the serious end of the market. SL365's swim lane is the intersection no one else occupies: marketplace plus agency operations plus venue operations plus a real verification ladder, for repeat, high-AOV bookings.

**Strategic one-liner (homepage H1):** "Serious bookings, not bidding wars."

**Homepage sub-tagline:** "The booking platform built for casino, corporate, and venue residency — where talent, agencies, and venues work together, not against each other."

**Positioning triangle.** Three commitments that everything else flows from. *Serious bookings* — casino, corporate, venue residency; not backyard birthdays. *Not bidding wars* — quality-over-quantity matching, no blasting to ten strangers. *Designed for the whole booking chain* — talent, agencies, and venues in one platform; GigSalad has none of this beyond a single performer account.

(Note on segments: cruise is a major *go-to-market* lever for SL365 — TAD Shows' cruise rolodex is the asymmetric advantage that powers the 90-day plan in §5 — but it is intentionally absent from the **homepage H1, sub-tagline, positioning triangle, and Founder Tier section**. Those four surfaces define SL365's outward identity. Body copy elsewhere — feature lists, testimonials, venue-type taxonomy, sample profiles — may name cruise as one of several buyer segments alongside casino, corporate, and venue, which is accurate to who SL365 actively serves and is not the same as making cruise the brand identity. The cruise relationships are the engine, not the brand.)

---

## 2. The three structural moats

These are the differentiators GigSalad cannot copy without rearchitecting their platform — which they just spent 2023–2025 doing on Laravel and won't repeat soon. Each one already has scaffolding in `index.html`'s role architecture; the depth is what's missing.

### I1 — Vendor / Agency roster model

GigSalad has nothing here. Their "agency" hack is buying multiple paid profiles and switching via dropdown. SL365 already has the vendor role with solo-agent vs agency branching in the onboarding wizard. The work to deepen it: roster view, inquiries aggregated across all roster acts, per-act commission splits, team inbox, submit-on-behalf-of-talent, CSV roster import.

This moat is also the supply lever for the 90-day plan — every agency that signs up brings an entire roster in one transaction. Agency Founder seats (50, capped) are the highest-leverage acquisition in the playbook.

**Code state today.** Vendor role exists; vendor-onboarding wizard exists; "I'm also a performer" dual-role toggle exists (already free, GigSalad paywalls this). What's missing: the roster ops layer.

### I2 — Venue Booker Hub as a first-class role

GigSalad's booker persona is "event planner for one-off party." Zero tooling for venues. SL365 has Venue onboarding plus the Booker Hub already routed in `index.html`. The depth to add: residency bookings, multi-date bookings, technical rider uploads, stage specs, recurring entertainment slots, deposit + NET-30 balance for verified enterprise bookers (procurement-friendly, GigSalad refuses).

This is also where Terry's TAD Shows expertise compounds — cruise lines and casinos book this way; nobody else has built for it.

**Code state today.** Venue role exists; Booker Hub page is routed. What's missing: the booking-ops layer (calendar holds, multi-date, rider upload, NET-30 path).

### I3 — Trust / verification tier ladder

GigSalad's stated stance is "we do not endorse or verify" providers, with a help-doc telling clients to do their own due diligence. For backyard birthdays this is fine; for cruise, casino, and corporate it's a deal-breaker. SL365 builds tiers: ID Verified (Stripe Identity), References Verified, Background Checked. Display each as a separate badge. Required above a $-threshold (e.g. bookings over $2,500). This is a direct counter to the #5 review complaint and the gatekeeper unlock for cruise/corporate revenue.

**Code state today.** Not built. Requires a Stripe Identity decision plus a background-check vendor decision (Checkr is the obvious one) before any code work — both upstream of the Open Items list.

These three moats anchor the whole roadmap. Feature-parity work with GigSalad (escrow, quotes, calendar, reviews) is the *plumbing* — necessary but not differentiating. The moats are the *architecture*. Always invest in the architecture before chasing parity.

---

## 3. Steal / Improve / Skip — distilled

The full version is in `strategy/gigsalad-competitive-analysis.html`. The shortlist below is what matters for the next 12 months, mapped to the existing roadmap phases and Open Items.

### Steal outright

The dozen GigSalad mechanics worth cloning verbatim, ordered by where they fit into the build sequence.

**Already shipping or near-shipping.** Calendar sync with lead blocking (S10) is partially live for ~5 performers — generalise it for all users. Featured placement upsell (S11) belongs in the existing Premium tier, but should never be the primary monetisation.

**Step 4 polish (UI work in `index.html`).** Profile completeness meter (S3) — gamification driver, e.g. "Your profile is 78% complete — add 2 videos to hit 100%". Verified-booking review weighting (S5) — when reviews ship, on-platform bookings carry full weight, off-platform get a lower-weighted "verified off-platform" label. Response-time surfacing (S7) — "Typically responds in 2 hours" displayed on profiles, plus a UI nudge that responding within 1 hour improves booking odds.

**Messaging MVP (Step 4.5).** Quote-as-contract model (S2) — vendor's quote includes total, deposit, terms, expiration; accepting it creates the booking agreement, no separate PDF. Saved messages and saved quotes (S6) — after 2–3 responses, dropdown of templates with per-lead fill-ins; cheap to build, biggest productivity win pros mention. Seen/read receipts (S12) — trivial UI, gives vendors useful signal.

**Payments / bookings (Step 4.5+).** Escrow with Worry-Free Guarantee (S1) — planner pays in full at booking, deposit to vendor up front, balance 1–2 days post-event, full refund on vendor cancel/no-show. 24-hour post-event dispute window (S8) — bounded, predictable, clean. Cancellation policy presets (S9) — three presets (Strict / Standard / Flexible) with custom override per-quote; reduces onboarding friction.

**Step 5+.** Algorithmic Top Performer badge (S4) — earned via ≥80% 24-hr response rate + 4.8★ rating + ≥1 booking in the past 3 months; re-evaluated monthly; no purchase path. The cleanest algorithmic-trust model in the category — copy the formula.

### Improve on (the moats made concrete)

These are the architectural differentiators. They're worth investing in even when feature-parity work is louder.

**I1 Vendor / Agency roster model** — see §2. Step 4 vendor dashboard is the home for this. Required for Agency Founder onboarding to make sense.

**I2 Venue Booker Hub residency / multi-date** — see §2. Step 4 venue work. Differentiator for casino, cruise, corporate residency bookings.

**I3 Verification tier ladder** — see §2. Step 5 work; gates Stripe Identity and Checkr decisions.

**I4 Quality-over-quantity lead routing.** Cap broadcast leads at 3 matches (vs GigSalad's 10). Require planner to provide date + budget + event type before matching. Show the planner a transparency panel ("3 of 3 pros invited — 2 responded, ETA 4 hrs"). Refund lead-credit if fewer than 2 of 3 respond in 24 hours. This is the marketing message in code form, and it kills the #1 vendor complaint in the entire category.

**I5 Real date-availability search.** Calendar sync is already live for 5 performers; wire it into search/filter as the marquee differentiator before GigSalad ships theirs (still "in development" 19 years in). Headline: "Find pros free on your date."

**I6 AI / conversational matching.** GigSalad is still keyword + category. The 2026 industry trend is natural-language. Ship "Describe your event and we'll match" — behind it, smart ranking using availability, reviews, price, fit signals. Step 5+.

**I7 Band member profile linking.** Already on the roadmap. Individual talent links to or claims a spot in a band profile. Bookers see both the band and the humans. Unique richness GigSalad doesn't have.

**I8 Trust-tier-gated contact unlock.** Don't lock all pre-booking communications the way GigSalad does (drives workarounds, hurts trust). Allow in-platform voice/video calls. Top Performer / Verified tier unlocks contact exchange after deposit pledge. Balances trust against lock-in.

**I9 Deposit + NET-30 balance for enterprise.** GigSalad forces full upfront. Enterprise procurement and cruise lines often can't pay that way. Verified-booker NET-30 or event-day balance terms unlock procurement-gated segments. Step 5+.

**I10 Analytics beyond "leads and bookings".** Conversion funnel (views → inquiries → quotes → bookings), lost-bid analysis, profile A/B test, geographic heat-map. Step 5+.

### Skip

Seven things to deliberately not build, even when they look like obvious copies.

Bidding-style mass blasts to 10 vendors per request (X1) — the single biggest GigSalad complaint; I4 is the cure. Communication lockdown blocking phone/email/URL pre-booking (X2) — drives workarounds; use I8 trust-tier unlocks instead. Paywalled multiple profiles (X3) — dual-role should stay free; "I'm also a performer" toggle already gets this right. Featured placement as the *primary* monetisation (X4) — fine as a small secondary upsell, never the front door, or search starts feeling pay-to-play. Two-sided stacked fees without transparency (X5) — GigSalad charges planner 10–12% *and* vendor 2.5–5%; SL365 should publish an all-in number. Premium-only lead insights (X6) — make baseline transparency free (you vs others invited), monetise depth (conversion benchmarks, price-positioning data, recommended quote range). The "we don't verify anyone" stance (X7) — legally cleaner, strategically a gift to competitors; build I3 instead.

---

## 4. The Founder Tier offer engine

This is the engine that pulls everything else. Without it, the 90-day plan can't start, because every play in the supply and demand playbooks references "Founder Tier seat" as the offer. This section is the implementation spec.

### The mechanic

A capped, status-driven Founder Tier creates four marketing assets at once: sign-up velocity (scarcity drives action), a permanent advocate pool (members defend the platform on Reddit and Facebook for years because their reputation is tied to it), a public counter that is itself the marketing ("347 of 500 seats left"), and a self-terminating offer (the cap closes naturally, no awkward "can I still get the deal?" limbo).

The cardinal rule: **don't advertise discounts** ("get 3 months free"). Advertise scarcity and status ("Founder Tier — lifetime access. 500 seats total. 347 left."). Scarcity beats discounting every time, and the seats themselves become the marketing asset.

### The three tracks

Three tiers, hard-capped, one badge class each. Never dilute with "Silver Founder / Gold Founder" sub-tiers.

**Talent Founder** — 500 seats. Lifetime access to Pro-tier features (currently $19/mo). "Founding Member" badge on the public profile. Early-access vote on new features. Guaranteed inclusion in SL365's first booker-outreach campaigns (cruise EDs, casino EDs, ILEA chapter speaking slots — the demand-side activity in Weeks 3–8 of the 90-day plan). When SL365 platform payments go live, founder booking fee is 2% (vs 3% for non-Founders) — locked for life. Extra Founder months per successful referral. Expected fill: 90 days.

**Agency Founder** — 50 seats. 12 months of Agency tier free, then 50% off lifetime. "Founding Agency" badge. Concierge CSV roster migration done by SL365. Dedicated Slack channel with the SL365 team. Priority feature requests. Expected fill: 120 days.

**Venue Founder** — 50 seats. Booker Hub free for 12 months, then lifetime 50% off. Homepage logo placement among the founding venues. Priority search placement in their category. Concierge profile build-out by the SL365 team. "Founding Venue" badge. Expected fill: 180 days.

### Confirmed decisions (locked 2026-04-25)

Seven product decisions are locked here so the next coding session doesn't have to re-derive them. Override by editing this file *before* the Claude Code session opens; rationales are in §7.

**Three counters on the homepage, with hero/secondary treatment.** Talent is the hero number — large, prominent, live counter ("Talent Founders · 347 of 500 left · claim yours →"). Agency and Venue are smaller side tiles framed as exclusivity, not stagnation: "Founding Agencies — tightly curated. 7 of 50 admitted." and "Founding Venues — hand-picked. 3 of 50 admitted." This protects the agency/venue tiles from reading as failure during their slow fill while keeping the I1/I2/I3 moats visible.

**Caps locked at 500 / 50 / 50. Do not raise.** If 500 talent fills before Day 90, run the playbook from the source doc: open a distinct "Early Adopter" tier at 25% off for the next 500. Never extend the announced cap — that teaches the market the scarcity is fake.

**Numbered badges, with a churn-retire rule.** Badge text: "Founding Member · Seat #42 of 500" (talent), "Founding Agency · Seat #7 of 50" (agencies), "Founding Venue · Seat #3 of 50" (venues). When a Founder churns, mark their seat number `retired` in the Airtable status field — never reassign. The total cap stays at 500 forever; the badge stays a permanent identity claim. Cheap clause to put in the Founder terms.

### What the Founder Tier waitlist sprint actually builds

This is the next concrete code slice (tracked as Open Item #11 in `01_CURRENT_STATE.md`). Scope:

A new section on `personnel/index.html` — Talent counter as the hero, Agency and Venue as smaller exclusivity tiles, copy that matches the positioning triangle and the new sub-tagline (cruise omitted from public-facing language), three "Claim a seat" buttons that route to a new Founder onboarding flow. A new Airtable table (call it `Founders`) with `seat_number` (autonumber), `track` (single-select: talent/agency/venue), `status` (single-select: waitlisted/claimed/converted/retired), `email`, `name`, `claimed_at`, and an optional linked-record field to the Profiles table for use once the user converts a seat into a profile. A new serverless handler `api/founder.js` that handles two routes: `POST /api/founder` (count-then-insert claim flow — counts current claims for the requested track, rejects when the cap is reached, otherwise creates the record and returns the assigned seat number for the confirmation screen) and `GET /api/founder/counts` (returns the three current counts for the homepage display). The handler follows the existing four-handler shape: `module.exports = async function handler(req, res)`, env vars via `process.env`, no new dependencies, field-name strings hardcoded as constants at the top of the file — same per-handler pattern the existing four use, so the eventual Open Item #4 consolidation into a shared `fields.js` is mechanical.

**Known compromise on atomicity.** Airtable has no transactions, so the count-then-insert pattern in `POST /api/founder` is best-effort, not atomic. Two simultaneous claims at exactly seat #500 could both succeed and over-fill the cap by one. At the 90-day-plan target rate of ~5 claims/day the collision risk is real-world zero; it's documented as a known limitation in the handler comment and revisited only if traffic ever warrants. Do not add a separate locking table for this — it adds operational complexity disproportionate to the risk.

Out of scope for this sprint: Stripe (no payment yet — claim is just a seat reservation), magic-link login flow changes (founders use the existing claim flow once they have a profile), badge rendering on the public profile (do that in a follow-up Step 4 sprint after the seat data exists), referral bonus mechanics (cheap to add, but should ship as a second sprint once the base is stable), Agency tier on the public pricing page (held off until I1 vendor roster ops is built — see §7 decision log). Keep this first sprint *narrow* — the only goal is "the homepage counters are real, and a user can claim a seat and receive a confirmation."

### Guardrails learned from past lifetime-deal failures

The acquisition strategy spells these out and they're worth restating: hard cap at 500/50/50, no exceptions. Don't price the recurring tier so low that the Founder give-up is trivial — Pro at $19/mo means the lifetime grant is a meaningful gift, Pro at $5/mo and the business has been given away. Don't promise features that haven't been scoped — "priority feature requests" ≠ "we'll build whatever you ask"; keep a public roadmap. One badge class, ever. Never run the offer on AppSumo or a deal site — those audiences churn at 70% and pollute the founder community.

---

## 5. The 90-day plan — Terry's columns

The full week-by-week is in `strategy/sl365-customer-acquisition-strategy.html`. The condensed version, oriented around the work Terry will actually do, is below. Targets are aspirational; kill rules in §6 are how to know if a play is failing.

**Week 1 — Foundation.** Ship the Founder Tier landing page and the rolodex export. Set up Plausible or PostHog for analytics. Export TAD Shows contacts into a 400-row sheet covering every contracted entertainer, every cruise line entertainment director, every past booker, every venue Terry's worked with. Stand up LinkedIn Sales Navigator + Loom + Calendly + an email outreach tool. Draft five email templates: TAD talent, cruise line EDs, agency owners, casino buyers, wedding planners. *Goal: infrastructure ready. 0 signups yet.*

**Week 2 — TAD migration blitz (supply).** Ghost-build the first 25 TAD entertainer profiles in SL365. Send personal migration emails: "Your profile is already live — claim it here. Founding Member seat #X is yours, free for life." Post the Founder Tier launch on Terry's LinkedIn and TAD Shows social channels. Email the TAD client list with a save-the-date for the Booker Hub launch in Week 4. *Goal: 25 Talent Founder seats claimed.*

**Week 3 — Direct outreach opens (demand).** Send personal Looms to 20 cruise-line entertainment directors from Terry's warm list. Launch LinkedIn Sales Navigator outreach: 50 InMails to entertainment / event / F&B directors at AZ casinos and resorts. Identify and research the top 50 US booking agencies; draft the Agency Founder pitch. Publish the first two blog posts. *Goal: 10 cruise demos booked, 3 casino EDs engaged, 5 agency owners in conversations.*

**Week 4 — Venue concierge push (demand).** Terry personally visits or calls 15 Phoenix/Scottsdale venues. Pitches the free Booker Hub build-out. Build five Booker Hubs end-to-end for early committers. Run a cruise line demo every weekday. Publish blog post #3. *Goal: 5 Venue Founder seats claimed, 2 cruise line pilots committed.*

**Weeks 5–6 — Community gift-drop (supply).** Terry joins the 10 target Facebook / Reddit / Discord communities. Posts value daily for two weeks before pitching anything (the Lenny Rachitsky / Airbnb rule — earn the channel first). Launch the "Top 100 Missing Acts" outreach campaign (a VA at $15/hr sends Looms and emails to 100 high-fit bands not yet on SL365). First Founder Spotlight newsletter featuring the first 5 Talent Founders. *Goal: 75 Talent Founders, 10 Venue Founders, 2 Agency Founders.*

**Weeks 7–8 — Content engine ignition.** Publish 5 more blog posts (build a 30-day stockpile). Pitch 10 podcasts; record 3 appearances. First paid experiments launch — Google Search ads on competitor terms ($150 test), Reddit promoted post in r/weddingindustry ($100 test). Reddit AMA goes live. Launch band-refers-band referral mechanic in the app. *Goal: 1,000 unique landing-page visitors, 150 Talent Founders, 10 bookings completed.*

**Weeks 9–10 — Agency raid.** Personal calls or emails to the top 20 US booking agencies. Run an Agency Founder onboarding webinar (Zoom, 30 min, recorded for evergreen use). First agency end-to-end onboarded: roster imported via CSV, commission tracking turned on, team inbox configured. Publish case study #1 (TAD on SL365). *Goal: 3 Agency Founders signed, 10 agencies in active pipeline.*

**Weeks 11–12 — Double down + first case studies.** Identify the 1–2 channels with cheapest CAC; 3× the spend on those. Kill the rest. Publish 2 more case studies (cruise line pilot + first Phoenix venue booking). Internal referral leaderboard published. PR push to BizBash, Cruise Industry News, Special Events. Sign up to attend Pollstar Live (Feb) and the Phoenix MPI chapter. *Day-91 target state: 250 Talent Founders, 5 Agency Founders, 10 Venue Founders, 20 completed bookings, 5 case studies, $5–$10K in GMV, clear winning channels identified.*

**Budget allocation across the 90 days.** $500–$800/mo in Months 1–3, scaling to $1.5K–$2K/mo in Months 4–6. The biggest line item is direct-outreach tools (LinkedIn Sales Navigator $120, email warm-up $60, Loom $15, Calendly $12) — that's the engine, not paid ads. Paid Google Search on competitor terms and Meta retargeting are amplifiers ($100–$200 each). Content tools (Ahrefs lite or Ubersuggest) and a newsletter tool (ConvertKit) round it out. Buffer of $50–$350 for opportunistic experiments — Reddit promoted posts, Discord sponsorships, podcast guesting. **Don't spend on:** full trade-show booths, big PR retainers, influencer agencies, brand-awareness display ads, or a generic "growth hacker" hire. At $2K/mo Terry *is* the growth hacker.

---

## 6. Metrics and kill rules

The acquisition strategy is built on a small set of metrics that distinguish progress from activity. Vanity metrics to ignore: total signups (can include ghosts), website traffic, social followers, email open rates in isolation. The list below is what gets watched.

**Activation rate.** Target: 60%+ of signups complete profile or post first gig within 7 days. Below 40% and the onboarding is broken, not the acquisition — no amount of traffic fixes a leaky funnel.

**Marketplace liquidity.** Target: 70%+ of inquiries receive ≥2 quotes within 24 hours. The single most important marketplace metric. Below 50% and supply-demand are out of sync; more marketing makes it worse, not better.

**Time-to-first-booking (TTFB).** Target: <21 days from booker signup to completed first booking. Long TTFB signals matching is too slow; shorten it by improving matching speed, not by acquiring more bookers.

**Repeat booker rate (90-day).** Target: 35%+ book again within 90 days. Below 20% the product is transactional (bad); above 35% it's a habit (good).

**CAC per channel.** Target: <$50/signup for supply, <$150/signup for demand. Kill any channel where CAC > 3× expected LTV after 30 days of testing. Be ruthless — beloved-but-broken channels eat 6 months of budget if you let them.

**Founder Tier fill velocity.** Target: ≥5 seats claimed/day in the first 30 days, ≥3/day in days 31–90. This is the viral-signal canary. If it's not moving, the offer isn't landing — change the message or the channel before the cap closes naturally.

**Net Take Rate (NTR).** Target: 6–10% of GMV. Booking fees collected ÷ total booking volume. Don't squeeze above 12% (GigSalad level) — price-sensitive bookers will leave. Keep it transparent.

**Referral ratio.** Target: 0.3+ referrals per active user by Month 6. A ratio above 1.0 is pure organic growth. Below 0.15 means the product isn't shareable enough — fix the incentive mechanics.

**Kill rules.** Cut any paid channel with conversion <1% after $500 spent. Cut any channel with CAC > $100/signup after 30 days. Cut any tactic taking >10 hrs/week of Terry's time and producing fewer than 5 direct signups/week. Remove referral credit from any Founder community member who refers spam. Never pay for "brand awareness" without a trackable link. Drop any podcast feed that doesn't deliver ≥3 signups within 14 days.

**Weekly review ritual.** Every Monday, 9 AM, one-page dashboard: Founder Tier seats filled, CAC per channel, activation rate, liquidity, top 3 wins, top 3 losses. 30 minutes. Any metric off-target two weeks in a row triggers a tactical change, not a strategic one — don't pivot strategy based on weekly data.

The cardinal rule: **don't confuse activity with progress.** 50 cold emails feels productive. Zero demos booked says otherwise. Measure the output metric, not the input metric.

---

## 7. Decision log — Founder Tier (confirmed 2026-04-25)

The seven product decisions below were locked in a strategy session on 2026-04-25. They drive the spec for Open Item #11 (Founder Tier waitlist + landing page sprint). To change any of them, edit this file *before* the next coding session opens — the spec, the schema, and the landing-page copy all flow from here.

**1. Counter format — three counters, hero/secondary treatment.** Talent counter is the homepage hero (large, prominent, live number). Agency and Venue are smaller side tiles framed as exclusivity ("Founding Agencies — tightly curated. 7 of 50 admitted."). Rationale: equal-weighted tiles would make the slow-filling agency/venue counters look stagnant by Month 2. Hero/secondary treatment turns slow fill into a feature ("we admit selectively") rather than a bug.

**2. Caps locked at 500 / 50 / 50.** Do not raise the talent cap to 800 even if it fills hot. If the cap fills before Day 90, open a distinct "Early Adopter" tier at 25% off for the next 500 — never extend the announced cap. Rationale: extending teaches the market that scarcity is fake, and the source doc's #1 LTD-failure mode is over-selling. Agency 50 and Venue 50 stay; the leverage on agencies is the rosters they bring (50 agencies × ~50 talent each = 2,500+ rostered acts), not the seats themselves.

**3. Numbered badges with churn-retire rule.** Badge text: "Founding Member · Seat #42 of 500" (talent), "Founding Agency · Seat #7 of 50", "Founding Venue · Seat #3 of 50". When a Founder churns, the seat number is marked `retired` in Airtable and never reassigned. Rationale: numbered is the source-doc viral mechanic (shareable seat-claim graphic — "I just became Founding Member #42"). Retire-on-churn keeps the cap permanent and prevents ghost-seat accounting.

**4. Talent Founder perks — defer the 2% promise, add a ships-now perk.** Confirmed perk list: (a) lifetime Pro features, (b) Founding Member numbered badge, (c) early-access vote on new features, (d) **guaranteed inclusion in SL365's first booker-outreach campaigns** — the demand-side activity in Weeks 3–8 of the 90-day plan (cruise EDs, casino EDs, ILEA chapter speaks). This is the perk that pays from Day 1 with zero engineering cost. (e) **When SL365 platform payments go live, founder booking fee is 2% (vs 3% for non-Founders) — locked for life.** Worded as a deferred, conditional promise so it doesn't read as a paper IOU. (f) Extra Founder months per referral. Rationale: the original 2%-vs-3% promise depends on Stripe shipping (Open Item #3); if billing takes 8 months, founders are sitting on an unfulfilled promise. The booker-outreach perk delivers economic value immediately.

**5. Airtable Founders table — new table, new env var, race-condition acknowledged.** New table `Founders` in the existing base (`AIRTABLE_BASE_ID`). Schema: `seat_number` (autonumber), `track` (single-select talent/agency/venue), `status` (single-select waitlisted/claimed/converted/retired), `email`, `name`, `claimed_at`, optional linked record to Profiles. New env var `AIRTABLE_FOUNDERS_TABLE_ID` with a hardcoded fallback default in `api/founder.js` consistent with the existing four-handler pattern. The count-then-insert claim flow is best-effort, not atomic — at the target rate of ~5 claims/day the collision risk is negligible; documented as a known limitation in the handler comment. Do not add a separate locking table.

**6. Agency tier — held off the public pricing page entirely.** No "Coming soon" placeholder, no public CTA. Rationale: pre-announcing a tier whose features (I1 vendor roster ops) don't exist yet invites questions that don't have answers anchored to working code. The Agency Founder offer is delivered through Terry's direct outreach only — where he can describe the future product accurately and close the deal in real time. Add Agency tier to public pricing once I1 ships, not before. Public pricing page stays at Starter (free) / Pro ($19/mo) / Premium ($49/mo) for now.

**7. Homepage tagline — H1 and sub-tagline both locked.** H1: "Serious bookings, not bidding wars." Sub-tagline: "The booking platform built for casino, corporate, and venue residency — where talent, agencies, and venues work together, not against each other." Rationale: H1 is the strongest counter-positioning line in the source doc. Sub-tagline names the chain (talent / agencies / venues) and the segments (casino / corporate / venue residency). **Cruise is intentionally omitted from the homepage H1, sub-tagline, positioning triangle, and Founder Tier section copy** — those four surfaces define SL365's outward identity, which is a standalone marketplace, not a TAD/cruise extension. Body copy elsewhere on the marketing and app pages — feature lists, testimonials, venue-type taxonomy, sample profiles — may name cruise as one of several buyer segments alongside casino, corporate, and venue. That's accurate to who SL365 actively serves and is not the same as making cruise the brand identity. Cruise remains a major internal go-to-market lever (TAD's cruise rolodex is the engine of the 90-day plan). Do not A/B alternative H1s at launch; one focused message in Month 1, A/B in Months 4–6 once there's traffic to learn from.

**Implementation cross-cuts (also confirmed 2026-04-25):**

- `api/founder.js` ships with field-name constants hardcoded **at the top of the file** (per-handler precedent), matching the pattern the existing four handlers use. Open Item #4's cross-handler `fields.js` consolidation is *not* part of the Founder sprint — it stays as its own Open Item to avoid mixing concerns. When that consolidation eventually runs, it just imports the existing per-handler constants.
- The talent-Founder "first booker-outreach inclusion" perk has no code surface — it's a written commitment Terry honours operationally during Weeks 3–8 of the 90-day plan.

---

## Appendix — source artifacts

The full source materials, in `strategy/`:

- `strategy/gigsalad-competitive-analysis.html` — the competitive deep-forensic brief. Feature scorecard, pricing decoded, booking flow, 12-Steal / 10-Improve / 7-Skip table, competitive map (The Bash, AGNT, ShowBird, Thumbtack, Bark, Bandzoogle), payout-timing details, search-ranking algorithm, Top Performer formula. Prepared 2026-04-22.
- `strategy/sl365-customer-acquisition-strategy.html` — the go-to-market playbook. Six pillars, supply-side 9 plays, demand-side 10 plays, Founder Tier offer engine, $500–$2K/mo budget allocation, 90-day week-by-week plan, metrics & kill rules. Prepared 2026-04-22.
- `strategy/GigSalad Teardown.html` — the visual companion artifact (interactive). Same intelligence as the competitive analysis, presented as a forensic dossier UI. Prepared 2026-04-22.
- `strategy/StageLink365-Pitch-Deck.html` and `strategy/StageLink365-Pitch-Deck.pptx` — earlier pitch deck (2026-04-06). Predates the GigSalad work; useful for the broader vision narrative but supersedes nothing in this file.

If a source doc and this file disagree, **this file wins** for product strategy decisions; the source docs are the *evidence base*, this is the synthesised plan against the actual code state.

---

*Maintenance: bump the version and update this file whenever a strategic decision changes. Major rewrite if a moat is added or removed; minor revision (v1.x → v1.x+1) for tactical updates. Append a one-line note at the bottom of this section noting what changed and when.*

*Change log:*

- *v1.2 (2026-04-25) — Narrowed the cruise-omission commitment from the broad "public-facing copy" framing to a scoped commitment naming the four enforced surfaces (homepage H1, sub-tagline, positioning triangle, Founder Tier section). Edits in §1 "Note on segments" parenthetical and §7 decision #7 explicitly permit cruise to appear in body copy — feature lists, testimonials, venue-type taxonomy, sample profiles — as one of several buyer segments alongside casino, corporate, and venue. Resolves Open Item #13 (the inconsistency between v1.1's broad claim and the legacy cruise references in `personnel/index.html` body copy and `index.html` sample data). Brand-identity intent is preserved: the four surfaces that define SL365's outward identity are cruise-free post-Open-Item-#11; body-copy mentions of cruise as a buyer segment do not contradict that identity.*
- *v1.1 (2026-04-25) — Seven Founder Tier decisions confirmed and locked (§7 reframed as a decision log, not a "to confirm" list). Hero/secondary counter treatment added to §4 mechanic. Talent Founder perks revised: 2% booking fee deferred to "when payments go live" wording; new "guaranteed booker-outreach inclusion" perk that ships from Day 1. Churn-retire rule added for numbered badges. Airtable race-condition compromise documented in §4. Cruise removed from the public homepage sub-tagline; an explicit note added that cruise remains an internal go-to-market lever but not part of SL365's outward identity. Agency tier confirmed held off the public pricing page entirely (was previously "Coming soon" placeholder). `api/founder.js` confirmed to ship with per-handler field constants, not the cross-handler `fields.js` refactor (kept as separate Open Item #4).*
- *v1.0 (2026-04-25) — initial synthesis from `strategy/gigsalad-competitive-analysis.html`, `strategy/sl365-customer-acquisition-strategy.html`, and `strategy/GigSalad Teardown.html`. Three default decisions baked in (three counters, 500/50/50 caps, numbered badges) — flagged in §7 for Terry sign-off.*
