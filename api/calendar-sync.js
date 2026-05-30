// api/calendar-sync.js
//
// StageLink365 — Calendar Sync (Phase 1).
//
// Once-daily, read-only reconciliation sync. For every StageLink Profile that
// carries source identity IDs, it reads that act's bookings from each external
// source, maps them to canonical Availability records, and reconciles the act's
// rows in the StageLink `Availability` table — so the public calendar at
// calendar.stagelink365.com/c/{token} shows one unified truth and double
// bookings get caught. Spec: strategy/calendar-sync/StageLink365-Calendar-Sync-Spec.md.
//
// HARD RULE — read-only on external bases. This handler issues GET only against
// TAD BOOKINGS and CRUISE ENGAGEMENTS. It creates/updates/deletes rows ONLY in
// the StageLink Availability table. It never writes to a TAD base, never adds
// automations to one, and never touches Cruise Avails.
//
// CONNECTOR MODEL (spec §3). Each source is a Connector: a reader, an identity
// resolver (a Profiles field holding the act's record ID in that source), a
// STATUS mapping, and a `Source` tag it exclusively owns — a connector only
// ever reconciles its own rows, which is what lets many sources share one
// calendar. Connectors are direction-aware (inbound | outbound | both). Inbound
// connectors: the two TAD sources (Land/Cruise) and the Performer Google
// Calendar (reads each performer's own calendar via a service account, gated on
// GOOGLE_SERVICE_ACCOUNT_KEY — inert until that env var is set; its rows are
// deduped by date+gig so duplicate source events can't accumulate).
//
// OUTBOUND (Phase C, the source-of-truth model — decision record §11). StageLink
// is canonical: after the inbound passes, an OUTBOUND connector pushes each
// opted-in person's canonical hub rows INTO their *own* Google calendar as
// StageLink-owned, deterministically-id'd events ("enter once → reflected
// everywhere"). Google is write-only here — never read back in this model — so
// there is no classification/dedup problem. Gated on the SAME
// GOOGLE_SERVICE_ACCOUNT_KEY (scope widened to calendar.events) AND a per-person
// `Google Push Enabled` opt-in AND a `Google Calendar ID`. We only ever touch
// events in our own `sl365…` id namespace, and a failed/empty hub read SKIPS the
// push (never wipes) — see the deletion-safety invariants on pushToGoogle().
// Outbound write-back to TAD/Cruise (Phase D) is still designed-for, not built.
//
// TRIGGER. A Vercel cron (see vercel.json) GETs this route once daily. Requests
// must carry the cron secret — `Authorization: Bearer <CRON_SECRET>` (what
// Vercel cron sends) or `?key=<CRON_SECRET>`. `?dryRun=1` computes the full
// plan and returns it WITHOUT writing — used to verify on preview deploys.
//
// Field-name / field-id constants are hardcoded at the top, per the existing
// per-handler precedent (api/founder.js). Base IDs are env vars per CLAUDE.md.

const crypto = require('crypto'); // Node built-in (NOT a dependency) — signs the Google service-account JWT.

const AIRTABLE_API = 'https://api.airtable.com/v0';

// --- StageLink hub: the ONLY base this sync writes to (env AIRTABLE_BASE_ID) ---
const PROFILES_TABLE     = 'tblse7dXJfUjvEWQa';
const AVAILABILITY_TABLE = 'tblxJ9U0Anai6911A';

// Hub fields are referenced by NAME (repo convention — CLAUDE.md schema rules).
const PROFILE_F = {
  displayName:     'Display Name',
  cruiseActId:     'Cruise Act ID',
  landActId:       'Land Act ID',
  googleCalendarId:'Google Calendar ID', // performer's GCal id, read by the Google connector
  pushEnabled:     'Google Push Enabled', // opt-in: push canonical hub rows INTO this GCal (Phase C)
  availability:    'Availability',   // inverse link → this act's Availability rows
};
const AVAIL_F = {
  recordLabel:   'Record Label',
  profile:       'Profile',
  startDate:     'Start Date',
  endDate:       'End Date',
  type:          'Availability Type',
  source:        'Source',
  division:      'Division',
  updatedBy:     'Updated By',
  engagementRef: 'Engagement Reference',
  venue:         'Cruise Line / Venue',
};

// Canonical Availability vocabulary (spec §4) — existing singleSelect options.
const TYPE_BOOKED      = 'Booked';
const TYPE_UNAVAILABLE = 'Unavailable';
const DIVISION_LAND    = 'Land';
const DIVISION_CRUISE  = 'Cruise';
const DIVISION_PERSONAL = 'Personal';
const SOURCE_LAND      = 'Land Engagement Sync';
const SOURCE_CRUISE    = 'Cruise Engagement Sync';
const SOURCE_GCAL      = 'Google Calendar Sync';   // owns the per-performer Google rows
const UPDATED_BY       = 'System — Calendar Sync';

