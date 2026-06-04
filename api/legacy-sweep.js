// api/legacy-sweep.js
//
// StageLink365 — Legacy GCal Sweep (one-off, guarded).
//
// A deliberately narrow, single-calendar cleanup tool for Open Item #20 (C).
//
// THE PROBLEM. Before the in-repo Phase C outbound push (`pushToGoogle` in
// api/calendar-sync.js, which writes reconciling `SL365 — …` events), an
// external legacy Cowork task (`stagelink-gcal-sync`, NOT this repo) wrote
// `CONFIRMED — Show @ Venue` events onto the 5 TAD-staff Google calendars. That
// task only ever CREATED events and never reconciled, so date changes orphaned
// the old event and the calendars accumulated hundreds of stale `CONFIRMED —`
// rows. The in-repo inbound Google connector then re-ingests those stale events
// into the hub. Once a calendar's Phase C push is live, those legacy events are
// pure noise to be removed — leaving only the reconciling `SL365 — …` events.
//
// WHAT THIS DOES. For ONE explicitly-named calendar, it lists today-forward
// events via the existing service account and deletes ONLY events that match
// BOTH legacy signatures:
//   1. summary begins `CONFIRMED —` (GCAL_CONFIRMED_RE), AND
//   2. description contains the legacy sync's signature line
//      ("automatically created by StageLink365 calendar sync").
// It REFUSES to touch anything whose summary starts `SL365` (our own outbound
// events) or anything lacking the description signature. History is left alone
// (today-forward only). Deletes are idempotent (404/410 tolerated).
//
// PACING. A long tour can be hundreds of events — more than the 60s Vercel wall
// allows to delete serially. So deletes run in small parallel batches and the
// run self-stops a few seconds before the wall, returning a JSON summary with
// `deletedCount` + `remaining` (and `stoppedEarly:true`) rather than a bare 504.
// Because the sweep is idempotent, the caller just re-runs the same ?apply=1 URL
// until `remaining` is 0 (or a final dry-run shows `matchedCount: 0`).
//
// SAFETY MODEL (mirrors the deletion-safety discipline of pushToGoogle):
//   * Dry-run by DEFAULT. A real delete requires an explicit `?apply=1`.
//   * `calendarId` is REQUIRED and explicit — there is no "all" / default; the
//     sweep is run per-calendar, only on a calendar whose Phase C push is live.
//   * Double-signature filter — both conditions must hold; a single signature
//     never qualifies a row for deletion.
//   * The `SL365` summary prefix is an absolute exclusion (never delete our own).
//   * today-forward only — past events (history) are never enumerated.
//
// TRIGGER. GET (or POST) /api/legacy-sweep?calendarId=<id>[&apply=1]. Requests
// must carry the cron secret — `Authorization: Bearer <CRON_SECRET>` or
// `?key=<CRON_SECRET>` — the same gate as api/calendar-sync.js. Reuses
// GOOGLE_SERVICE_ACCOUNT_KEY (the same service account already used by the
// calendar sync); the SA must have "Make changes to events" on the calendar for
// a real delete to succeed (read-only sharing yields 403s, surfaced per event).
//
// Self-contained per the per-handler repo convention (api/founder.js,
// api/calendar-sync.js) — the few Google helpers are intentionally duplicated.

const crypto = require('crypto'); // Node built-in — signs the Google service-account JWT.

// --- The two legacy signatures (both required) ------------------------------
// "CONFIRMED — Show @ Venue" — em dash, en dash, or hyphen, leading space ok.
const GCAL_CONFIRMED_RE = /^\s*CONFIRMED\s*[—–-]/i;
// Our own outbound events — never delete these (absolute exclusion).
const GCAL_OWN_ECHO_RE  = /^\s*SL365\b/i;
// The legacy sync stamps every event's description with this line. Matched
// case-insensitively as a substring; verified verbatim against real events
// 2026-06-04 ("This event was automatically created by StageLink365 calendar sync.").
const LEGACY_DESC_SIGNATURE = 'automatically created by stagelink365 calendar sync';

