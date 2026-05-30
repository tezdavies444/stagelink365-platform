// POST /api/bookings — Marketplace booking origination (request → hold → confirm)
//
// The wire from "this act is free on date X" to an actual booking. All actions
// are POST + JSON body, authenticated via `Authorization: Bearer <token>`:
//
//   { action: 'request', actProfileId, bookerProfileId, date, endDate?, message?, offer? }
//       Booker-authed (their magic-link token) OR admin (ADMIN_TOKEN). Creates a
//       Conversation (Status=Booking) + a Booking Request Message, then writes an
//       Availability HOLD on the act. Returns { holdId, conversationId }.
//
//   { action: 'list' }
//       Admin-authed. Returns the pending requests, which ARE the open
//       Marketplace HOLD rows on the Availability hub.
//
//   { action: 'respond', holdId, decision: 'accept' | 'decline' }
//       Admin-authed. accept → the HOLD flips to Booked; decline → the HOLD is
//       deleted. Either way the linked Conversation + a Booking Response Message
//       are updated.
//
// Why HOLD rows are the pending-request store: api/profiles.js already reads the
// Availability hub by `Availability Type` (Hold = soft flag, Booked = blocking),
// independent of `Source`. So a marketplace Hold surfaces as "Free (hold)" in
// search the moment it is written, and disappears (Booked = hidden on the date)
// the moment it is accepted — with NO change to the read path.
//
// Why these rows are cron-safe: the HOLD/Booked rows carry Source =
// 'Marketplace Booking', a tag no calendar-sync connector owns. reconcile() in
// api/calendar-sync.js only ever deletes rows whose Source equals a connector's
// own tag (calendar-sync.js:307), so the 6-hourly sync never touches them. The
// 'Marketplace Booking' Source option is created on first write via typecast.
//
// See 01_CURRENT_STATE.md Open Item #2 (booking origination, the marketplace
// transaction). TAD/admin is the confirmer in v1; act-confirm comes later.

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

// Table IDs are single-base constants (read from the live StageLink base). The
// Profiles default mirrors the other four handlers; override via the env var.
const PROFILES_TABLE_ID     = process.env.AIRTABLE_PROFILES_TABLE_ID || 'tblse7dXJfUjvEWQa';
const AVAILABILITY_TABLE_ID = 'tblxJ9U0Anai6911A';
const CONVERSATIONS_TABLE_ID = 'tblnTFgm1mc3RQESv';
const MESSAGES_TABLE_ID     = 'tbl4fCSBIDubx6PvC';