// --- Performer Google Calendar connector (env GOOGLE_SERVICE_ACCOUNT_KEY) ---
// A Google service account (shared into each performer's calendar) reads events
// inbound, and — for opted-in profiles — writes StageLink-owned events outbound
// (Phase C). One key, one access token per run, serves both directions.
// Scope is calendar.events (read + write on events); the broader scope still
// satisfies the inbound read. Outbound stays inert per calendar until the person
// shares it at "Make changes to events" AND ticks `Google Push Enabled`.
const GCAL_SCOPE      = 'https://www.googleapis.com/auth/calendar.events';
const GCAL_TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const GCAL_API        = 'https://www.googleapis.com/calendar/v3';
const GCAL_HORIZON_MONTHS = 24;
// An all-day event whose summary contains one of these (as a WHOLE WORD, so
// "OFF" doesn't trip on "Coffee"/"Office") = an availability block.
const GCAL_BLOCK_RE = /\b(CRUISE|BLOCK|UNAVAILABLE|HOLD|VACATION|TRAVEL|OUT OF TOWN|OFF|LEAVE|PERSONAL)\b/i;
// "CONFIRMED — Show @ Venue" = a real TAD booking pushed to the calendar → Booked.
const GCAL_CONFIRMED_RE = /^\s*CONFIRMED\s*[—–-]/i;
// StageLink's own outbound writes — never re-ingest inbound (loop prevention).
const GCAL_OWN_ECHO_RE  = /^\s*SL365\b/i;

// --- Outbound push (Phase C): hub → the person's own Google calendar ---
// Every pushed event lives in this id namespace and carries this summary prefix
// + an extendedProperty, so the push is an idempotent upsert and deletion is
// provably scoped to events WE authored (deletion-safety invariants on
// pushToGoogle()). The prefix chars 's','l','3','6','5' are all valid Google
// event-id chars (lowercase a–v + digits 0–9, the base32hex alphabet).
const SL365_ID_PREFIX      = 'sl365';
const SL365_SUMMARY_PREFIX = 'SL365 — ';
const SL365_SOURCE_TAG     = 'stagelink'; // extendedProperties.private.source — second ownership guard
// Decision §11.8 Q2: push only hard commitments; Hold stays a StageLink-internal soft flag.
const GCAL_PUSH_TYPES = new Set([TYPE_BOOKED, TYPE_UNAVAILABLE]);
// Decision §11.8 Q5: never echo a calendar's own data back at it. Rows that
// ORIGINATED from a Google calendar are excluded from the push. Covers both the
// current connector tag and the legacy `Google Cal Sync` option still in the base.
const GCAL_ORIGIN_SOURCES = new Set([SOURCE_GCAL, 'Google Cal Sync']);
// Decision §11.8 Q4: encode type via Google colorId, mirroring the hub's own
// colours (Booked green, Unavailable red) — plus the mandatory summary prefix.
const GCAL_COLOR_BY_TYPE = { [TYPE_BOOKED]: '2', [TYPE_UNAVAILABLE]: '11' };

// --- Land source: TAD BOOKINGS base (env TAD_BOOKINGS_BASE_ID), read-only ---
// Identity resolves act -> bookings via the act record's inverse-link field, so
// the match is by record ID (exact) — never by fuzzy name.
const LAND_ACT_TABLE    = 'tblOsZIDmFHt01rJn';   // BANDS-SHOWS
const LAND_ACT_INVERSE  = 'fldUqdkBqAj0cDqL0';   // -> CURRENT EVENTS record IDs
const LAND_TABLE        = 'tblu9UIlpXChPdvOB';   // CURRENT EVENTS
const LAND_FID = {
  startDate: 'fld0VBiok50LzeKRZ',
  endDate:   'fld8BKQ10PP9q3JXw',
  status:    'fldFJNJLucJRWEVBB',
  venue:     'fldol7YSyU8aZtXz0',   // formula -> linked venue name (string)
};

// --- Cruise source: CRUISE ENGAGEMENTS base (env CRUISE_ENGAGEMENTS_BASE_ID) ---
const CRUISE_ACT_TABLE   = 'tblyprpkQPGAsFz9M';  // ACTS
const CRUISE_ACT_INVERSE = 'fldC40a2KaSJrUgsO';  // -> ENGAGEMENTS record IDs
const CRUISE_TABLE       = 'tbl4fM83A4lecUsOK';  // ENGAGEMENTS
const CRUISE_FID = {
  dateFrom:   'fld3ubYPBEOMabtYH',
  dateTo:     'fldgBJLcQVkOaaCNo',
  status:     'fldMs85bDLV5PMisH',
  cruiseLine: 'fldDU92PhPn5oBQkU',
  ship:       'fld6LDUvh8E1cCerv',
};

// STATUS mappings (spec §6). Only booking-producing statuses are enumerated;
// everything in the matching SKIP set is intentionally ignored. A status in
// neither set is genuinely unrecognised and is surfaced in the run summary so a
// human can classify it — the safe failure mode is "don't fabricate a booking".
const LAND_BOOKED   = new Set(['Confirmed', 'CONFIRMED - PLEASE CONFIRM WITH BAND', 'Complete']);
const LAND_BLOCKED  = new Set(['BLOCKED', 'TRAVEL DAY']);
const LAND_SKIP     = new Set([
  'PENDING - PLEASE HOLD', 'Pending', 'ROUTING DATE', 'Rescheduling Date',
  'Canceled', 'Cancelled with Expenses', 'CRUISE', 'WORKING DOC', 'FanGenie Only',
]);
// `Soft Hold (<person>)` is an open-ended family of options — matched by prefix.
const isLandSkip = (s) => s.startsWith('Soft Hold') || LAND_SKIP.has(s);