// --- Delete pacing ----------------------------------------------------------
// A full tour can be hundreds of events; deleting them one-by-one overruns the
// Vercel 60s function wall (FUNCTION_INVOCATION_TIMEOUT → a bare 504 with no
// feedback). So we (a) delete in small parallel batches for speed and (b) stop
// before the wall and return a JSON summary with `remaining` instead of timing
// out — the sweep is idempotent, so the caller just re-runs until matched=0.
const DELETE_CONCURRENCY = 6;        // gentle on Google's write rate limit
const SOFT_BUDGET_MS     = 50000;    // leave headroom under the 60s maxDuration

// --- Google service account (env GOOGLE_SERVICE_ACCOUNT_KEY) ----------------
const GCAL_SCOPE     = 'https://www.googleapis.com/auth/calendar.events';
const GCAL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GCAL_API       = 'https://www.googleapis.com/calendar/v3';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const { CRON_SECRET, GOOGLE_SERVICE_ACCOUNT_KEY } = process.env;
  if (!CRON_SECRET || !GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(500).json({ ok: false, error: 'server_config' });
  }

  const query = req.query || {};
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const providedKey = bearer || query.key || '';
  if (providedKey !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // calendarId is required and explicit — no default, no "all".
  const calendarId = String(query.calendarId || '').trim();
  if (!calendarId || calendarId.toLowerCase() === 'all') {
    return res.status(400).json({ ok: false, error: 'calendar_id_required' });
  }

  // Dry-run by default. A real delete must be explicitly opted into.
  const apply = query.apply === '1' || query.apply === 'true';

  const env = { gcalKey: GOOGLE_SERVICE_ACCOUNT_KEY, gcalToken: null };

  try {
    const summary = await runSweep(env, calendarId, { apply });
    return res.status(200).json(summary);
  } catch (err) {
    console.error('legacy-sweep fatal:', err);
    return res.status(500).json({
      ok: false, error: 'sweep_failed',
      detail: String((err && err.message) || err),
    });
  }
};

async function runSweep(env, calendarId, { apply }) {
  const startMs = Date.now();
  const ranAt = new Date().toISOString();
  const today = todayInPhoenix();

  const events = await listTodayForwardEvents(env, calendarId, today);

  const matched = [];
  const skipped = { ownSl365: 0, noConfirmedPrefix: 0, noSignature: 0, cancelled: 0 };

  for (const ev of events) {
    if (ev.status === 'cancelled') { skipped.cancelled++; continue; }
    const summary = (ev.summary || '').trim();
    // Absolute exclusion: never touch our own outbound events.
    if (GCAL_OWN_ECHO_RE.test(summary)) { skipped.ownSl365++; continue; }
    // Both signatures required.
    if (!GCAL_CONFIRMED_RE.test(summary)) { skipped.noConfirmedPrefix++; continue; }
    const desc = (ev.description || '').toLowerCase();
    if (!desc.includes(LEGACY_DESC_SIGNATURE)) { skipped.noSignature++; continue; }
    matched.push(ev);
  }

  const deleted = [];
  const deleteErrors = [];
  let stoppedEarly = false;
  if (apply) {
    const token = await getGoogleAccessToken(env);
    // Belt-and-suspenders: only events still passing BOTH guards are eligible.
    const eligible = matched.filter(ev => {
      const summary = (ev.summary || '').trim();
      return !GCAL_OWN_ECHO_RE.test(summary) &&
        GCAL_CONFIRMED_RE.test(summary) &&
        (ev.description || '').toLowerCase().includes(LEGACY_DESC_SIGNATURE);
    });
    // Delete in small parallel batches; stop before the function wall and hand
    // back a JSON summary (the caller re-runs the same URL to finish).
    for (let i = 0; i < eligible.length; i += DELETE_CONCURRENCY) {
      if (Date.now() - startMs > SOFT_BUDGET_MS) { stoppedEarly = true; break; }
      const batch = eligible.slice(i, i + DELETE_CONCURRENCY);
      const results = await Promise.all(batch.map(async (ev) => {
        try { await deleteEvent(env, calendarId, ev.id, token); return { ok: true, id: ev.id }; }
        catch (err) { return { ok: false, id: ev.id, detail: String((err && err.message) || err) }; }
      }));
      for (const r of results) {
        if (r.ok) deleted.push(r.id);
        else deleteErrors.push({ id: r.id, detail: r.detail });
      }
    }
  }

  const sample = matched.slice(0, 25).map(ev => ({
    id: ev.id,
    summary: (ev.summary || '').trim(),
    start: (ev.start && (ev.start.dateTime || ev.start.date)) || '',
    created: ev.created || '',
  }));

  // Events still on the calendar after this run (errored or not yet reached) —
  // a re-run of the same ?apply=1 URL clears them. 0 = sweep complete.
  const remaining = apply ? (matched.length - deleted.length) : matched.length;

  const summary = {
    ok: deleteErrors.length === 0,
    mode: apply ? 'apply' : 'dryRun',
    ranAt,
    calendarId,
    today,
    scanned: events.length,
    matchedCount: matched.length,
    skipped,
    deletedCount: deleted.length,
    stoppedEarly,
    remaining,
    deleteErrors,
    sample,
  };
  if (apply && remaining > 0) {
    summary.note = 'Re-run the same ?apply=1 URL to delete the remaining events (idempotent).';
  }
  return summary;
}

