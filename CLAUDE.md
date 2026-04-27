# StageLink365 — CLAUDE.md

This file is read by Claude Code at the start of every session. Cowork also reads it as a pinned file. Keep it short, keep it current, keep it accurate.

## Read these files first

On every session, before writing or editing anything in this repo, read:

1. `00_STAGELINK365_BRIEF_CURRENT.md` — what this system is, how it works, where its data lives, what fragilities exist.
2. `01_CURRENT_STATE.md` — what is working today, what the open items are, what this session should *not* touch.
3. `02_STRATEGY.md` — the product strategy: positioning, the three structural moats (vendor/agency, venue Booker Hub, verification ladder), the Steal/Improve/Skip list, the Founder Tier offer engine spec, and the 90-day plan. Source artifacts live in `strategy/`.

If any of these three files are missing, stop and ask — do not guess. Those three files are the source of truth; this `CLAUDE.md` is only the ruleset.

## Scope

**In scope:** only this repo (`stagelink365-platform`). The root `index.html`, `personnel/index.html`, and the four handlers under `api/` (`auth.js`, `profile.js`, `profiles.js`, `profile-create.js`). Data lives in an Airtable base addressed via environment variables (`AIRTABLE_API_TOKEN`, `AIRTABLE_BASE_ID`, `AIRTABLE_PROFILES_TABLE_ID` — default `tblse7dXJfUjvEWQa`, `ADMIN_TOKEN`).

**Out of scope:** Cruise Avails (`cruiseavails.tadmgmt.com`), ShoreMatch, the new TAD Management website (`newsite.tadmgmt.com`), QuickBooks / QBO invoicing, and the external calendar service at `calendar.stagelink365.com` (its source is not in this repo). Do not read, reference, edit, or suggest changes to any of them from here.

## How the code is structured (quick map)

- `index.html` — the entire React 18 app in one file, ≈293 KB, compiled in the browser via Babel Standalone. **No build step. No `package.json`. No bundler.** Do not propose introducing one without explicit agreement.
- `personnel/index.html` — a separate static marketing landing page (vanilla HTML/CSS/JS, no React), with a monthly/annual pricing toggle.
- `api/*.js` — four Node-style serverless handlers with Vercel-shape signature: `module.exports = async function handler(req, res)`, pre-parsed `req.body` / `req.query`, env vars via `process.env`.

Auth is magic-link: 10-character alphanumeric tokens (regex `/^[A-Za-z0-9]{6,32}$/`) stored on each profile in the Airtable `Magic Link Token` field. The `ADMIN_TOKEN` env var is a master credential. `ADMIN_EMAILS` in `index.html` is hardcoded to `['terry@tadshows.com']`.

## Hard rules — security

- Airtable PAT, `ADMIN_TOKEN`, and the Airtable base ID are environment variables on the hosting provider. Never hardcode them into any file in this repo. Never paste real values into chat, commit them, or share them externally.
- Treat `ADMIN_EMAILS` as a production secret. Changes to that list must be deliberate.
- Never commit `.env` files, real tokens, or any other credentialed value.

## Hard rules — Airtable schema

- Every Airtable field name used by the four `api/*.js` handlers is hardcoded. Changing a field name in Airtable — without a paired code update — will silently break the live app. Renaming a `Subscription Tier` option can silently move a user into the wrong tier because the matching logic in `transformProfile()` uses fuzzy `.includes()` tests.
- The Profiles table ID default `tblse7dXJfUjvEWQa` is duplicated across all four handlers. Any table-ID change needs the env var set *and* the fallback reviewed in every handler.
- Before touching any `api/*.js` handler, list every Airtable field it reads or writes and confirm the field exists and the option names still match.

## Hard rules — magic-link tokens

- Auth is magic-link only. No passwords.
- A token is also the user's public calendar URL path (`https://calendar.stagelink365.com/c/{token}`). Rotating a token breaks the user's calendar link — never rotate without a communication plan.
- The `ADMIN_TOKEN` never appears client-side.

## Hard rules — deployment