const CRUISE_BOOKED  = new Set(['Confirmed', 'Changed/Confirmed', 'Completed']);
const CRUISE_BLOCKED = new Set(['Not Available']);
const CRUISE_LAND_DATE = 'Land Date';
const CRUISE_SKIP    = new Set([
  'AVAILABLE', 'HOME BASE', 'Offered', 'Pending',
  'Cancelled', 'Canceled With Pay', 'Warners', 'EX ROSTER - COMMISSIONS',
]);

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const {
    AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID,
    TAD_BOOKINGS_BASE_ID, CRUISE_ENGAGEMENTS_BASE_ID, CRON_SECRET,
  } = process.env;
  // Optional read-only PAT for the two external TAD bases. A separate token
  // keeps the main StageLink PAT scoped to the StageLink base; falls back to it.
  const TAD_TOKEN = process.env.TAD_AIRTABLE_API_TOKEN || AIRTABLE_API_TOKEN;

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID ||
      !TAD_BOOKINGS_BASE_ID || !CRUISE_ENGAGEMENTS_BASE_ID || !CRON_SECRET) {
    return res.status(500).json({ ok: false, error: 'server_config' });
  }

  const query = req.query || {};
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const providedKey = bearer || query.key || '';
  if (providedKey !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const dryRun = query.dryRun === '1' || query.dryRun === 'true';
  const env = {
    hubToken:   AIRTABLE_API_TOKEN,
    hubBase:    AIRTABLE_BASE_ID,
    tadToken:   TAD_TOKEN,
    landBase:   TAD_BOOKINGS_BASE_ID,
    cruiseBase: CRUISE_ENGAGEMENTS_BASE_ID,
    // Optional — the Google connector is skipped entirely if this is absent, so
    // the TAD sync keeps working before Google is wired up.
    gcalKey:    process.env.GOOGLE_SERVICE_ACCOUNT_KEY || null,
    gcalToken:  null, // cached access token for this run (set on first use)
  };

  try {
    const summary = await runSync(env, { dryRun });
    return res.status(200).json(summary);
  } catch (err) {
    console.error('calendar-sync fatal:', err);
    return res.status(500).json({
      ok: false, error: 'sync_failed',
      detail: String((err && err.message) || err),
    });
  }
};

async function runSync(env, { dryRun }) {
  const ranAt = new Date().toISOString();
  const today = todayInPhoenix();
  const connectors = buildConnectors();

  const profiles = await listSyncableProfiles(env);

  const acts = [];
  const totals = { created: 0, updated: 0, deleted: 0 };
  const unrecognizedStatuses = {};
  const errors = [];

  for (const profile of profiles) {
    const actSummary = { profileId: profile.id, name: profile.name, connectors: {}, conflicts: [] };
    try {
      const existingRows = await fetchActAvailability(env, profile);

      // Land connector is processed before Cruise so the cruise connector's
      // "Land Date" de-dup (decision Q2) can see the land-connector dates.
      const landIntervals = [];
      const candidatesByConnector = {};

      for (const connector of connectors) {
        if (connector.direction !== 'inbound' && connector.direction !== 'both') continue;
        // The Google connector is inert until GOOGLE_SERVICE_ACCOUNT_KEY is set.
        if (connector.requiresGcalKey && !env.gcalKey) continue;
        const actId = profile[connector.identityKey];
        if (!actId) continue;

        const rawRecords = await connector.read(env, actId);
        const ctx = { profile, today, landIntervals, unrecognizedStatuses };
        const candidates = [];
        for (const rec of rawRecords) {
          const mapped = connector.map(rec, ctx);
          if (!mapped) continue;
          mapped.sourceTag = connector.sourceTag;
          candidates.push(mapped);
          if (connector.id === 'land-engagements' && mapped.type === TYPE_BOOKED) {
            landIntervals.push({ start: mapped.startDate, end: mapped.endDate });
          }
        }
        candidatesByConnector[connector.id] = { connector, candidates, rawCount: rawRecords.length };
      }

      for (const cid of Object.keys(candidatesByConnector)) {
        const { connector, candidates, rawCount } = candidatesByConnector[cid];
        // Some connectors (Google) can see duplicate source events; collapse to
        // one canonical row per commitment before reconciling so duplication
        // can never accumulate in the hub.
        const cands = connector.dedupe ? connector.dedupe(candidates) : candidates;
        const existing = existingRows.filter(r => r.source === connector.sourceTag);
        const plan = reconcile(cands, existing, profile);
        if (!dryRun) await applyPlan(env, plan);
        totals.created += plan.create.length;
        totals.updated += plan.update.length;
        totals.deleted += plan.delete.length;
        const summary = {
          rawRows: rawCount,
          classified: candidates.length,
          deduped: cands.length,
          created: plan.create.length,
          updated: plan.update.length,
          deleted: plan.delete.length,
        };
        // On a dry run, attach a sample so a human can eyeball the classification
        // before any write — especially for Google, to confirm what's really in
        // the calendars (e.g. whether duplicate events live there).
        if (dryRun && connector.dedupe) {
          summary.sample = cands.slice(0, 15).map(c => ({ start: c.startDate, end: c.endDate, type: c.type, label: c.label }));
        }
        actSummary.connectors[connector.id] = summary;
      }

      actSummary.conflicts = detectConflicts(candidatesByConnector);

      // --- OUTBOUND pass (Phase C). Runs after inbound, reusing existingRows —
      // the hub rows we already read for this act. Because a failed hub read
      // throws above (into the catch) before we reach here, by this point
      // existingRows is guaranteed to be a SUCCESSFUL read — so an empty array
      // here means "genuinely no commitments", not "couldn't read" (invariant 3).
      // Using existingRows (run-start hub state) — not this run's freshly-applied
      // inbound writes — makes the dry-run plan identical to the real-run plan.
      for (const connector of connectors) {
        if (connector.direction !== 'outbound' && connector.direction !== 'both') continue;
        if (connector.requiresGcalKey && !env.gcalKey) continue;
        if (connector.optInKey && !profile[connector.optInKey]) continue;
        if (connector.identityKey && !profile[connector.identityKey]) continue;
        try {
          const plan = await connector.push(env, profile, existingRows, { today, dryRun });
          totals.created += plan.create.length;
          totals.updated += plan.update.length;
          totals.deleted += plan.delete.length;
          const psummary = {
            desired: plan.desiredCount,
            created: plan.create.length,
            updated: plan.update.length,
            deleted: plan.delete.length,
          };
          if (dryRun) {
            psummary.sample = [...plan.create, ...plan.update].slice(0, 15).map(ev => ({
              id: ev.id, summary: ev.summary, start: ev.start.date, end: ev.end.date, colorId: ev.colorId,
            }));
            psummary.deleteSample = plan.delete.slice(0, 15);
          }
          actSummary.connectors[connector.id] = psummary;
        } catch (err) {
          console.error(`calendar-sync push ${profile.id} (${profile.name}):`, err);
          errors.push({ profileId: profile.id, name: profile.name, phase: 'outbound', detail: String((err && err.message) || err) });
        }
      }
    } catch (err) {
      console.error(`calendar-sync act ${profile.id} (${profile.name}):`, err);
      errors.push({ profileId: profile.id, name: profile.name, detail: String((err && err.message) || err) });
    }
    acts.push(actSummary);
  }

  return {
    ok: errors.length === 0,
    dryRun, ranAt,
    actCount: profiles.length,
    totals,
    conflictCount: acts.reduce((n, a) => n + a.conflicts.length, 0),
    unrecognizedStatuses,
    acts,
    errors,
  };
}

