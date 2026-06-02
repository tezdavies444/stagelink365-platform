// GET /api/ics?token={magic-link-token}
//
// StageLink365 — per-performer availability feed (iCal / ICS).
//
// The first surface of the "SL365 exposes availability, clients PULL it" model
// (decision record strategy/calendar-sync/DECISION-2026-06-02-avails-pull-not-push.md).
// SL365 is the canonical hub; this handler turns a performer's magic-link token
// into a subscribable calendar of the dates they are NOT free, so any client —
// on Google Calendar, Apple, Outlook, or anything that reads ICS — can pull it
// without SL365 ever writing into their system. Clean URL via middleware.js:
// /calendar/{token}.ics  ->  /api/ics?token={token}.
//
// READ-ONLY. Talks only to the StageLink base (AIRTABLE_BASE_ID); no writes, no
// schema change. Auth is the existing magic-link token (same field + format the
// platform already uses); the token IS the access key, so no other gate.
//
// PRIVACY: the feed is meant to be shareable with clients, so each blocked day
// is published with a GENERIC summary (the block type only — "Unavailable" /
// "Booked" / "Hold"), never the venue/gig detail. A subscriber learns the person
// is unavailable, not where they are. The detailed itinerary stays on the
// performer's own human calendar view at calendar.stagelink365.com/c/{token}.
//
// Field-name strings are hardcoded as constants (per-handler precedent), matching
// the names api/calendar-sync.js already reads on the same tables.

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

// Blocks only — the dates a performer is NOT free. (No "Available"-type rows are
// emitted.) Membership test, so listing a not-yet-used option like Hold is safe.
const BLOCK_TYPES = new Set(['Booked', 'Unavailable', 'Hold']);
const TOKEN_RE = /^[A-Za-z0-9]{6,32}$/;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const PROFILES_TABLE = process.env.AIRTABLE_PROFILES_TABLE_ID || PROFILES_TABLE_FALLBACK;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const token = String((req.query && req.query.token) || '').trim();
  // Invalid token → 404 (not 400/401) so the feed URL never confirms which
  // tokens exist.
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

    // 2) read this profile's Availability rows (by the inverse-link ids — exact,
    //    the same pattern calendar-sync.js fetchActAvailability() uses).
    const rows = await fetchAvailability(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, availIds);

    // 3) keep blocks only, today-forward (Phoenix, matching the sync's horizon).
    const today = todayInPhoenix();
    const events = [];
    for (const r of rows) {
      const f = r.fields || {};
      const type = selName(f[AVAIL_F.type]);
      if (!BLOCK_TYPES.has(type)) continue;
      const start = f[AVAIL_F.startDate];
      if (!start) continue;
      const end = f[AVAIL_F.endDate] || start;
      if (end < today) continue;          // today-forward only
      events.push({ id: r.id, start, end, summary: type });
    }

    const ics = buildIcs(name, events);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${token}.ics"`);
    return res.status(200).end(ics);
  } catch (err) {
    console.error('ics error:', err);
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

// Build a VCALENDAR of all-day VEVENTs. An empty event list is still a valid
// calendar (it just means "no blocks — fully available").
function buildIcs(name, events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//StageLink365//Availability//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldLine('X-WR-CALNAME:' + icsEscape(`${name} — StageLink365 Availability`)),
    'X-PUBLISHED-TTL:PT6H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
  ];
  const stamp = icsStamp(new Date());
  for (const ev of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.id}@stagelink365.com`,
      `DTSTAMP:${stamp}`,
      // All-day events. ICS DTEND is EXCLUSIVE, so end + 1 day (the exact inverse
      // of the inbound −1 the Google sync applies).
      `DTSTART;VALUE=DATE:${compactDate(ev.start)}`,
      `DTEND;VALUE=DATE:${compactDate(addDays(ev.end, 1))}`,
      foldLine('SUMMARY:' + icsEscape(ev.summary)),
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';   // ICS requires CRLF line endings
}

// RFC 5545 text escaping: backslash, semicolon, comma, newline.
function icsEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold a content line at ≤75 octets (RFC 5545), continuation lines begin with a
// single space. Byte-aware so the em dash (3 bytes) can't push a line over.
function foldLine(line) {
  const MAX = 73; // leave headroom for the continuation space
  let result = '';
  let chunk = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > MAX) {
      result += (result ? '\r\n ' : '') + chunk;
      chunk = ch;
      bytes = b + 1; // the leading space costs one octet on the continuation line
    } else {
      chunk += ch;
      bytes += b;
    }
  }
  return result + (result ? '\r\n ' : '') + chunk;
}

function icsStamp(d) {
  // YYYYMMDDTHHMMSSZ
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function compactDate(dateStr) {
  return dateStr.replace(/-/g, ''); // YYYY-MM-DD → YYYYMMDD
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function todayInPhoenix() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit',
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
