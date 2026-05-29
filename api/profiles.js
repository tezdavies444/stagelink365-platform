// GET /api/profiles — List all profiles from Airtable
// Optional query params: ?category=performers&available=true&search=guitar
//
// Availability-on-a-date filter (Open Item #2, calendar-hub step 2):
//   ?availableFrom=YYYY-MM-DD[&availableTo=YYYY-MM-DD]
// When supplied, every returned profile is annotated with `availabilityStatus`
// ('available' | 'booked' | 'unknown') plus an `availabilityHold` soft flag, by
// reading the StageLink `Availability` hub (read-only). An act is `booked` if it
// has a Booked or Unavailable row overlapping the window; `available` if we hold
// calendar data for it and nothing blocks; `unknown` if we have no hub data for
// it at all (we never claim such an act is free). A Hold overlap leaves the act
// `available` but sets `availabilityHold`. No date param => no extra work and the
// response shape is unchanged. The two TAD bases are never touched here — this
// only reads Profiles + Availability in the StageLink base.

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

// StageLink Availability hub (same base as Profiles) — see api/calendar-sync.js.
const AVAILABILITY_TABLE = 'tblxJ9U0Anai6911A';
const AVAIL_F = {
  profile:   'Profile',            // link -> Profiles
  type:      'Availability Type',  // singleSelect: Booked/Unavailable/Hold/Available
  startDate: 'Start Date',
  endDate:   'End Date',
};
// The Profiles-side inverse link; a non-empty value = this act has hub data.
const PROFILE_AVAILABILITY_LINK = 'Availability';
const TYPE_BLOCKING = ['Booked', 'Unavailable']; // these hide an act on the date
const TYPE_HOLD = 'Hold';                        // soft flag only, does not hide
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const PROFILES_TABLE_ID = process.env.AIRTABLE_PROFILES_TABLE_ID || 'tblse7dXJfUjvEWQa';

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Server configuration error: missing Airtable credentials' });
  }

  try {
    // Fetch all profiles (paginated)
    let allRecords = [];
    let offset = null;

    do {
      const url = new URL(`${AIRTABLE_BASE_URL}/${AIRTABLE_BASE_ID}/${PROFILES_TABLE_ID}`);
      url.searchParams.set('pageSize', '100');
      if (offset) url.searchParams.set('offset', offset);

      const response = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${AIRTABLE_API_TOKEN}` }
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Airtable error:', errText);
        return res.status(502).json({ error: 'Failed to fetch from Airtable' });
      }

      const data = await response.json();
      allRecords = allRecords.concat(data.records);
      offset = data.offset || null;
    } while (offset);

    // Transform Airtable records to platform profile format
    const profiles = allRecords
      .filter(r => r.fields['Display Name']) // Skip empty records
      .map(r => transformProfile(r));

    // Availability-on-a-date annotation (read-only join against the hub).
    const { availableFrom, availableTo } = req.query;
    let availabilityOk = true;
    if (availableFrom && DATE_RE.test(availableFrom)) {
      const from = availableFrom;
      const to = (availableTo && DATE_RE.test(availableTo) && availableTo >= from) ? availableTo : from;

      // Coverage: which acts have ANY hub data (so "no data" can be told apart
      // from "free"). Read straight off the already-fetched Profiles records via
      // the inverse-link field — no extra request needed.
      const covered = new Set(
        allRecords
          .filter(r => Array.isArray(r.fields[PROFILE_AVAILABILITY_LINK]) && r.fields[PROFILE_AVAILABILITY_LINK].length > 0)
          .map(r => r.id)
      );

      // One query for just the rows that could hide/flag an act in the window.
      const { blocked, held, ok } = await fetchOverlappingCommitments(
        AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, from, to
      );

      for (const p of profiles) {
        if (!ok) {
          // Couldn't read the hub — never assert "free" on incomplete data.
          p.availabilityStatus = 'unknown';
        } else if (blocked.has(p.id)) {
          p.availabilityStatus = 'booked';
        } else if (covered.has(p.id)) {
          p.availabilityStatus = 'available';
          if (held.has(p.id)) p.availabilityHold = true;
        } else {
          p.availabilityStatus = 'unknown';
        }
      }
      availabilityOk = ok;
    }

    // Apply filters from query params
    let filtered = profiles;
    const { category, available, search, tier } = req.query;

    if (category && category !== 'all') {
      filtered = filtered.filter(p => p.categories.includes(category));
    }
    if (available === 'true') {
      filtered = filtered.filter(p => p.available);
    }
    if (tier && tier !== 'all') {
      filtered = filtered.filter(p => p.tier === tier);
    }
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.bio.toLowerCase().includes(q) ||
        p.subcategories.some(s => s.toLowerCase().includes(q)) ||
        p.genres.some(g => g.toLowerCase().includes(q)) ||
        p.skills.some(s => s.toLowerCase().includes(q))
      );
    }

    // Sort: premium first, then pro, then free, then by name
    filtered.sort((a, b) => {
      const tierOrder = { premium: 0, pro: 1, free: 2 };
      const tierDiff = (tierOrder[a.tier] || 2) - (tierOrder[b.tier] || 2);
      if (tierDiff !== 0) return tierDiff;
      return a.name.localeCompare(b.name);
    });

    const payload = { profiles: filtered, total: filtered.length };
    if (availableFrom && DATE_RE.test(availableFrom)) {
      const to = (availableTo && DATE_RE.test(availableTo) && availableTo >= availableFrom) ? availableTo : availableFrom;
      payload.availabilityFrom = availableFrom;
      payload.availabilityTo = to;
      if (!availabilityOk) payload.availabilityError = true;
    }
    return res.status(200).json(payload);
  } catch (err) {
    console.error('Error fetching profiles:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Reads the Availability hub for rows that overlap [from, to] and could affect
// an act's status on that window. Returns two Sets of Profile record IDs:
//   blocked — has a Booked/Unavailable row overlapping (hide as not free)
//   held    — has a Hold row overlapping (soft flag; still shown as available)
// Overlap = startDate <= to AND (endDate||startDate) >= from. Filtered
// server-side so only the (small) overlapping set is fetched, never all rows.
async function fetchOverlappingCommitments(token, baseId, from, to) {
  const blocked = new Set();
  const held = new Set();
  const ok = true;

  const typeClause =
    `OR(${[...TYPE_BLOCKING, TYPE_HOLD].map(t => `{${AVAIL_F.type}}='${t}'`).join(',')})`;
  // IF(end, end, start) guards the rare row with a blank End Date.
  const endExpr = `IF({${AVAIL_F.endDate}}, {${AVAIL_F.endDate}}, {${AVAIL_F.startDate}})`;
  const formula =
    `AND(` +
      `{${AVAIL_F.startDate}},` +
      typeClause + `,` +
      `NOT(IS_AFTER({${AVAIL_F.startDate}}, DATETIME_PARSE('${to}', 'YYYY-MM-DD'))),` +
      `NOT(IS_BEFORE(${endExpr}, DATETIME_PARSE('${from}', 'YYYY-MM-DD')))` +
    `)`;

  let offset = null;
  do {
    const url = new URL(`${AIRTABLE_BASE_URL}/${baseId}/${AVAILABILITY_TABLE}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.append('fields[]', AVAIL_F.profile);
    url.searchParams.append('fields[]', AVAIL_F.type);
    if (offset) url.searchParams.set('offset', offset);

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('Availability query error:', errText);
      // Signal failure so the caller degrades every act to 'unknown' rather
      // than asserting "free" on data we couldn't actually read.
      return { blocked, held, ok: false };
    }
    const data = await response.json();
    for (const rec of (data.records || [])) {
      const links = rec.fields[AVAIL_F.profile] || [];
      const typeVal = rec.fields[AVAIL_F.type];
      const type = typeVal && typeof typeVal === 'object' ? typeVal.name : typeVal;
      const target = (type === TYPE_HOLD) ? held : blocked;
      for (const link of links) {
        const id = typeof link === 'object' ? link.id : link;
        if (id) target.add(id);
      }
    }
    offset = data.offset || null;
  } while (offset);

  return { blocked, held, ok };
}