// The source registry (spec §3.1). Adding a source = adding a connector here.
function buildConnectors() {
  return [
    {
      id: 'land-engagements',
      name: 'Land Engagements',
      direction: 'inbound',
      sourceTag: SOURCE_LAND,
      identityKey: 'landActId',
      read: (env, actId) => readSourceBookings({
        token: env.tadToken, base: env.landBase,
        actTable: LAND_ACT_TABLE, actRecordId: actId, inverseLink: LAND_ACT_INVERSE,
        bookingTable: LAND_TABLE, bookingFields: Object.values(LAND_FID),
      }),
      map: mapLand,
    },
    {
      id: 'cruise-engagements',
      name: 'Cruise Engagements',
      direction: 'inbound',
      sourceTag: SOURCE_CRUISE,
      identityKey: 'cruiseActId',
      read: (env, actId) => readSourceBookings({
        token: env.tadToken, base: env.cruiseBase,
        actTable: CRUISE_ACT_TABLE, actRecordId: actId, inverseLink: CRUISE_ACT_INVERSE,
        bookingTable: CRUISE_TABLE, bookingFields: Object.values(CRUISE_FID),
      }),
      map: mapCruise,
    },
    {
      id: 'performer-google-calendar',
      name: 'Performer Google Calendar',
      direction: 'inbound',
      sourceTag: SOURCE_GCAL,
      identityKey: 'googleCalendarId',
      requiresGcalKey: true,
      read: (env, calId) => readGoogleCalendar(env, calId),
      map: mapGoogle,
      dedupe: dedupeGoogle,
    },
    {
      // Phase C — the outbound spoke. Pushes canonical hub rows INTO the person's
      // own Google calendar. Has no read/map (it consumes the hub rows the
      // inbound pass already fetched); runSync drives it via `push`.
      id: 'performer-google-push',
      name: 'Performer Google Calendar (outbound)',
      direction: 'outbound',
      requiresGcalKey: true,
      identityKey: 'googleCalendarId', // also the write target
      optInKey: 'pushEnabled',
      push: (env, profile, hubRows, ctx) => pushToGoogle(env, profile, hubRows, ctx),
    },
  ];
}

async function listSyncableProfiles(env) {
  const formula = `OR({${PROFILE_F.cruiseActId}}!='', {${PROFILE_F.landActId}}!='', {${PROFILE_F.googleCalendarId}}!='')`;
  const out = [];
  let offset;
  do {
    const params = new URLSearchParams();
    params.set('filterByFormula', formula);
    params.set('pageSize', '100');
    for (const f of [PROFILE_F.displayName, PROFILE_F.cruiseActId, PROFILE_F.landActId, PROFILE_F.googleCalendarId, PROFILE_F.pushEnabled, PROFILE_F.availability]) {
      params.append('fields[]', f);
    }
    if (offset) params.set('offset', offset);
    const page = await airtableGet(env.hubToken, `${AIRTABLE_API}/${env.hubBase}/${PROFILES_TABLE}?${params}`);
    for (const r of (page.records || [])) {
      out.push({
        id: r.id,
        name: r.fields[PROFILE_F.displayName] || '(unnamed)',
        cruiseActId: String(r.fields[PROFILE_F.cruiseActId] || '').trim(),
        landActId: String(r.fields[PROFILE_F.landActId] || '').trim(),
        googleCalendarId: String(r.fields[PROFILE_F.googleCalendarId] || '').trim(),
        pushEnabled: r.fields[PROFILE_F.pushEnabled] === true,
        availabilityIds: r.fields[PROFILE_F.availability] || [],
      });
    }
    offset = page.offset;
  } while (offset);
  return out;
}

