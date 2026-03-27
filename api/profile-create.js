// POST /api/profile-create — Create a new profile in Airtable
// Body: { name, email, phone, category, subcategories, bio, location, state, ... }
// Optional: adminToken in Authorization header for admin creation

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const PROFILES_TABLE_ID = process.env.AIRTABLE_PROFILES_TABLE_ID || 'tblse7dXJfUjvEWQa';

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const body = req.body;
  if (!body.name || !body.email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  // Generate a magic link token
  const token = generateToken();

  // Build Airtable fields
  const fields = {
    'Display Name': body.name,
    'Email': body.email,
    'Magic Link Token': token,
    'Is Available': true,
    'Date Joined': new Date().toISOString()
  };

  // Optional fields
  if (body.phone) fields['Phone'] = body.phone;
  if (body.bio) fields['Bio'] = body.bio;
  if (body.location) fields['Location - City'] = body.location;
  if (body.state) fields['Location - State'] = body.state || 'AZ';
  if (body.category) {
    // Primary Category is now a multipleSelects field — always send as array
    fields['Primary Category'] = Array.isArray(body.category) ? body.category : [body.category];
  }
  if (body.subcategories && body.subcategories.length > 0) fields['Subcategories'] = body.subcategories;
  if (body.genres && body.genres.length > 0) fields['Genres'] = body.genres;
  if (body.skills && body.skills.length > 0) fields['Skills'] = body.skills;
  if (body.unions && body.unions.length > 0) fields['Union Affiliations'] = body.unions;
  if (body.yearsExp) fields['Years Experience'] = parseInt(body.yearsExp);
  if (body.rateMin) fields['Rate Min'] = parseFloat(body.rateMin);
  if (body.rateMax) fields['Rate Max'] = parseFloat(body.rateMax);
  if (body.rateType) fields['Rate Type'] = body.rateType;
  if (body.travelRadius) fields['Travel Radius (miles)'] = parseInt(body.travelRadius);
  if (body.equipment) fields['Equipment'] = Array.isArray(body.equipment) ? body.equipment.join('\n') : body.equipment;
  if (body.recentVenues) fields['Recent Venues'] = Array.isArray(body.recentVenues) ? body.recentVenues.join('\n') : body.recentVenues;

  // Determine account type
  const adminToken = process.env.ADMIN_TOKEN;
  const authHeader = req.headers.authorization;
  const isAdmin = adminToken && authHeader === `Bearer ${adminToken}`;

  if (isAdmin && body.accountType) {
    fields['Account Type'] = body.accountType;
  } else {
    fields['Account Type'] = 'Performer';
  }

  if (body.tier) {
    fields['Subscription Tier'] = body.tier;
  }

  try {
    const response = await fetch(
      `${AIRTABLE_BASE_URL}/${AIRTABLE_BASE_ID}/${PROFILES_TABLE_ID}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Airtable create error:', errText);
      return res.status(502).json({ error: 'Failed to create profile', details: errText });
    }

    const record = await response.json();

    return res.status(201).json({
      success: true,
      profile: {
        id: record.id,
        name: body.name,
        email: body.email,
        token: token,
        calendarUrl: `https://calendar.stagelink365.com/c/${token}`
      }
    });
  } catch (err) {
    console.error('Error creating profile:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 10; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}