function transformProfile(record) {
  const f = record.fields;
  const name = f['Display Name'] || '';
  const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  // Map subscription tier
  let tier = 'free';
  const sub = f['Subscription Tier'];
  if (sub) {
    const subName = (typeof sub === 'object' ? sub.name : sub).toLowerCase();
    if (subName.includes('premium') || subName.includes('49')) tier = 'premium';
    else if (subName.includes('pro') || subName.includes('19')) tier = 'pro';
    else if (subName.includes('business')) tier = 'premium';
  }

  // Map categories (now multipleSelects — returns array)
  let categories = ['performers'];
  const cat = f['Primary Category'];
  if (cat) {
    if (Array.isArray(cat)) {
      categories = cat.map(c => (typeof c === 'object' ? c.name : c).toLowerCase());
    } else {
      categories = [(typeof cat === 'object' ? cat.name : cat).toLowerCase()];
    }
  }
  // Keep singular 'category' as first value for backwards compatibility
  const category = categories[0] || 'performers';

  // Extract multi-select values
  const extractMulti = (field) => {
    if (!field) return [];
    if (Array.isArray(field)) return field.map(v => typeof v === 'object' ? v.name : v);
    return [];
  };

  // Parse rate range
  let rate = '';
  const rateMin = f['Rate Min'];
  const rateMax = f['Rate Max'];
  const rateType = f['Rate Type'];
  if (rateMin || rateMax) {
    const min = rateMin ? `$${rateMin}` : '';
    const max = rateMax ? `$${rateMax}` : '';
    const type = rateType ? (typeof rateType === 'object' ? rateType.name : rateType) : '';
    rate = min && max ? `${min}-${max}` : (min || max);
    if (type) rate += `/${type}`;
  }

  // Parse equipment (rich text to array)
  let equipment = [];
  if (f['Equipment']) {
    equipment = f['Equipment'].split('\n').map(e => e.trim()).filter(Boolean);
  }

  // Parse recent venues (rich text to array)
  let recentVenues = [];
  if (f['Recent Venues']) {
    recentVenues = f['Recent Venues'].split('\n').map(v => v.trim()).filter(Boolean);
  }

  // Profile photo URL
  let photoUrl = null;
  if (f['Profile Photo'] && f['Profile Photo'].length > 0) {
    photoUrl = f['Profile Photo'][0].url;
  }

  return {
    id: record.id,
    name,
    initials,
    email: f['Email'] || '',
    phone: f['Phone'] || '',
    category,
    categories,
    subcategories: extractMulti(f['Subcategories']),
    genres: extractMulti(f['Genres']),
    skills: extractMulti(f['Skills']),
    unions: extractMulti(f['Union Affiliations']),
    location: f['Location - City'] || '',
    state: f['Location - State'] || '',
    tier,
    verified: !!f['Is Verified'],
    available: !!f['Is Available'],
    bio: f['Bio'] || '',
    rate,
    rateMin: f['Rate Min'] || null,
    rateMax: f['Rate Max'] || null,
    rateType: f['Rate Type'] ? (typeof f['Rate Type'] === 'object' ? f['Rate Type'].name : f['Rate Type']) : '',
    travel: f['Travel Radius (miles)'] ? `${f['Travel Radius (miles)']} miles` : '',
    travelRadius: f['Travel Radius (miles)'] || null,
    yearsExp: f['Years Experience'] || 0,
    equipment,
    recentVenues,
    photoUrl,
    videoLink: f['Video Link'] || '',
    showReelLink: f['Show Reel Link'] || '',
    audioLink: f['Audio Link'] || '',
    calendarToken: f['Magic Link Token'] || null,
    slug: f['Custom URL Slug'] || null,
    profileViews: f['Profile Views'] || 0,
    searchAppearances: f['Search Appearances'] || 0,
    accountType: f['Account Type'] ? (typeof f['Account Type'] === 'object' ? f['Account Type'].name : f['Account Type']) : 'Performer',
    isFounder: !!f['is_founder'],
    founderSeatNumber: f['founder_seat_number'] || null,
    fullName: f['Full Name'] || '',
    rating: 0,
    reviews: 0,
    gigs: 0
  };
}