// This act's existing Availability rows, found via the Profile's inverse link
// so the lookup is exact. Rows owned by other connectors / sources are returned
// too, but reconcile only ever touches rows whose Source matches a connector.
async function fetchActAvailability(env, profile) {
  const ids = profile.availabilityIds || [];
  const rows = [];
  for (const chunk of chunkArray(ids, 40)) {
    const formula = 'OR(' + chunk.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
    let offset;
    do {
      const params = new URLSearchParams();
      params.set('filterByFormula', formula);
      params.set('pageSize', '100');
      for (const f of Object.values(AVAIL_F)) params.append('fields[]', f);
      if (offset) params.set('offset', offset);
      const page = await airtableGet(env.hubToken, `${AIRTABLE_API}/${env.hubBase}/${AVAILABILITY_TABLE}?${params}`);
      for (const r of (page.records || [])) {
        const f = r.fields || {};
        rows.push({
          id: r.id,
          startDate: f[AVAIL_F.startDate] || '',
          endDate: f[AVAIL_F.endDate] || '',
          type: selName(f[AVAIL_F.type]),
          source: selName(f[AVAIL_F.source]),
          division: selName(f[AVAIL_F.division]),
          venue: f[AVAIL_F.venue] || '',
          label: f[AVAIL_F.recordLabel] || '',
          engagementRef: f[AVAIL_F.engagementRef] || '',
        });
      }
      offset = page.offset;
    } while (offset);
  }
  return rows;
}