- **Host: Vercel** (confirmed 2026-04-25). The four `api/*.js` handlers and the new `api/founder.js` use Vercel's serverless Node Functions runtime; the static files (`index.html`, `personnel/index.html`) are served from the same project. Project-level exception to `WORKFLOW_CONVENTIONS.md`'s SiteGround default.
- **Deploy trigger: push to `main` = production deploy** (Vercel GitHub App default; assumed auto-deploy until Terry confirms otherwise). The "Before pushing to `main`, ask" rule below remains binding regardless.
- **Env vars live in Vercel Project → Settings → Environment Variables**, Production scope (and Preview scope if preview deploys are used). Required: `AIRTABLE_API_TOKEN`, `AIRTABLE_BASE_ID`, `ADMIN_TOKEN`, `AIRTABLE_FOUNDERS_TABLE_ID` (= `tblwTL67NIFA2pmQG`, added 2026-04-25 for Open Item #11). Optional: `AIRTABLE_PROFILES_TABLE_ID` (fallback `tblse7dXJfUjvEWQa` is hardcoded in every handler).
- **No `package.json`, no build step.** Vercel zero-config: the `/api/*.js` files are auto-routed, the static files are served from the repo root. Do not introduce a bundler, framework, or `package.json` to make this Vercel-shape app fit a different runtime.
- **Rollback path is the Vercel *Deployments* tab → "Promote to Production"** on a previous deploy. Faster than `git revert`; one practice run worth doing before relying on it under pressure.

## How we work

The working agreement, fixed 2026-04-25 after a session reset.

- **Code edits happen here, never in the GitHub web UI.** UI edits bypass review and have shipped broken HTML to production. All edits land via Claude Code → worktree → PR.
- **Worktrees are mandatory in the Desktop app.** Each session opens at `.claude/worktrees/<name>/` on a feature branch (`claude/<name>`). The parent repo at `/Users/terrydavies/Documents/TAD-Dev/StageLink365/` stays on `main`. The Desktop app does not expose a toggle to disable this — don't try to fight it.
- **PR-gated, not direct push.** End-of-session ritual: `git push -u origin <branch>` → `gh pr create` → wait for the Vercel preview URL → Terry verifies on the preview → `gh pr merge --squash --delete-branch`. Vercel deploys `main` to production after merge. Never `git push origin <branch>:main`.
  - **Worktree merge gotcha:** `--delete-branch` fails from a worktree (gh tries to check out `main`, which the parent repo owns); use `gh pr merge --squash` then `git push origin --delete <branch>` instead.
- **One scope per session.** If the scope grows mid-session, stop and ask. Hot-patches for production breakage are the exception — flag the expansion.
- **All errors and statuses surface in the UI.** Terry doesn't read browser console or server logs.

### Start-of-session routine

1. Read `00_STAGELINK365_BRIEF_CURRENT.md`, `01_CURRENT_STATE.md`, `02_STRATEGY.md`, and this file.
2. State which open item from `01_CURRENT_STATE.md` you're on, or describe the ad-hoc scope.
3. From the parent repo, run `git pull --ff-only origin main`. Then from the worktree, run `git fetch origin main && git merge --ff-only origin/main` to base the feature branch on current `main`. If either fails, stop and ask.
4. Before writing code, state in one short paragraph what will change, where, and why.
5. Commit with an imperative subject line that names the file and the change.
6. Ask before pushing. After OK: push the branch, open the PR, wait for the preview URL, Terry verifies, then merge.
7. Append a one-line entry to `01_CURRENT_STATE.md`'s session log (local-only — that file is gitignored), bump the minor version. Don't try to commit `01_CURRENT_STATE.md`.

## Session behavior

1. At the start of every task, state which open item (from `01_CURRENT_STATE.md`) or specific scope you are working on. Do not drift into adjacent work mid-session.
2. One component per session. If the scope wants to grow, stop and ask.
3. Before producing code: state what will change, where, and why, in one short paragraph.
4. All feedback (errors, statuses, admin messages) must surface in the UI. Do not rely on browser console, dev tools, or server logs — Terry does not use them.
5. Do not propose introducing a build step, bundler, package manager, or framework (Vite, Next.js, TypeScript, etc.) to `index.html`. The in-browser Babel approach is intentional.
6. Do not propose Airtable schema changes without a paired update across every handler that references the affected fields.
7. At the end of every real work session, append a one-line entry to `01_CURRENT_STATE.md`'s session log, move any items between "working today" / "open items" / "in progress" as needed, bump the file's minor version, and commit. That update is the most important habit.

## Repo conventions

- Commit style: the upstream history is mostly "Add files via upload" (the repo is edited via GitHub UI). When committing via Claude Code, use a short imperative subject line that names the file and the change, e.g. `api/profiles.js: fix tier fuzzy-match to exact option name`.
- No lint, no test runner, no CI in this repo. If you want one, raise it as a proposed Open Item in `01_CURRENT_STATE.md` before starting.
- Before pushing to `main`, ask — deployment story isn't documented yet and a push could go live immediately depending on hosting.

## Out-of-scope deflection

If asked to work on Cruise Avails, ShoreMatch, the new TAD Management website, QBO invoicing, or the external calendar service, stop and say: "That's a separate project — switch Cowork Projects (or open a different Claude Code session in the right repo) and I'll pick it up there." Do not touch their files even if they appear on disk.
