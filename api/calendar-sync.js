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
// calendar. Connectors are direction-aware (inbound | outbound | both); Phase 1
// ships the two inbound TAD connectors. Outbound write-back to Cruise Avails is
// Phase 3 — designed-for here, not built.
//
// TRIGGER. A Vercel cron (see vercel.json) GETs this route once daily. Requests
// must carry the cron secret — `Authorization: Bearer <CRON_SECRET>` (what
// Vercel cron sends) or `?key=<CRON_SECRET>`. `?dryRun=1` computes the full
// plan and returns it WITHOUT writing — used to verify on preview deploys.
//
// Field-name / field-id constants are hardcoded at the top, per the existing
// per-handler precedent (api/founder.js). Base IDs are env vars per CLAUDE.md.

const AIRTABLE_API = 'https://api.airtable.com/v0';

// --- StageLink hub: the ONLY base this sync writes to (env AIRTABLE_BASE_ID) ---
const PROFILES_TABLE     = 'tblse7dXJfUjvEWQa';
const AVAILABILITY_TABLE = 'tblxJ9U0Anai6911A';

// Hub fields are referenced by NAME (repo convention — CLAUDE.md schema rules).
const PROFILE_F = {
  displayName:  'Display Name',
  cruiseActId:  'Cruise Act ID',
  landActId:    'Land Act ID',
  availability: 'Availability',   // inverse link → this act's Availability rows
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
const SOURCE_LAND      = 'Land Engagement Sync';
const SOURCE_CRUISE    = 'Cruise Engagement Sync';
const UPDATED_BY       = 'System — Calendar Sync';

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
        candidatesByConnector[connector.id] = { connector, candidates };
      }

      for (const cid of Object.keys(candidatesByConnector)) {
        const { connector, candidates } = candidatesByConnector[cid];
        const existing = existingRows.filter(r => r.source === connector.sourceTag);
        const plan = reconcile(candidates, existing, profile);
        if (!dryRun) await applyPlan(env, plan);
        totals.created += plan.create.length;
        totals.updated += plan.update.length;
        totals.deleted += plan.delete.length;
        actSummary.connectors[connector.id] = {
          sourceRows: candidates.length,
          created: plan.create.length,
          updated: plan.update.length,
          deleted: plan.delete.length,
        };
      }

      actSummary.conflicts = detectConflicts(candidatesByConnector);
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
  ];
}

async function listSyncableProfiles(env) {
  const formula = `OR({${PROFILE_F.cruiseActId}}!='', {${PROFILE_F.landActId}}!='')`;
  const out = [];
  let offset;
  do {
    const params = new URLSearchParams();
    params.set('filterByFormula', formula);
    params.set('pageSize', '100');
    for (const f of [PROFILE_F.displayName, PROFILE_F.cruiseActId, PROFILE_F.landActId, PROFILE_F.availability]) {
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
