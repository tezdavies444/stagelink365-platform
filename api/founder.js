// GET  /api/founder — return the three current counts for the homepage display.
// POST /api/founder — claim a Founder Tier seat (count-then-insert).
//
// Single-file, method-dispatched, mirroring api/profile.js's GET/PATCH split
// (Vercel zero-config routes one file = one URL; method-dispatch is the
// established repo pattern, no vercel.json rewrites).
//
// Cap-counting rule (per §7 decision #3 in 02_STRATEGY.md):
//   {claimed, converted, retired} all count toward the cap and toward seat
//   numbering. Only `waitlisted` does NOT count. Retired seats stay claimed
//   against the cap forever — seat numbers are permanent identity claims;
//   the cap is 500 talent / 50 agency / 50 venue and never grows.
//
// Seat number is computed at insert time as:
//   count(track=X AND status IN {claimed, converted, retired}) + 1
// Same predicate as the cap-check, so one Airtable list call serves both.
//
// KNOWN LIMITATION — Airtable has no transactions. count-then-insert is
// best-effort, not atomic. Two simultaneous claims at exactly seat #N could
// both succeed and over-fill the cap by one. At the 90-day-plan target rate
// of ~5 claims/day the collision risk is negligible. Revisit only if traffic
// warrants. Do not add a separate locking table.
//
// Field-name strings are hardcoded constants below — per-handler precedent
// matching the existing four handlers. The cross-handler fields.js
// consolidation (Open Item #4) stays separate; when it eventually runs, it
// imports the constants from here.

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

const FOUNDERS_TABLE_ID_FALLBACK = 'tblwTL67NIFA2pmQG';

const FIELD_SEAT_NUMBER    = 'seat_number';
const FIELD_TRACK          = 'track';
const FIELD_STATUS         = 'status';
const FIELD_EMAIL          = 'email';
const FIELD_NAME           = 'name';
const FIELD_REPRESENTATIVE = 'representative';
const FIELD_CLAIMED_AT     = 'claimed_at';

const TRACK_TALENT = 'talent';
const TRACK_AGENCY = 'agency';
const TRACK_VENUE  = 'venue';

const STATUS_WAITLISTED = 'waitlisted';
const STATUS_CLAIMED    = 'claimed';
const STATUS_CONVERTED  = 'converted';
const STATUS_RETIRED    = 'retired';

const CAPS = {
  [TRACK_TALENT]: 500,
  [TRACK_AGENCY]: 50,
  [TRACK_VENUE]:  50
};

const VALID_TRACKS = [TRACK_TALENT, TRACK_AGENCY, TRACK_VENUE];

// Statuses that count toward the cap (and therefore toward seat numbering).
const SEAT_OCCUPYING_STATUSES = [STATUS_CLAIMED, STATUS_CONVERTED, STATUS_RETIRED];

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const FOUNDERS_TABLE_ID = process.env.AIRTABLE_FOUNDERS_TABLE_ID || FOUNDERS_TABLE_ID_FALLBACK;

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ success: false, error: 'server_config' });
  }

  const env = { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, FOUNDERS_TABLE_ID };

  if (req.method === 'GET')  return handleGetCounts(res, env);
  if (req.method === 'POST') return handleClaim(req, res, env);

  return res.status(405).json({ success: false, error: 'method_not_allowed' });
};

async function handleGetCounts(res, env) {
  try {
    const counts = await fetchAllCounts(env);
    return res.status(200).json({ success: true, counts });
  } catch (err) {
    console.error('Founder counts error:', err);
    return res.status(502).json({
      success: false,
      error: 'airtable_error',
      detail: String((err && err.message) || err)
    });
  }
}

