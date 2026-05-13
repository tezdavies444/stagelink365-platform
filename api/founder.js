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
// Talent-only Profile auto-create (Open Item #17a):
//   - Pre-insert: email-dedup against Profiles. If hit, return 409
//     `email_has_profile` so the modal can prompt for sign-in instead.
//   - On clean email: create a Profiles row with a generated magic-link
//     token, is_founder=true, founder_seat_number=N. Then create the
//     Founders row with status='converted' and Profile linked.
//   - Agency/venue claims still create only the Founders row (entities, not
//     people) — no Profile auto-create, no email dedup.
//   - If Profile-create succeeds but Founders-insert fails, the Profile is
//     orphaned (has founder_seat_number but no Founders row to back it).
//     Logged as "ORPHAN PROFILE" for manual recovery.
//
// Field-name strings are hardcoded constants below — per-handler precedent
// matching the existing four handlers. The cross-handler fields.js
// consolidation (Open Item #4) stays separate; when it eventually runs, it
// imports the constants from here.

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

const FOUNDERS_TABLE_ID_FALLBACK = 'tblwTL67NIFA2pmQG';
const PROFILES_TABLE_ID_FALLBACK = 'tblse7dXJfUjvEWQa';

// Founders table fields
const FIELD_SEAT_NUMBER    = 'seat_number';
const FIELD_TRACK          = 'track';
const FIELD_STATUS         = 'status';
const FIELD_EMAIL          = 'email';
const FIELD_NAME           = 'name';
const FIELD_REPRESENTATIVE = 'representative';
const FIELD_CLAIMED_AT     = 'claimed_at';
const FIELD_PROFILE_LINK   = 'Profile';

// Profiles table fields (the OI #17a talent-Founder create writes the subset listed).
// Names mirror api/profile-create.js where they overlap, but the singleSelect
// option VALUES below are corrected to match the live Airtable schema —
// api/profile-create.js currently writes Account Type='Performer' which is
// NOT a valid option (live options are Talent / Booker / Admin). That's a
// separate latent bug, deliberately NOT inherited here.
const P_FIELD_DISPLAY_NAME        = 'Display Name';
const P_FIELD_FULL_NAME           = 'Full Name';
const P_FIELD_EMAIL               = 'Email';
const P_FIELD_MAGIC_LINK_TOKEN    = 'Magic Link Token';
const P_FIELD_ACCOUNT_TYPE        = 'Account Type';
const P_FIELD_SUBSCRIPTION_TIER   = 'Subscription Tier';
const P_FIELD_IS_FOUNDER          = 'is_founder';
const P_FIELD_FOUNDER_SEAT_NUMBER = 'founder_seat_number';
const P_FIELD_IS_AVAILABLE        = 'Is Available';
const P_FIELD_DATE_JOINED         = 'Date Joined';

const ACCOUNT_TYPE_TALENT   = 'Talent';
const SUBSCRIPTION_TIER_PRO = 'Pro ($19/mo)';

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
  const PROFILES_TABLE_ID = process.env.AIRTABLE_PROFILES_TABLE_ID || PROFILES_TABLE_ID_FALLBACK;

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ success: false, error: 'server_config' });
  }

  const env = { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, FOUNDERS_TABLE_ID, PROFILES_TABLE_ID };

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

  // Talent path: email-dedup + auto-create a Profile so the claim leads to
  // a real onramp instead of a Close button. Agency/venue claims skip both
  // steps — they're entities, not people, and may legitimately share an
  // email across multiple roles (one person managing two venues etc.).
  let profile = null;
  if (track === TRACK_TALENT) {
    let existingProfile;
    try {
      existingProfile = await lookupProfileByEmail(email, env);
    } catch (err) {
      console.error('Founder email-dedup error:', err);
      return res.status(502).json({
        success: false,
        error: 'airtable_error',
        detail: String((err && err.message) || err)
      });
    }
    if (existingProfile) {
      return res.status(409).json({
        success: false,
        error: 'email_has_profile',
        track
      });
    }

    try {
      profile = await createTalentFounderProfile({
        displayName: name,
        fullName:    representative,
        email:       email,
        seatNumber:  seatNumber
      }, env);
    } catch (err) {
      console.error('Founder profile-create error:', err);
      return res.status(502).json({
        success: false,
        error: 'profile_create_failed',
        detail: String((err && err.message) || err)
      });
    }
  }

  const founderStatus = profile ? STATUS_CONVERTED : STATUS_CLAIMED;
  const fields = {
    [FIELD_SEAT_NUMBER]:    seatNumber,
    [FIELD_TRACK]:          track,
    [FIELD_STATUS]:         founderStatus,
    [FIELD_EMAIL]:          email,
    [FIELD_NAME]:           name,
    [FIELD_REPRESENTATIVE]: representative,
    [FIELD_CLAIMED_AT]:     new Date().toISOString()
  };
  if (profile) {
    fields[FIELD_PROFILE_LINK] = [profile.id];
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
      if (profile) {
        console.error('ORPHAN PROFILE created (Founders insert failed): id=' + profile.id + ' seat=' + seatNumber + ' email=' + email);
      }
      return res.status(502).json({ success: false, error: 'airtable_error', detail: errText });
    }

    const record = await response.json();

    return res.status(201).json({
      success: true,
      seat: {
        id:     record.id,
        number: seatNumber,
        track:  track,
        cap:    cap,
        status: founderStatus
      },
      profile: profile ? {
        id:            profile.id,
        token:         profile.token,
        magicLinkPath: profile.magicLinkPath
      } : null,
      message: 'Seat #' + seatNumber + ' of ' + cap + ' claimed. When SL365 platform payments go live, your booking fee is locked at 2% (vs 3% for non-Founders) — for life.'
    });
  } catch (err) {
    console.error('Error claiming founder seat:', err);
    if (profile) {
      console.error('ORPHAN PROFILE created (Founders insert threw): id=' + profile.id + ' seat=' + seatNumber + ' email=' + email);
    }
    return res.status(500).json({
      success: false,
      error: 'server_error',
      detail: String((err && err.message) || err)
    });
  }
}