// Reads an act's booking records from a source base. Resolves identity via the
// act record's inverse-link field (exact, by record ID), then batch-fetches the
// linked booking records. GET only — never writes to the source base.
async function readSourceBookings(opts) {
  const { token, base, actTable, actRecordId, inverseLink, bookingTable, bookingFields } = opts;

  const actParams = new URLSearchParams();
  actParams.set('filterByFormula', `RECORD_ID()='${actRecordId}'`);
  actParams.set('returnFieldsByFieldId', 'true');
  actParams.append('fields[]', inverseLink);
  const actPage = await airtableGet(token, `${AIRTABLE_API}/${base}/${actTable}?${actParams}`);
  const actRec = (actPage.records || [])[0];
  if (!actRec) throw new Error(`source act record not found: ${actRecordId}`);
  const bookingIds = (actRec.fields && actRec.fields[inverseLink]) || [];

  const out = [];
  for (const chunk of chunkArray(bookingIds, 40)) {
    const formula = 'OR(' + chunk.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
    let offset;
    do {
      const params = new URLSearchParams();
      params.set('filterByFormula', formula);
      params.set('pageSize', '100');
      params.set('returnFieldsByFieldId', 'true');
      for (const f of bookingFields) params.append('fields[]', f);
      if (offset) params.set('offset', offset);
      const page = await airtableGet(token, `${AIRTABLE_API}/${base}/${bookingTable}?${params}`);
      out.push(...(page.records || []));
      offset = page.offset;
    } while (offset);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Performer Google Calendar connector
// ---------------------------------------------------------------------------

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

// Reads today-forward events for one calendar (GET only). Recurring events are
// expanded (singleEvents=true); paginates.
async function readGoogleCalendar(env, calendarId) {
  const token = await getGoogleAccessToken(env);
  const today = todayInPhoenix();
  const timeMin = `${today}T00:00:00Z`;
  const timeMax = `${addMonths(today, GCAL_HORIZON_MONTHS)}T00:00:00Z`;
  const out = [];
  let pageToken;
  do {
    const params = new URLSearchParams();
    params.set('singleEvents', 'true');
    params.set('orderBy', 'startTime');
    params.set('showDeleted', 'false');
    params.set('maxResults', '2500');
    params.set('timeMin', timeMin);
    params.set('timeMax', timeMax);
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

// Classifies one Google event to a canonical Availability candidate, or null to
// ignore. "CONFIRMED — …" = a real TAD booking (Booked); all-day keyword/busy
// blocks = Unavailable; plain timed events and free all-day events do not block;
// our own "SL365 …" echoes are skipped (loop prevention).
function mapGoogle(event, ctx) {
  if (!event || event.status === 'cancelled') return null;
  const summary = (event.summary || '').trim();
  if (!summary) return null;
  if (GCAL_OWN_ECHO_RE.test(summary)) return null;

  const isAllDay = !!(event.start && event.start.date);
  const start = isAllDay ? event.start.date : ((event.start && event.start.dateTime) || '').slice(0, 10);
  if (!start) return null;
  // Google all-day end.date is exclusive (day after) — make it inclusive.
  let end;
  if (isAllDay) end = (event.end && event.end.date) ? addDays(event.end.date, -1) : start;
  else end = (((event.end && event.end.dateTime) || event.start.dateTime) || '').slice(0, 10) || start;
  if (end < start) end = start;
  if (end < ctx.today) return null; // today-forward only

  let type, division;
  if (GCAL_CONFIRMED_RE.test(summary)) {
    type = TYPE_BOOKED; division = DIVISION_LAND;
  } else if (isAllDay) {
    const keyword = GCAL_BLOCK_RE.test(summary);
    const busy = event.transparency !== 'transparent'; // opaque = busy
    if (keyword || busy) { type = TYPE_UNAVAILABLE; division = DIVISION_PERSONAL; }
    else return null; // free all-day, no keyword → ignore
  } else {
    return null; // plain timed event → never blocks (standard rule)
  }

  return {
    // Stable synthetic key (date+gig) so duplicate source events collapse to one
    // row and the reference doesn't churn when a duplicate is added/removed.
    engagementRef: `gcal:${start}:${end}:${gcalNormGig(summary)}`,
    startDate: start, endDate: end,
    type, division,
    venue: gcalVenue(summary),
    label: buildLabel(ctx.profile.name, summary, start),
  };
}

// Collapse candidates sharing a synthetic key to one — prefer Booked, then the
// richer (longer) label.
function dedupeGoogle(candidates) {
  const best = new Map();
  for (const c of candidates) {
    const cur = best.get(c.engagementRef);
    if (!cur || gcalRank(c) < gcalRank(cur)) best.set(c.engagementRef, c);
  }
  return [...best.values()];
}
function gcalRank(c) {
  // lower is better: Booked beats Unavailable; longer label preferred
  return (c.type === TYPE_BOOKED ? 0 : 1e6) - (c.label ? c.label.length : 0);
}
function gcalVenue(summary) {
  const s = summary.replace(GCAL_CONFIRMED_RE, '').trim();
  const at = s.indexOf(' @ ');
  return at >= 0 ? s.slice(at + 3).trim() : '';
}
function gcalNormGig(summary) {
  let s = summary.replace(GCAL_CONFIRMED_RE, '').trim();
  const at = s.indexOf(' @ ');
  if (at >= 0) s = s.slice(0, at);
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Outbound push: hub → the person's own Google calendar (Phase C)
// ---------------------------------------------------------------------------
//
// DELETION-SAFETY INVARIANTS (decision record §11.4 — must hold in review):
//   1. We only ever create/patch/delete events whose id is in our `sl365…`
//      namespace — verified by id prefix AND by the `source=stagelink`
//      extendedProperty filter when listing. We never touch a foreign event.
//   2. The delete set is {our existing sl365 events} − {sl365 ids derived from
//      current hub rows}. We never "clear the calendar".
//   3. A failed hub read aborts the push for this person (the read throws into
//      runSync's per-act catch before we get here), so an empty `hubRows` means
//      genuinely-no-commitments — never "couldn't read".
//   4. Create before delete, so a mid-run failure leaves a recoverable duplicate,
//      never a gap.
//   5. Every event carries the `SL365 — ` summary prefix and the
//      `source=stagelink` extendedProperty.
async function pushToGoogle(env, profile, hubRows, ctx) {
  const { today, dryRun } = ctx;
  const horizonEnd = addMonths(today, GCAL_HORIZON_MONTHS);

  // Desired set: hub rows that are (a) Booked/Unavailable, (b) NOT originated
  // from a Google calendar (no echo — Q5), (c) today-forward within the horizon.
  const desired = new Map(); // sl365 id -> Google event resource
  for (const row of hubRows) {
    if (!GCAL_PUSH_TYPES.has(row.type)) continue;
    if (GCAL_ORIGIN_SOURCES.has(row.source)) continue;
    if (!row.startDate) continue;
    const end = row.endDate || row.startDate;
    if (end < today) continue;            // today-forward only
    if (row.startDate >= horizonEnd) continue; // within push horizon
    const id = sl365EventId(row.id);
    desired.set(id, buildGoogleEvent(id, row));
  }

  // Enumerate the events WE already own on this calendar, bounded to the same
  // today-forward horizon (we never reconcile past events — leave history alone).
  const existingOurs = await listOwnGoogleEvents(env, profile.googleCalendarId, today, horizonEnd);

  const plan = { create: [], update: [], delete: [], desiredCount: desired.size };
  for (const [id, ev] of desired) {
    const cur = existingOurs.get(id);
    if (!cur) plan.create.push(ev);
    else if (googleEventDiffers(cur, ev)) plan.update.push(ev);
  }
  for (const id of existingOurs.keys()) {       // invariant 2: only delete our own, only when no longer desired
    if (!desired.has(id)) plan.delete.push(id);
  }

  if (!dryRun) await applyGooglePlan(env, profile.googleCalendarId, plan);
  return plan;
}

// All-day Google event mirroring one hub row. Google all-day end.date is
// EXCLUSIVE, so end = hubEnd + 1 day (the exact inverse of the inbound -1).
function buildGoogleEvent(id, row) {
  const end = row.endDate || row.startDate;
  return {
    id,
    summary: SL365_SUMMARY_PREFIX + (row.label || row.type),
    start: { date: row.startDate },
    end:   { date: addDays(end, 1) },
    colorId: GCAL_COLOR_BY_TYPE[row.type],
    transparency: 'opaque', // both Booked and Unavailable mean "not free" → show busy
    reminders: { useDefault: false }, // informational mirrors — don't nag the person
    extendedProperties: { private: { source: SL365_SOURCE_TAG, slType: row.type, slRecordId: row.id } },
  };
}

// Lists the events we authored on a calendar, scoped two ways: the
// `source=stagelink` private extendedProperty filter AND (belt-and-suspenders,
// invariant 1) an id-namespace check before we ever return one. Bounded to the
// push horizon so historical SL365 events are never reconciled/deleted.
async function listOwnGoogleEvents(env, calendarId, today, horizonEnd) {
  const token = await getGoogleAccessToken(env);
  const out = new Map();
  let pageToken;
  do {
    const params = new URLSearchParams();
    params.set('singleEvents', 'true');
    params.set('showDeleted', 'false');
    params.set('maxResults', '2500');
    params.set('timeMin', `${today}T00:00:00Z`);
    params.set('timeMax', `${horizonEnd}T00:00:00Z`);
    params.set('privateExtendedProperty', `source=${SL365_SOURCE_TAG}`);
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const resp = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Google list(own) ${resp.status} for ${calendarId}: ${txt.slice(0, 200)}`);
    }
    const data = await resp.json();
    for (const ev of (data.items || [])) {
      if (ev.id && ev.id.startsWith(SL365_ID_PREFIX)) out.set(ev.id, ev); // invariant 1
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

function googleEventDiffers(cur, ev) {
  return (cur.summary || '') !== ev.summary ||
    (cur.start && cur.start.date) !== ev.start.date ||
    (cur.end && cur.end.date) !== ev.end.date ||
    (cur.colorId || '') !== (ev.colorId || '');
}

// Applies the plan to one Google calendar. Create before delete (invariant 4).
async function applyGooglePlan(env, calendarId, plan) {
  const token = await getGoogleAccessToken(env);
  const base = `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events`;

  for (const ev of plan.create) {
    // insert with our explicit id = idempotent upsert. A 409 (id already there
    // from a prior partial run) degrades to patch rather than erroring.
    const resp = await fetchWithRetry(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    if (resp.status === 409) {
      await patchGoogleEvent(env, calendarId, ev, token);
    } else if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Google insert ${resp.status}: ${txt.slice(0, 200)}`);
    }
  }
  for (const ev of plan.update) {
    await patchGoogleEvent(env, calendarId, ev, token);
  }
  for (const id of plan.delete) {
    if (!id.startsWith(SL365_ID_PREFIX)) continue; // invariant 1 — never delete a foreign id
    const resp = await fetchWithRetry(`${base}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    // 404/410 = already gone — idempotent, fine.
    if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
      const txt = await resp.text();
      throw new Error(`Google delete ${resp.status}: ${txt.slice(0, 200)}`);
    }
  }
}

async function patchGoogleEvent(env, calendarId, ev, token) {
  const url = `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(ev.id)}`;
  const resp = await fetchWithRetry(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(ev),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Google patch ${resp.status}: ${txt.slice(0, 200)}`);
  }
}

// Deterministic, namespaced Google event id from the Availability record id.
// Google event ids allow lowercase a–v + digits 0–9, length 5–1024 — exactly the
// base32hex alphabet — so this is a natural, collision-free, idempotent key.
function sl365EventId(recordId) {
  return SL365_ID_PREFIX + base32hex(Buffer.from(String(recordId), 'utf8'));
}

// RFC 4648 base32hex (extended-hex alphabet), lowercase, no padding. `value` is
// masked to its live bit-width each byte so it never overflows JS's 32-bit
// bitwise range over a long input.
function base32hex(buf) {
  const A = '0123456789abcdefghijklmnopqrstuv';
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += A[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

function mapLand(rec, ctx) {
  const f = rec.fields || {};
  const status = f[LAND_FID.status];
  const start = f[LAND_FID.startDate];
  if (!status || !start) return null;

  let type;
  if (LAND_BOOKED.has(status)) type = TYPE_BOOKED;
  else if (LAND_BLOCKED.has(status)) type = TYPE_UNAVAILABLE;
  else {
    if (!isLandSkip(status)) bump(ctx.unrecognizedStatuses, `land: ${status}`);
    return null;
  }

  const end = f[LAND_FID.endDate] || start;
  if (end < ctx.today) return null;   // horizon: keep today-forward only

  const venue = String(f[LAND_FID.venue] || '').trim();
  return {
    engagementRef: rec.id,
    startDate: start, endDate: end,
    type, division: DIVISION_LAND,
    venue,
    label: buildLabel(ctx.profile.name, venue || (type === TYPE_BOOKED ? 'Land booking' : 'Land block'), start),
  };
}

function mapCruise(rec, ctx) {
  const f = rec.fields || {};
  const status = f[CRUISE_FID.status];
  const start = f[CRUISE_FID.dateFrom];
  if (!status || !start) return null;
  const end = f[CRUISE_FID.dateTo] || start;
  if (end < ctx.today) return null;   // horizon

  // A cruise-base "Land Date" row mirrors a land gig. CURRENT EVENTS is the
  // authority for land dates (decision Q2): keep the cruise mirror only where
  // no land-connector row already covers it.
  if (status === CRUISE_LAND_DATE) {
    const covered = ctx.landIntervals.some(iv => rangesOverlap(start, end, iv.start, iv.end));
    if (covered) return null;
    return {
      engagementRef: rec.id,
      startDate: start, endDate: end,
      type: TYPE_BOOKED, division: DIVISION_LAND,
      venue: 'Land date',
      label: buildLabel(ctx.profile.name, 'Land date', start),
    };
  }

  let type;
  if (CRUISE_BOOKED.has(status)) type = TYPE_BOOKED;
  else if (CRUISE_BLOCKED.has(status)) type = TYPE_UNAVAILABLE;
  else {
    if (!CRUISE_SKIP.has(status)) bump(ctx.unrecognizedStatuses, `cruise: ${status}`);
    return null;
  }

  const line = String(f[CRUISE_FID.cruiseLine] || '').trim();
  const ship = String(f[CRUISE_FID.ship] || '').trim();
  const context = [line, ship].filter(Boolean).join(' — ') ||
    (type === TYPE_BOOKED ? 'Cruise sailing' : 'Cruise (Not Available)');
  return {
    engagementRef: rec.id,
    startDate: start, endDate: end,
    type, division: DIVISION_CRUISE,
    venue: context,
    label: buildLabel(ctx.profile.name, context, start),
  };
}

// Reconciles one connector's candidates against its existing rows, keyed on
// Engagement Reference (the source record ID). Existing rows that carry the
// connector's Source tag but no Engagement Reference are pre-automation manual
// rows — they are deleted so the first run cleanly replaces them (decision Q3).
function reconcile(candidates, existing, profile) {
  const plan = { create: [], update: [], delete: [] };
  const byRef = new Map();
  for (const row of existing) {
    if (row.engagementRef) byRef.set(row.engagementRef, row);
    else plan.delete.push(row.id);
  }
  const seen = new Set();
  for (const cand of candidates) {
    seen.add(cand.engagementRef);
    const match = byRef.get(cand.engagementRef);
    if (!match) {
      plan.create.push(buildFields(cand, profile));
    } else if (rowDiffers(match, cand)) {
      plan.update.push({ id: match.id, fields: buildFields(cand, profile) });
    }
  }
  for (const [ref, row] of byRef) {
    if (!seen.has(ref)) plan.delete.push(row.id);
  }
  return plan;
}

function buildFields(cand, profile) {
  return {
    [AVAIL_F.recordLabel]:   cand.label,
    [AVAIL_F.profile]:       [profile.id],
    [AVAIL_F.startDate]:     cand.startDate,
    [AVAIL_F.endDate]:       cand.endDate,
    [AVAIL_F.type]:          cand.type,
    [AVAIL_F.source]:        cand.sourceTag,
    [AVAIL_F.division]:      cand.division,
    [AVAIL_F.venue]:         cand.venue,
    [AVAIL_F.engagementRef]: cand.engagementRef,
    [AVAIL_F.updatedBy]:     UPDATED_BY,
  };
}

function rowDiffers(row, cand) {
  return row.startDate !== cand.startDate ||
    row.endDate !== cand.endDate ||
    row.type !== cand.type ||
    row.division !== cand.division ||
    (row.venue || '') !== (cand.venue || '') ||
    row.label !== cand.label;
}

// Cross-division overlapping Booked rows = a real double-booking (spec §10).
// The conflict is the product: surfacing it is why the unified calendar exists.
function detectConflicts(candidatesByConnector) {
  const booked = [];
  for (const cid of Object.keys(candidatesByConnector)) {
    for (const c of candidatesByConnector[cid].candidates) {
      if (c.type === TYPE_BOOKED) booked.push(c);
    }
  }
  const conflicts = [];
  for (let i = 0; i < booked.length; i++) {
    for (let j = i + 1; j < booked.length; j++) {
      const a = booked[i], b = booked[j];
      if (a.division === b.division) continue;
      if (rangesOverlap(a.startDate, a.endDate, b.startDate, b.endDate)) {
        conflicts.push({
          a: { division: a.division, dates: [a.startDate, a.endDate], venue: a.venue, ref: a.engagementRef },
          b: { division: b.division, dates: [b.startDate, b.endDate], venue: b.venue, ref: b.engagementRef },
        });
      }
    }
  }
  return conflicts;
}

// Writes the plan to the StageLink Availability table. Create before delete so
// a mid-run failure leaves recoverable duplicates rather than lost rows; the
// sync is idempotent, so the next run cleans any partial state.
async function applyPlan(env, plan) {
  const url = `${AIRTABLE_API}/${env.hubBase}/${AVAILABILITY_TABLE}`;
  for (const chunk of chunkArray(plan.create, 10)) {
    await airtableWrite(env.hubToken, url, 'POST', { records: chunk.map(fields => ({ fields })) });
  }
  for (const chunk of chunkArray(plan.update, 10)) {
    await airtableWrite(env.hubToken, url, 'PATCH', { records: chunk });
  }
  for (const chunk of chunkArray(plan.delete, 10)) {
    const params = new URLSearchParams();
    for (const id of chunk) params.append('records[]', id);
    await airtableWrite(env.hubToken, `${url}?${params}`, 'DELETE', null);
  }
}

async function airtableGet(token, url) {
  const resp = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Airtable GET ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return resp.json();
}

async function airtableWrite(token, url, method, body) {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetchWithRetry(url, opts);
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Airtable ${method} ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return resp.json();
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

function rangesOverlap(s1, e1, s2, e2) {
  return s1 <= e2 && s2 <= e1;
}

function buildLabel(name, context, start) {
  return `${name} - ${context} - ${start}`;
}

function selName(v) {
  if (v && typeof v === 'object') return v.name || '';
  return v || '';
}

function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

function chunkArray(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