const MARKETPLACE_SOURCE = 'Marketplace Booking';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, ADMIN_TOKEN } = process.env;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const env = { token: AIRTABLE_API_TOKEN, base: AIRTABLE_BASE_ID };
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const isAdmin = !!ADMIN_TOKEN && bearer === ADMIN_TOKEN;
  const action = (req.body && req.body.action) || '';

  try {
    if (action === 'request') return await handleRequest(req, res, env, bearer, isAdmin);
    if (action === 'list')    return await handleList(req, res, env, isAdmin);
    if (action === 'respond') return await handleRespond(req, res, env, isAdmin);
    return res.status(400).json({ error: 'Unknown or missing action' });
  } catch (err) {
    console.error('bookings handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// --- action: request --------------------------------------------------------
async function handleRequest(req, res, env, bearer, isAdmin) {
  const { actProfileId, bookerProfileId, date, endDate, message, offer } = req.body;
  if (!actProfileId) return res.status(400).json({ error: 'Missing actProfileId' });
  if (!date)         return res.status(400).json({ error: 'Missing date' });

  // Resolve the booker. A non-admin must present their own magic-link token; we
  // resolve the booker FROM that token so a client cannot spoof another profile.
  let booker;
  if (isAdmin) {
    if (!bookerProfileId) return res.status(400).json({ error: 'Admin request needs bookerProfileId' });
    booker = await getProfile(env, bookerProfileId);
  } else {
    if (!/^[A-Za-z0-9]{6,32}$/.test(bearer)) return res.status(401).json({ error: 'Authentication required' });
    booker = await getProfileByToken(env, bearer);
    if (!booker) return res.status(401).json({ error: 'Invalid token' });
  }
  if (!booker) return res.status(404).json({ error: 'Booker profile not found' });

  const act = await getProfile(env, actProfileId);
  if (!act) return res.status(404).json({ error: 'Act profile not found' });
  if (act.id === booker.id) return res.status(400).json({ error: 'You cannot book yourself' });

  const actName = act.name || 'this act';
  const bookerName = booker.name || 'A booker';
  const end = endDate || date;
  const offerText = offer ? `Offer: ${offer}` : '';
  const msgText = (message && message.trim())
    || `${bookerName} would like to book ${actName} for ${date}${end !== date ? `–${end}` : ''}.`;
  const notes = [msgText, offerText].filter(Boolean).join('\n');

  // 1) Conversation FIRST — we read its real record id back before referencing it.
  const convRec = await airtableCreate(env, CONVERSATIONS_TABLE_ID, {
    'Conversation Label': `${bookerName} ↔ ${actName}`,
    'Status': 'Booking',
    'Participant 1': [booker.id],
    'Participant 2': [act.id],
    'Last Message Preview': msgText.slice(0, 100),
    'Last Message Time': new Date().toISOString(),
    'Unread Count P2': 1,
  });
  const conversationId = convRec.id;

  // 2) Booking Request message, linked to the real conversation id.
  await airtableCreate(env, MESSAGES_TABLE_ID, {
    'Message ID': `Booking Request — ${actName} — ${date}`,
    'Conversation': [conversationId],
    'Sender': [booker.id],
    'Body': msgText,
    'Message Type': 'Booking Request',
    'Booking Snapshot': JSON.stringify({ actProfileId: act.id, actName, bookerName, date, endDate: end, offer: offer || null }),
    'Sent At': new Date().toISOString(),
    'Is Read': false,
  });

  // 3) The HOLD on the act's hub. typecast lets the 'Marketplace Booking' Source
  //    option self-create on first write (no manual schema step). Engagement
  //    Reference = the conversation id is the join key used by respond/list.
  const holdRec = await airtableCreate(env, AVAILABILITY_TABLE_ID, {
    'Record Label': `${actName} — ${date} — Hold (Marketplace)`,
    'Profile': [act.id],
    'Start Date': date,
    'End Date': end,
    'Availability Type': 'Hold',
    'Source': MARKETPLACE_SOURCE,
    'Updated By': bookerName,
    'Cruise Line / Venue': bookerName,
    'Engagement Reference': conversationId,
    'Notes': notes,
  }, true);

  return res.status(201).json({ success: true, holdId: holdRec.id, conversationId });
}

// --- action: list (admin) ---------------------------------------------------
async function handleList(req, res, env, isAdmin) {
  if (!isAdmin) return res.status(401).json({ error: 'Admin authentication required' });

  const formula = `AND({Source}='${MARKETPLACE_SOURCE}',{Availability Type}='Hold')`;
  const rows = await airtableList(env, AVAILABILITY_TABLE_ID, formula);

  // Resolve act display names in one batched query.
  const actIds = [...new Set(rows.map(r => (r.fields['Profile'] || [])[0]).filter(Boolean))];
  const nameById = await getProfileNames(env, actIds);

  const requests = rows.map(r => {
    const f = r.fields;
    const actId = (f['Profile'] || [])[0] || null;
    return {
      holdId: r.id,
      actId,
      actName: (actId && nameById[actId]) || (f['Record Label'] || '').split(' — ')[0] || 'Act',
      bookerName: f['Updated By'] || f['Cruise Line / Venue'] || 'Booker',
      start: f['Start Date'] || null,
      end: f['End Date'] || null,
      notes: f['Notes'] || '',
      conversationId: f['Engagement Reference'] || null,
    };
  }).sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  return res.status(200).json({ requests });
}

// --- action: respond (admin) ------------------------------------------------
async function handleRespond(req, res, env, isAdmin) {
  if (!isAdmin) return res.status(401).json({ error: 'Admin authentication required' });
  const { holdId, decision } = req.body;
  if (!holdId) return res.status(400).json({ error: 'Missing holdId' });
  if (decision !== 'accept' && decision !== 'decline') {
    return res.status(400).json({ error: "decision must be 'accept' or 'decline'" });
  }

  const hold = await getRecord(env, AVAILABILITY_TABLE_ID, holdId);
  if (!hold) return res.status(404).json({ error: 'Hold not found' });
  const hf = hold.fields;
  if ((hf['Source'] && (hf['Source'].name || hf['Source'])) !== MARKETPLACE_SOURCE) {
    return res.status(400).json({ error: 'Not a marketplace hold' });
  }
  const conversationId = hf['Engagement Reference'] || null;
  const actId = (hf['Profile'] || [])[0] || null;
  const label = hf['Record Label'] || 'Booking';

  if (decision === 'accept') {
    await airtableUpdate(env, AVAILABILITY_TABLE_ID, holdId, {
      'Availability Type': 'Booked',
      'Record Label': label.replace(/Hold \(Marketplace\)$/, 'Booked (Marketplace)'),
    });
  } else {
    await airtableDelete(env, AVAILABILITY_TABLE_ID, holdId);
  }

  if (conversationId) {
    await airtableUpdate(env, CONVERSATIONS_TABLE_ID, conversationId, {
      'Status': decision === 'accept' ? 'Confirmed' : 'Closed',
      'Last Message Preview': decision === 'accept' ? 'Booking confirmed.' : 'Request declined.',
      'Last Message Time': new Date().toISOString(),
    });
    await airtableCreate(env, MESSAGES_TABLE_ID, {
      'Message ID': `Booking Response — ${decision}`,
      'Conversation': [conversationId],
      ...(actId ? { 'Sender': [actId] } : {}),
      'Body': decision === 'accept'
        ? 'Booking confirmed via StageLink365. This date is now held as Booked.'
        : 'This booking request was declined. The hold has been released.',
      'Message Type': 'Booking Response',
      'Sent At': new Date().toISOString(),
      'Is Read': false,
    });
  }

  return res.status(200).json({ success: true, holdId, decision });
}

// --- Airtable helpers -------------------------------------------------------
async function airtableCreate(env, tableId, fields, typecast) {
  const body = { fields };
  if (typecast) body.typecast = true;
  const resp = await fetch(`${AIRTABLE_BASE_URL}/${env.base}/${tableId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Airtable create ${tableId} ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

async function airtableUpdate(env, tableId, recordId, fields) {
  const resp = await fetch(`${AIRTABLE_BASE_URL}/${env.base}/${tableId}/${recordId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${env.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`Airtable update ${tableId} ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

async function airtableDelete(env, tableId, recordId) {
  const resp = await fetch(`${AIRTABLE_BASE_URL}/${env.base}/${tableId}/${recordId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${env.token}` },
  });
  if (!resp.ok) throw new Error(`Airtable delete ${tableId} ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

async function airtableList(env, tableId, formula) {
  const url = new URL(`${AIRTABLE_BASE_URL}/${env.base}/${tableId}`);
  url.searchParams.set('filterByFormula', formula);
  url.searchParams.set('pageSize', '100');
  const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${env.token}` } });
  if (!resp.ok) throw new Error(`Airtable list ${tableId} ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  return data.records || [];
}

async function getRecord(env, tableId, recordId) {
  const resp = await fetch(`${AIRTABLE_BASE_URL}/${env.base}/${tableId}/${recordId}`, {
    headers: { 'Authorization': `Bearer ${env.token}` },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function getProfile(env, id) {
  const rec = await getRecord(env, PROFILES_TABLE_ID, id);
  if (!rec) return null;
  return { id: rec.id, name: rec.fields['Display Name'] || '' };
}

async function getProfileByToken(env, token) {
  const formula = `{Magic Link Token}='${token}'`;
  const url = new URL(`${AIRTABLE_BASE_URL}/${env.base}/${PROFILES_TABLE_ID}`);
  url.searchParams.set('filterByFormula', formula);
  url.searchParams.set('maxRecords', '1');
  const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${env.token}` } });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.records || !data.records.length) return null;
  const r = data.records[0];
  return { id: r.id, name: r.fields['Display Name'] || '' };
}

async function getProfileNames(env, ids) {
  const out = {};
  if (!ids.length) return out;
  const clause = ids.map(id => `RECORD_ID()='${id}'`).join(',');
  const formula = ids.length === 1 ? clause : `OR(${clause})`;
  const rows = await airtableList(env, PROFILES_TABLE_ID, formula);
  for (const r of rows) out[r.id] = r.fields['Display Name'] || '';
  return out;
}
