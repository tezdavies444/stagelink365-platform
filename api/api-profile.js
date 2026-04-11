// GET /api/profile?id=recXXX — Get single profile
// PATCH /api/profile — Update profile fields
// Body: { id: "recXXX", fields: { ... }, token: "magic-link-token" }

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const PROFILES_TABLE_ID = process.env.AIRTABLE_PROFILES_TABLE_ID || 'tblse7dXJfUjvEWQa';

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // GET — Fetch single profile by Airtable record ID
  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing profile id' });

    try {
      const response = await fetch(
        `${AIRTABLE_BASE_URL}/${AIRTABLE_BASE_ID}/${PROFILES_TABLE_ID}/${id}`,
        { headers: { 'Authorization': `Bearer ${AIRTABLE_API_TOKEN}` } }
      );

      if (!response.ok) {
        return res.status(404).json({ error: 'Profile not found' });
      }

      const record = await response.json();
      return res.status(200).json({ profile: transformProfile(record) });
    } catch (err) {
      console.error('Error fetching profile:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // PATCH — Update profile
  if (req.method === 'PATCH') {
    const { id, fields, token } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing profile id' });
    if (!fields) return res.status(400).json({ error: 'Missing fields to update' });

    // Authenticate: require either admin token or performer's magic link token
    const adminToken = process.env.ADMIN_TOKEN;
    const authHeader = req.headers.authorization;
    const isAdmin = adminToken && (authHeader === `Bearer ${adminToken}` || token === adminToken);

    if (!isAdmin && token) {
      // Verify magic link token matches the profile
      const verifyRes = await fetch(
        `${AIRTABLE_BASE_URL}/${AIRTABLE_BASE_ID}/${PROFILES_TABLE_ID}/${id}`,
        { headers: { 'Authorization': `Bearer ${AIRTABLE_API_TOKEN}` } }
      );
      if (!verifyRes.ok) return res.status(404).json({ error: 'Profile not found' });
      const existing = await verifyRes.json();
      if (existing.fields['Magic Link Token'] !== token) {
        return res.status(403).json({ error: 'Invalid token' });
      }
    } else if (!isAdmin) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Map frontend field names to Airtable field names
    const airtableFields = mapToAirtableFields(fields);

    try {
      const response = await fetch(
        `${AIRTABLE_BASE_URL}/${AIRTABLE_BASE_ID}/${PROFILES_TABLE_ID}/${id}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ fields: airtableFields })
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        console.error('Airtable update error:', errText);
        return res.status(502).json({ error: 'Failed to update profile' });
      }

      const updated = await response.json();
      return res.status(200).json({ profile: transformProfile(updated) });
    } catch (err) {
      console.error('Error updating profile:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

function mapToAirtableFields(fields) {
  const mapping = {
    name: 'Display Name',
    email: 'Email',
    phone: 'Phone',
    bio: 'Bio',
    location: 'Location - City',
    state: 'Location - State',
    country: 'Location - Country',
    category: 'Primary Category',
    subcategories: 'Subcategories',
    genres: 'Genres',
    skills: 'Skills',
    unions: 'Union Affiliations',
    equipment: 'Equipment',
    recentVenues: 'Recent Venues',
    travelRadius: 'Travel Radius (miles)',
    rateMin: 'Rate Min',
    rateMax: 'Rate Max',
    rateType: 'Rate Type',
    yearsExp: 'Years Experience',
    slug: 'Custom URL Slug',
    available: 'Is Available',
    videoLink: 'Video Link',
    showReelLink: 'Show Reel Link',
    audioLink: 'Audio Link'
  };

  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    const airtableKey = mapping[key];
    if (airtableKey) {
      // Handle arrays that need to be newline-separated text
      if (key === 'equipment' || key === 'recentVenues') {
        result[airtableKey] = Array.isArray(value) ? value.join('\n') : value;
      } else if (key === 'category') {
        // Primary Category is now multipleSelects -- always send as array
        result[airtableKey] = Array.isArray(value) ? value : [value];
      } else {
        result[airtableKey] = value;
      }
    }
  }
  return result;
}

function transformProfile(record) {
  const f = record.fields;
  const name = f['Display Name'] || '';
  const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  let tier = 'free';
  const sub = f['Subscription Tier'];
  if (sub) {
    const subName = (typeof sub === 'object' ? sub.name : sub).toLowerCase();
    if (subName.includes('premium') || subName.includes('49')) tier = 'premium';
    else if (subName.includes('pro') || subName.includes('19')) tier = 'pro';
    else if (subName.includes('business')) tier = 'premium';
  }

  // Map categories (now multipleSelects -- returns array)
  let categories = ['performers'];
  const cat = f['Primary Category'];
  if (cat) {
    if (Array.isArray(cat)) {
      categories = cat.map(c => (typeof c === 'object' ? c.name : c).toLowerCase());
    } else {
      categories = [(typeof cat === 'object' ? cat.name : cat).toLowerCase()];
    }
  }
  const category = categories[0] || 'performers';

  const extractMulti = (field) => {
    if (!field) return [];
    if (Array.isArray(field)) return field.map(v => typeof v === 'object' ? v.name : v);
    return [];
  };

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

  let equipment = [];
  if (f['Equipment']) {
    equipment = f['Equipment'].split('\n').map(e => e.trim()).filter(Boolean);
  }

  let recentVenues = [];
  if (f['Recent Venues']) {
    recentVenues = f['Recent Venues'].split('\n').map(v => v.trim()).filter(Boolean);
  }

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
    country: f['Location - Country'] || '',
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
    rating: 0,
    reviews: 0,
    gigs: 0
  };
}
