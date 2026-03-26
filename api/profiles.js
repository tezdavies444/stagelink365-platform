// GET /api/profiles — List all profiles from Airtable
// Optional query params: ?category=performers&available=true&search=guitar

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

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

    // Apply filters from query params
    let filtered = profiles;
    const { category, available, search, tier } = req.query;

    if (category && category !== 'all') {
      filtered = filtered.filter(p => p.category === category);
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

    return res.status(200).json({ profiles: filtered, total: filtered.length });
  } catch (err) {
    console.error('Error fetching profiles:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

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

  // Map category
  let category = 'performers';
  const cat = f['Primary Category'];
  if (cat) {
    category = (typeof cat === 'object' ? cat.name : cat).toLowerCase();
  }

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
    travel: f['Travel Radius (miles)'] ? `${f['Travel Radius (miles)']} miles` : '',
    yearsExp: f['Years Experience'] || 0,
    equipment,
    recentVenues,
    photoUrl,
    calendarToken: f['Magic Link Token'] || null,
    slug: f['Custom URL Slug'] || null,
    profileViews: f['Profile Views'] || 0,
    searchAppearances: f['Search Appearances'] || 0,
    accountType: f['Account Type'] ? (typeof f['Account Type'] === 'object' ? f['Account Type'].name : f['Account Type']) : 'Performer',
    rating: 0,
    reviews: 0,
    gigs: 0
  };
}