async function handleClaim(req, res, env) {
  const body = req.body || {};
  const track          = typeof body.track          === 'string' ? body.track.trim().toLowerCase() : '';
  const email          = typeof body.email          === 'string' ? body.email.trim()          : '';
  const name           = typeof body.name           === 'string' ? body.name.trim()           : '';
  const representative = typeof body.representative === 'string' ? body.representative.trim() : '';

  if (!VALID_TRACKS.includes(track)) {
    return res.status(400).json({ success: false, error: 'invalid_track' });
  }
  if (!email) {
    return res.status(400).json({ success: false, error: 'missing_email' });
  }
  if (!name) {
    return res.status(400).json({ success: false, error: 'missing_name' });
  }
  if (!representative) {
    return res.status(400).json({ success: false, error: 'missing_representative' });
  }

  const cap = CAPS[track];

  let occupied;
  try {
    occupied = await countOccupiedSeats(track, env);
  } catch (err) {
    console.error('Founder cap-check error:', err);
    return res.status(502).json({
      success: false,
      error: 'airtable_error',
      detail: String((err && err.message) || err)
    });
  }

  if (occupied >= cap) {
    // Re-fetch all three counts so the UI can refresh its counters at the
    // moment a user is told the cap is closed. counts is optional in the
    // payload — UI must still handle the null path.
    let counts = null;
    try {
      counts = await fetchAllCounts(env, { [track]: occupied });
    } catch (_) { /* leave counts null */ }
    return res.status(409).json({ success: false, error: 'cap_reached', track, cap, counts });
  }

  const seatNumber = occupied + 1;
  const fields = {
    [FIELD_SEAT_NUMBER]: seatNumber,
    [FIELD_TRACK]:       track,
    [FIELD_STATUS]:      STATUS_CLAIMED,
    [FIELD_EMAIL]:       email,
    [FIELD_NAME]:        name,
    [FIELD_CLAIMED_AT]:  new Date().toISOString()
  };
  if (representative) {
    fields[FIELD_REPRESENTATIVE] = representative;
  }

  try {
    const response = await fetch(
      `${AIRTABLE_BASE_URL}/${env.AIRTABLE_BASE_ID}/${env.FOUNDERS_TABLE_ID}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.AIRTABLE_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Airtable founder insert error:', errText);
      return res.status(502).json({ success: false, error: 'airtable_error', detail: errText });
    }

    const record = await response.json();

    return res.status(201).json({
      success: true,
      seat: {
        id: record.id,
        number: seatNumber,
        track,
        cap,
        status: STATUS_CLAIMED
      },
      message: `Seat #${seatNumber} of ${cap} claimed. When SL365 platform payments go live, your booking fee is locked at 2% (vs 3% for non-Founders) — for life.`
    });
  } catch (err) {
    console.error('Error claiming founder seat:', err);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      detail: String((err && err.message) || err)
    });
  }
}

// Returns { talent: { claimed, cap }, agency: { claimed, cap }, venue: { claimed, cap } }.
// `prefilled` lets a caller skip a redundant query (e.g. the cap-reached path
// already has the count for the requested track).
async function fetchAllCounts(env, prefilled = {}) {
  const [talent, agency, venue] = await Promise.all([
    prefilled[TRACK_TALENT] != null ? prefilled[TRACK_TALENT] : countOccupiedSeats(TRACK_TALENT, env),
    prefilled[TRACK_AGENCY] != null ? prefilled[TRACK_AGENCY] : countOccupiedSeats(TRACK_AGENCY, env),
    prefilled[TRACK_VENUE]  != null ? prefilled[TRACK_VENUE]  : countOccupiedSeats(TRACK_VENUE,  env)
  ]);
  return {
    talent: { claimed: talent, cap: CAPS[TRACK_TALENT] },
    agency: { claimed: agency, cap: CAPS[TRACK_AGENCY] },
    venue:  { claimed: venue,  cap: CAPS[TRACK_VENUE]  }
  };
}

// Counts records for a given track whose status is in {claimed, converted, retired}.
async function countOccupiedSeats(track, env) {
  const statusOrClause = SEAT_OCCUPYING_STATUSES
    .map(s => `{${FIELD_STATUS}}='${escapeFormulaString(s)}'`)
    .join(', ');
  const formula = `AND({${FIELD_TRACK}}='${escapeFormulaString(track)}', OR(${statusOrClause}))`;
  const baseUrl = `${AIRTABLE_BASE_URL}/${env.AIRTABLE_BASE_ID}/${env.FOUNDERS_TABLE_ID}`;

  let count = 0;
  let offset;
  do {
    const params = new URLSearchParams();
    params.set('filterByFormula', formula);
    params.set('pageSize', '100');
    params.append('fields[]', FIELD_SEAT_NUMBER);
    if (offset) params.set('offset', offset);

    const response = await fetch(`${baseUrl}?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${env.AIRTABLE_API_TOKEN}` }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Airtable list failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    count += (data.records || []).length;
    offset = data.offset;
  } while (offset);

  return count;
}

// Escape single quotes for an Airtable filterByFormula string literal.
// Track values are whitelisted before reaching here; status values are
// internal constants. This is defensive belt-and-braces.
function escapeFormulaString(s) {
  return String(s).replace(/'/g, "\\'");
}