// Look up a Profile by email (case-insensitive). Returns the matching record
// or null. Used for OI #17a talent dedup so a returning Founder can't create
// a duplicate Profile.
async function lookupProfileByEmail(email, env) {
  const formula = `LOWER({${P_FIELD_EMAIL}})='${escapeFormulaString(email.toLowerCase())}'`;
  const baseUrl = `${AIRTABLE_BASE_URL}/${env.AIRTABLE_BASE_ID}/${env.PROFILES_TABLE_ID}`;

  const params = new URLSearchParams();
  params.set('filterByFormula', formula);
  params.set('pageSize', '1');
  params.append('fields[]', P_FIELD_EMAIL);

  const response = await fetch(`${baseUrl}?${params.toString()}`, {
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_API_TOKEN}` }
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Airtable profile lookup failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const records = data.records || [];
  return records.length > 0 ? records[0] : null;
}

// Create a Profile row for a freshly-claimed talent Founder seat. Returns
// { id, token, magicLinkPath } on success; throws on Airtable failure.
//
// Field shape mirrors api/profile-create.js where the values overlap, but
// writes the correct singleSelect option names per the inspected Airtable
// schema: Account Type='Talent' (not 'Performer'), Subscription Tier='Pro
// ($19/mo)' (matches the OI #6 fuzzy matcher). magicLinkPath is path-only
// so the client can build a same-origin URL that works on both production
// and Vercel preview deploys.
async function createTalentFounderProfile({ displayName, fullName, email, seatNumber }, env) {
  const token = generateMagicLinkToken();

  const fields = {
    [P_FIELD_DISPLAY_NAME]:        displayName,
    [P_FIELD_FULL_NAME]:           fullName,
    [P_FIELD_EMAIL]:               email,
    [P_FIELD_MAGIC_LINK_TOKEN]:    token,
    [P_FIELD_ACCOUNT_TYPE]:        ACCOUNT_TYPE_TALENT,
    [P_FIELD_SUBSCRIPTION_TIER]:   SUBSCRIPTION_TIER_PRO,
    [P_FIELD_IS_FOUNDER]:          true,
    [P_FIELD_FOUNDER_SEAT_NUMBER]: seatNumber,
    [P_FIELD_IS_AVAILABLE]:        true,
    [P_FIELD_DATE_JOINED]:         new Date().toISOString()
  };

  const response = await fetch(
    `${AIRTABLE_BASE_URL}/${env.AIRTABLE_BASE_ID}/${env.PROFILES_TABLE_ID}`,
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
    throw new Error(`Airtable profile create failed (${response.status}): ${errText}`);
  }

  const record = await response.json();
  return {
    id: record.id,
    token: token,
    magicLinkPath: '/app/?token=' + encodeURIComponent(token)
  };
}

// 10-character alphanumeric token, regex /^[A-Za-z0-9]{6,32}$/ per auth.js.
// Doubles as the public calendar URL path at calendar.stagelink365.com/c/{token}
// — never rotate without a comms plan (CLAUDE.md hard rule).
function generateMagicLinkToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 10; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
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
