// POST /api/auth — Authenticate via magic link token or admin token
// Body: { token: "magic-link-token" } or { adminToken: "admin-secret" }
// Returns: { authenticated: true, profile: {...}, role: "performer"|"admin" }

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, ADMIN_TOKEN } = process.env;
  const PROFILES_TABLE_ID = process.env.AIRTABLE_PROFILES_TABLE_ID || 'tblse7dXJfUjvEWQa';

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { token, adminToken } = req.body;

  // Admin authentication
  if (adminToken) {
    if (ADMIN_TOKEN && adminToken === ADMIN_TOKEN) {
      return res.status(200).json({
        authenticated: true,
        role: 'admin',
        profile: { name: 'Admin', accountType: 'Admin' }
      });
    }
    return res.status(401).json({ error: 'Invalid admin token' });
  }

  // Magic link token authentication
  if (token) {
    if (!/^[A-Za-z0-9]{6,32}$/.test(token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    try {
      // Search for profile with this token
      const formula = encodeURIComponent(`{Magic Link Token}="${token}"`);
      const response = await fetch(
        `${AIRTABLE_BASE_URL}/${AIRTABLE_BASE_ID}/${PROFILES_TABLE_ID}?filterByFormula=${formula}&maxRecords=1`,
        { headers: { 'Authorization': `Bearer ${AIRTABLE_API_TOKEN}` } }
      );

      if (!response.ok) {
        return res.status(502).json({ error: 'Failed to verify token' });
      }

      const data = await response.json();
      if (!data.records || data.records.length === 0) {
        return res.status(401).json({ error: 'Token not found' });
      }

      const record = data.records[0];
      const f = record.fields;
      const accountType = f['Account Type'] ? (typeof f['Account Type'] === 'object' ? f['Account Type'].name : f['Account Type']) : 'Performer';

      return res.status(200).json({
        authenticated: true,
        role: accountType === 'Admin' ? 'admin' : 'performer',
        profile: {
          id: record.id,
          name: f['Display Name'] || '',
          email: f['Email'] || '',
          accountType,
          token
        }
      });
    } catch (err) {
      console.error('Auth error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(400).json({ error: 'Token or adminToken required' });
};