// Lists today-forward events for one calendar (GET only). Recurring events are
// expanded (singleEvents=true) — legacy events are single timed rows, so this is
// inert in practice; paginates. No timeMax: sweep ALL future legacy events.
async function listTodayForwardEvents(env, calendarId, today) {
  const token = await getGoogleAccessToken(env);
  const out = [];
  let pageToken;
  do {
    const params = new URLSearchParams();
    params.set('singleEvents', 'true');
    params.set('showDeleted', 'false');
    params.set('maxResults', '2500');
    params.set('timeMin', `${today}T00:00:00Z`);
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const resp = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Google events ${resp.status} for ${calendarId}: ${txt.slice(0, 200)}`);
    }
    const data = await resp.json();
    out.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function deleteEvent(env, calendarId, id, token) {
  const url = `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`;
  const resp = await fetchWithRetry(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404/410 = already gone — idempotent, fine.
  if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
    const txt = await resp.text();
    throw new Error(`Google delete ${resp.status}: ${txt.slice(0, 200)}`);
  }
}

// Service-account auth: sign a JWT (RS256) with Node crypto and exchange it for
// an access token. No external dependency. Cached per run on env.gcalToken.
async function getGoogleAccessToken(env) {
  if (env.gcalToken) return env.gcalToken;
  let key;
  try { key = JSON.parse(env.gcalKey); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON'); }
  if (!key.client_email || !key.private_key) {
    throw new Error('service account key missing client_email/private_key');
  }
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput =
    `${enc({ alg: 'RS256', typ: 'JWT' })}.` +
    `${enc({ iss: key.client_email, scope: GCAL_SCOPE, aud: GCAL_TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(key.private_key, 'base64url');
  const resp = await fetchWithRetry(GCAL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }).toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(`Google token ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  env.gcalToken = data.access_token;
  return env.gcalToken;
}

async function fetchWithRetry(url, opts) {
  let resp;
  for (let attempt = 1; attempt <= 3; attempt++) {
    resp = await fetch(url, opts);
    if (resp.status !== 429 && resp.status !== 503) return resp;
    if (attempt < 3) await sleep(1000 * attempt);
  }
  return resp;
}

function todayInPhoenix() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
