// GET /api/avails?token={magic-link-token}
//
// StageLink365 — per-performer availability feed (JSON).
//
// The programmatic sibling of api/ics.js (the iCal feed). Same "SL365 exposes
// availability, clients PULL it" model (decision record
// strategy/calendar-sync/DECISION-2026-06-02-avails-pull-not-push.md): SL365 is
// the canonical hub and exposes a performer's blocked dates as JSON, so a
// dashboard or backend (e.g. TAD's routing dashboard, which pulls this to fold
// SL365 individual avails into its band-availability calc) can read it without
// SL365 ever writing into their system. ICS serves human calendar apps; this
// serves machines.
//
// READ-ONLY. Talks only to the StageLink base (AIRTABLE_BASE_ID); no writes, no
// schema change. Auth is the existing magic-link token (the token IS the access
// key). CORS is open (GET only) so browser dashboards can fetch it cross-origin.
// Clean URL via middleware.js: /calendar/{token}.json -> /api/avails?token={token}.
//
// PRIVACY: same as the ICS feed — each block carries only its TYPE
// ("Booked"/"Unavailable"/"Hold"), never the venue/gig label, Division, or
// Source. A consumer learns the person is unavailable, not what for.
//
// Field-name strings are hardcoded as constants (per-handler precedent), matching
// the names api/calendar-sync.js / api/ics.js read on the same tables.

const AIRTABLE_API = 'https://api.airtable.com/v0';
const AVAILABILITY_TABLE = 'tblxJ9U0Anai6911A';
const PROFILES_TABLE_FALLBACK = 'tblse7dXJfUjvEWQa';

const PROFILE_F = {
  displayName:  'Display Name',
  token:        'Magic Link Token',
  availability: 'Availability',   // inverse link → this profile's Availability rows
};
const AVAIL_F = {
  startDate: 'Start Date',
  endDate:   'End Date',
  type:      'Availability Type',
};

// Blocks only — the dates a performer is NOT free. Membership test, so listing a
// not-yet-used option like Hold is safe.
const BLOCK_TYPES = new Set(['Booked', 'Unavailable', 'Hold']);
const TOKEN_RE = /^[A-Za-z0-9]{6,32}$/;
const TIMEZONE = 'America/Phoenix';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const PROFILES_TABLE = process.env.AIRTABLE_PROFILES_TABLE_ID || PROFILES_TABLE_FALLBACK;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const token = String((req.query && req.query.token) || '').trim();
  // Invalid token → 404 (not 400/401) so the URL never confirms which tokens exist.
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Not found' });

  try {
    // 1) token → profile (name + the ids of its Availability rows)
    const formula = encodeURIComponent(`{${PROFILE_F.token}}="${token}"`);
    const fieldsQ = [PROFILE_F.displayName, PROFILE_F.availability]
      .map(f => `&fields[]=${encodeURIComponent(f)}`).join('');
    const pRes = await fetch(
      `${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${PROFILES_TABLE}?filterByFormula=${formula}&maxRecords=1${fieldsQ}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_TOKEN}` } }
    );
    if (!pRes.ok) return res.status(502).json({ error: 'Upstream error' });
    const pData = await pRes.json();
    const profile = pData.records && pData.records[0];
    if (!profile) return res.status(404).json({ error: 'Not found' });

    const name = profile.fields[PROFILE_F.displayName] || 'Performer';
    const availIds = profile.fields[PROFILE_F.availability] || [];

    // 2) read this profile's Availability rows (by inverse-link ids — exact, the
    //    same pattern calendar-sync.js fetchActAvailability() uses).
    const rows = await fetchAvailability(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, availIds);

    // 3) keep blocks only, today-forward (Phoenix, matching the sync's horizon),
    //    sorted by start date.
    const today = todayInPhoenix();
    const blocks = [];
    for (const r of rows) {
      const f = r.fields || {};
      const type = selName(f[AVAIL_F.type]);
      if (!BLOCK_TYPES.has(type)) continue;
      const start = f[AVAIL_F.startDate];
      if (!start) continue;
      const end = f[AVAIL_F.endDate] || start;
      if (end < today) continue;          // today-forward only
      blocks.push({ start, end, type });
    }
    blocks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json({
      token,
      name,
      timezone: TIMEZONE,
      generatedAt: new Date().toISOString(),
      count: blocks.length,
      blocks,
    });
  } catch (err) {
    console.error('avails error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Batch-fetch the linked Availability rows by record id (chunked OR(), paginated).
async function fetchAvailability(apiToken, base, ids) {
  const out = [];
  for (const chunk of chunkArray(ids, 40)) {
    const formula = 'OR(' + chunk.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
    let offset;
    do {
      const params = new URLSearchParams();
      params.set('filterByFormula', formula);
      params.set('pageSize', '100');
      for (const f of Object.values(AVAIL_F)) params.append('fields[]', f);
      if (offset) params.set('offset', offset);
      const resp = await fetch(
        `${AIRTABLE_API}/${base}/${AVAILABILITY_TABLE}?${params}`,
        { headers: { Authorization: `Bearer ${apiToken}` } }
      );
      if (!resp.ok) throw new Error(`Availability fetch ${resp.status}`);
      const data = await resp.json();
      out.push(...(data.records || []));
      offset = data.offset;
    } while (offset);
  }
  return out;
}

function todayInPhoenix() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function selName(v) {
  if (v && typeof v === 'object') return v.name || '';
  return v || '';
}
function chunkArray(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
