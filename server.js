require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const XLSX = require('xlsx');
const webpush = require('web-push');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:info@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const app = express();
app.use(express.json({ limit: '20mb' })); // foto's en Excel-import zijn base64, dus ruim genoeg limiet
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
});

const JWT_SECRET = process.env.JWT_SECRET || 'verander-deze-waarde';
const SETUP_KEY = process.env.SETUP_KEY || 'verander-deze-waarde-ook';

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      naam TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'plaatser',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS deliveries(
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS photos(
      id SERIAL PRIMARY KEY,
      delivery_id TEXT REFERENCES deliveries(id) ON DELETE CASCADE,
      naam TEXT,
      data_url TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS locations(
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS app_settings(
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions(
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS teams(
      id SERIAL PRIMARY KEY,
      naam TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS team_members(
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS producten(
      naam TEXT PRIMARY KEY,
      opmerking TEXT,
      motor_type TEXT,
      aantal_motors INTEGER,
      verlengkabel_standaard INTEGER,
      verlengkabel_dubbel INTEGER,
      pinnen INTEGER,
      zandzakken INTEGER,
      valmatten INTEGER,
      overige TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, naam: user.naam, rol: user.rol },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

let idCounter = 0;
function genId() {
  idCounter++;
  return 'd' + Date.now().toString(36) + idCounter.toString(36) + Math.random().toString(36).slice(2, 6);
}

function emptyDeliveryServer() {
  return {
    id: genId(),
    klant: '', telefoon: '', email: '', adres: '', postcode: '', ondergrond: '',
    datum: '', tijdslot: '',
    afhaaldatum: '', afhaaltijd: '',
    artikelen: '', bedrag: '', boekingsnummer: '',
    status: 'te-leveren',
    toegewezenAan: null,
    toegewezenAanAfhaling: null,
    handmatigeVolgordeLevering: null,
    handmatigeVolgordeAfhaling: null,
    plaatsing: {
      correctGeplaatst: false, bevestiging: '', valmatten: false, verlengkabel: false,
      aantalKabels: '', aantalZandzakken: '', netjes: false, opmerkingen: '', tijdstip: '', bevestigd: false, bevestigdOp: ''
    },
    betaling: { status: '', opmerking: '' },
    afhaling: {
      valmattenTerug: false, kabelsTerug: false, bevestigingTerug: false, natOfVuil: false, reinigingNodig: false,
      opmerkingen: '', tijdstip: '', bevestigd: false, bevestigdOp: '',
      verzetAangevraagd: false, verzetNaarDatum: '', verzetReden: ''
    }
  };
}

function normalizeDate(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}
function normalizeTime(v) {
  if (!v) return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return m[1].padStart(2, '0') + ':' + m[2];
  return s;
}
function normalizeOndergrond(v) {
  if (!v) return '';
  const s = String(v).toLowerCase();
  if (s.includes('hard')) return 'Harde ondergrond';
  if (s.includes('gras') || s.includes('grass')) return 'Op gras';
  if (s.includes('no selection') || s.includes('n/a') || s.includes('none')) return '';
  return v;
}
function getField(row, ...names) {
  for (const key of Object.keys(row)) {
    const norm = key.trim().toLowerCase();
    if (names.some(n => n.toLowerCase() === norm)) {
      const v = row[key];
      return v === undefined || v === null ? '' : String(v).trim();
    }
  }
  return '';
}

// ---------- Dropbox (optionele automatische kopie van foto's) ----------
function sanitizeForPath(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-') || 'onbekend';
}
let dropboxAccessToken = null;
let dropboxTokenExpiry = 0;
async function getDropboxAccessToken() {
  if (!process.env.DROPBOX_APP_KEY || !process.env.DROPBOX_APP_SECRET || !process.env.DROPBOX_REFRESH_TOKEN) return null;
  if (dropboxAccessToken && Date.now() < dropboxTokenExpiry - 60000) return dropboxAccessToken;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
    client_id: process.env.DROPBOX_APP_KEY,
    client_secret: process.env.DROPBOX_APP_SECRET
  });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!r.ok) throw new Error('Dropbox token-vernieuwing mislukt (' + r.status + ')');
  const json = await r.json();
  dropboxAccessToken = json.access_token;
  dropboxTokenExpiry = Date.now() + json.expires_in * 1000;
  return dropboxAccessToken;
}
async function uploadToDropbox(dropboxPath, buffer) {
  const token = await getDropboxAccessToken();
  if (!token) return; // Dropbox niet geconfigureerd: gewoon overslaan
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'add', autorename: true, mute: true }),
      'Content-Type': 'application/octet-stream'
    },
    body: buffer
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error('Dropbox-upload mislukt (' + r.status + '): ' + text);
  }
}

// ---------- E-mail versturen via Resend (optioneel) ----------
function escapeHtmlServer(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    const err = new Error('E-mail verzenden is niet geconfigureerd');
    err.notConfigured = true;
    throw err;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL, to, subject, html })
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error('Verzenden mislukt (' + r.status + '): ' + text);
  }
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Sessie verlopen, log opnieuw in' });
  }
}
function adminOnly(req, res, next) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Enkel voor administrators' });
  next();
}

// ---------- Eerste installatie ----------
app.get('/api/setup-status', async (req, res) => {
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  res.json({ needsSetup: r.rows[0].c === 0 });
});

app.post('/api/setup', async (req, res) => {
  const { setupKey, username, password, naam } = req.body || {};
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (r.rows[0].c > 0) return res.status(400).json({ error: 'Installatie is al uitgevoerd' });
  if (setupKey !== SETUP_KEY) return res.status(403).json({ error: 'Verkeerde installatiecode' });
  if (!username || !password || !naam) return res.status(400).json({ error: 'Vul alle velden in' });
  const hash = await bcrypt.hash(password, 10);
  const ins = await pool.query(
    'INSERT INTO users(username,password_hash,naam,rol) VALUES ($1,$2,$3,$4) RETURNING id,username,naam,rol',
    [username, hash, naam, 'admin']
  );
  const user = ins.rows[0];
  res.json({ token: signToken(user), user });
});

// ---------- Login ----------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  if (r.rows.length === 0) return res.status(401).json({ error: 'Onbekende gebruiker' });
  const user = r.rows[0];
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Verkeerd wachtwoord' });
  res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, naam: user.naam, rol: user.rol }
  });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// ---------- Gebruikersbeheer (enkel admin) ----------
app.get('/api/users', auth, adminOnly, async (req, res) => {
  const r = await pool.query('SELECT id,username,naam,rol,created_at FROM users ORDER BY naam');
  res.json(r.rows);
});
app.post('/api/users', auth, adminOnly, async (req, res) => {
  const { username, password, naam, rol } = req.body || {};
  if (!username || !password || !naam) return res.status(400).json({ error: 'Vul alle velden in' });
  const hash = await bcrypt.hash(password, 10);
  try {
    const ins = await pool.query(
      'INSERT INTO users(username,password_hash,naam,rol) VALUES ($1,$2,$3,$4) RETURNING id,username,naam,rol',
      [username, hash, naam, rol === 'admin' ? 'admin' : 'plaatser']
    );
    res.json(ins.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Gebruikersnaam bestaat al' });
    res.status(500).json({ error: 'Kon gebruiker niet aanmaken' });
  }
});
app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  if (String(req.user.id) === req.params.id) return res.status(400).json({ error: 'Je kan jezelf niet verwijderen' });
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Leveringen (gedeelde planning, iedereen ziet alles) ----------
app.get('/api/deliveries', auth, async (req, res) => {
  const r = await pool.query('SELECT data FROM deliveries ORDER BY updated_at DESC');
  res.json(r.rows.map(row => row.data));
});
app.post('/api/deliveries', auth, async (req, res) => {
  const d = req.body;
  if (!d || !d.id) return res.status(400).json({ error: 'Ongeldige levering' });
  await pool.query('INSERT INTO deliveries(id, data, created_by) VALUES ($1,$2,$3)', [d.id, d, req.user.id]);
  res.json({ ok: true });
});
app.put('/api/deliveries/:id', auth, async (req, res) => {
  const d = req.body;
  await pool.query('UPDATE deliveries SET data=$1, updated_at=now() WHERE id=$2', [d, req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/deliveries/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM deliveries WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Excel-import van de planning ----------
app.post('/api/import', auth, adminOnly, async (req, res) => {
  const { fileBase64 } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: 'Geen bestand ontvangen' });

  let rows;
  try {
    const buf = Buffer.from(fileBase64, 'base64');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Kon het Excel-bestand niet lezen. Is het een geldig .xlsx-bestand?' });
  }

  let imported = 0;
  let updated = 0;
  const skipped = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const klant = getField(row, 'Customer Name', 'Klant', 'Naam');
    const adres1 = getField(row, 'Delivery Address 1', 'Adres', 'Address');
    if (!klant && !adres1) continue; // lege rij, geen fout

    if (!klant) {
      skipped.push({ rij: i + 2, reden: 'Klantnaam ontbreekt' });
      continue;
    }

    const stad = getField(row, 'Delivery Town', 'Gemeente', 'Town');
    const postcode = getField(row, 'Delivery Postcode', 'Postcode');
    const adres = [adres1, [postcode, stad].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const boekingsnummer = getField(row, 'Booking ID', 'Booking Number', 'Boekingsnummer', 'Booking Nr', 'Order Number', 'Ordernummer', 'Reference', 'Referentie', 'Boeking');

    const d = emptyDeliveryServer();
    d.klant = klant;
    d.telefoon = getField(row, 'Mobile', 'Telefoon', 'Tel');
    d.email = getField(row, 'Email', 'E-mail');
    d.adres = adres;
    d.postcode = postcode;
    d.ondergrond = normalizeOndergrond(getField(row, 'Surface', 'Ondergrond'));
    if (d.ondergrond === 'Harde ondergrond') d.plaatsing.valmatten = true;
    d.datum = normalizeDate(getField(row, 'Delivery Date', 'Leverdatum'));
    d.tijdslot = normalizeTime(getField(row, 'Drop Off', 'Levertijd'));
    d.afhaaldatum = normalizeDate(getField(row, 'Collection Date', 'Afhaaldatum'));
    d.afhaaltijd = normalizeTime(getField(row, 'Collection', 'Afhaaltijd'));
    d.artikelen = getField(row, 'Item', 'Artikelen');
    d.bedrag = getField(row, 'Balance', 'Bedrag', 'Saldo');
    if (d.bedrag && parseFloat(d.bedrag.replace(',', '.')) === 0) {
      d.betaling.status = 'reeds-voldaan';
    }
    d.boekingsnummer = boekingsnummer;
    d.plaatsing.tijdstip = '';

    try {
      let existing = null;
      if (boekingsnummer) {
        const r = await pool.query("SELECT id, data FROM deliveries WHERE data->>'boekingsnummer' = $1 AND data->>'boekingsnummer' <> ''", [boekingsnummer]);
        if (r.rows.length > 0) existing = r.rows[0];
      }
      if (!existing && d.klant && d.datum && d.artikelen) {
        // Vangnet: geen (herkend) boekingsnummer, of het verschilt van eerdere imports.
        // Toch dezelfde klant + leverdatum + artikelen? Dan gaan we ervan uit dat het om
        // dezelfde boeking gaat (bv. andere export/bron met een andere boekingsnummer-opmaak),
        // om dubbele reservaties te vermijden.
        const r2 = await pool.query(
          `SELECT id, data FROM deliveries
           WHERE lower(trim(data->>'klant')) = lower(trim($1))
             AND data->>'datum' = $2
             AND lower(trim(data->>'artikelen')) = lower(trim($3))`,
          [d.klant, d.datum, d.artikelen]
        );
        if (r2.rows.length > 0) existing = r2.rows[0];
      }
      if (existing) {
        // Boeking bestaat al: enkel de planninggegevens bijwerken, checklists/status/toewijzing blijven behouden
        const merged = {
          ...existing.data,
          klant: d.klant, telefoon: d.telefoon, email: d.email, adres: d.adres, postcode: d.postcode,
          ondergrond: d.ondergrond, datum: d.datum, tijdslot: d.tijdslot, afhaaldatum: d.afhaaldatum,
          afhaaltijd: d.afhaaltijd, artikelen: d.artikelen, bedrag: d.bedrag,
          boekingsnummer: d.boekingsnummer || existing.data.boekingsnummer
        };
        await pool.query('UPDATE deliveries SET data=$1, updated_at=now() WHERE id=$2', [merged, existing.id]);
        updated++;
      } else {
        await pool.query('INSERT INTO deliveries(id, data, created_by) VALUES ($1,$2,$3)', [d.id, d, req.user.id]);
        imported++;
      }
    } catch (e) {
      skipped.push({ rij: i + 2, reden: 'Kon niet opgeslagen worden' });
    }
  }

  res.json({ imported, updated, skipped });
});

// ---------- Foto's ----------
app.get('/api/deliveries/:id/photos', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id, naam, data_url AS "dataUrl" FROM photos WHERE delivery_id=$1 ORDER BY id',
    [req.params.id]
  );
  res.json(r.rows);
});
app.post('/api/deliveries/:id/photos', auth, async (req, res) => {
  const { naam, dataUrl } = req.body || {};
  const ins = await pool.query(
    'INSERT INTO photos(delivery_id, naam, data_url) VALUES ($1,$2,$3) RETURNING id, naam, data_url AS "dataUrl"',
    [req.params.id, naam || '', dataUrl]
  );
  const photo = ins.rows[0];
  res.json(photo);

  // Best-effort kopie naar Dropbox, ná het antwoord — mag de app nooit vertragen of blokkeren
  (async () => {
    try {
      const delRes = await pool.query('SELECT data FROM deliveries WHERE id=$1', [req.params.id]);
      if (delRes.rows.length === 0) return;
      const delivery = delRes.rows[0].data;
      const base64 = (dataUrl || '').split(',')[1];
      if (!base64) return;
      const buffer = Buffer.from(base64, 'base64');
      const folder = sanitizeForPath(delivery.datum || 'ongedateerd') + '_' + sanitizeForPath(delivery.klant);
      const dropboxPath = '/' + folder + '/foto-' + photo.id + '.jpg';
      await uploadToDropbox(dropboxPath, buffer);
    } catch (e) {
      console.error('Dropbox-kopie mislukt:', e.message);
    }
  })();
});
app.delete('/api/deliveries/:deliveryId/photos/:photoId', auth, async (req, res) => {
  await pool.query('DELETE FROM photos WHERE id=$1 AND delivery_id=$2', [req.params.photoId, req.params.deliveryId]);
  res.json({ ok: true });
});

// ---------- Locatie (enkel tijdens gebruik van de app, geen achtergrond-tracking) ----------
app.post('/api/location', auth, async (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Ongeldige locatie' });
  await pool.query(
    `INSERT INTO locations(user_id, lat, lng, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (user_id) DO UPDATE SET lat=$2, lng=$3, updated_at=now()`,
    [req.user.id, lat, lng]
  );
  res.json({ ok: true });
});
app.get('/api/locations', auth, adminOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.naam, l.lat, l.lng, l.updated_at
     FROM locations l JOIN users u ON u.id = l.user_id
     ORDER BY l.updated_at DESC`
  );
  res.json(r.rows);
});

// ---------- Instellingen (bv. Google review-link) ----------
app.get('/api/settings', auth, async (req, res) => {
  const r = await pool.query('SELECT key, value FROM app_settings');
  const settings = {};
  r.rows.forEach(row => { settings[row.key] = row.value; });
  res.json(settings);
});
app.put('/api/settings', auth, adminOnly, async (req, res) => {
  const updates = req.body || {};
  for (const key of Object.keys(updates)) {
    await pool.query(
      `INSERT INTO app_settings(key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=$2`,
      [key, updates[key]]
    );
  }
  res.json({ ok: true });
});

app.post('/api/deliveries/:id/send-review-email', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM deliveries WHERE id=$1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Levering niet gevonden' });
    const d = r.rows[0].data;
    if (!d.email) return res.status(400).json({ error: 'Geen e-mailadres bekend voor deze klant' });

    const settingsRes = await pool.query("SELECT value FROM app_settings WHERE key='googleReviewUrl'");
    const reviewUrl = settingsRes.rows[0] ? settingsRes.rows[0].value : '';
    if (!reviewUrl) return res.status(400).json({ error: 'Stel eerst een Google review-link in bij Team → Instellingen' });

    const klant = escapeHtmlServer(d.klant);
    const html = `<p>Hallo ${klant},</p>
      <p>Bedankt om voor Belair-Fun te kiezen! Zou je ons een Google review willen geven?</p>
      <p><a href="${reviewUrl}">${reviewUrl}</a></p>
      <p>Met vriendelijke groeten,<br>Belair-Fun</p>`;

    await sendEmail(d.email, 'Bedankt van Belair-Fun!', html);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.notConfigured ? 501 : 502).json({ error: e.message, notConfigured: !!e.notConfigured });
  }
});

// ---------- Push-meldingen ----------
app.get('/api/push/public-key', auth, (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});
app.post('/api/push/subscribe', auth, async (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Ongeldig abonnement' });
  }
  await pool.query(
    `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, p256dh=$3, auth=$4`,
    [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  );
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
  res.json({ ok: true });
});

// ---------- Voertuigteams ----------
app.get('/api/my-teams', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT t.id, t.naam FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = $1`,
    [req.user.id]
  );
  res.json(r.rows);
});
app.put('/api/my-team', auth, async (req, res) => {
  const { teamId } = req.body || {};
  await pool.query('DELETE FROM team_members WHERE user_id=$1', [req.user.id]);
  if (teamId) {
    await pool.query('INSERT INTO team_members(team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [teamId, req.user.id]);
  }
  res.json({ ok: true });
});

app.get('/api/teams', auth, async (req, res) => {
  const teamsRes = await pool.query('SELECT id, naam FROM teams ORDER BY naam');
  const membersRes = await pool.query(
    `SELECT tm.team_id, u.id, u.naam FROM team_members tm JOIN users u ON u.id = tm.user_id`
  );
  const byTeam = {};
  membersRes.rows.forEach(r => {
    if (!byTeam[r.team_id]) byTeam[r.team_id] = [];
    byTeam[r.team_id].push({ id: r.id, naam: r.naam });
  });
  res.json(teamsRes.rows.map(t => ({ id: t.id, naam: t.naam, leden: byTeam[t.id] || [] })));
});
app.post('/api/teams', auth, adminOnly, async (req, res) => {
  const { naam, memberIds } = req.body || {};
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht' });
  const ins = await pool.query('INSERT INTO teams(naam) VALUES ($1) RETURNING id', [naam]);
  const teamId = ins.rows[0].id;
  for (const uid of (memberIds || [])) {
    await pool.query('INSERT INTO team_members(team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [teamId, uid]);
  }
  res.json({ ok: true, id: teamId });
});
app.put('/api/teams/:id', auth, adminOnly, async (req, res) => {
  const { naam, memberIds } = req.body || {};
  if (naam) await pool.query('UPDATE teams SET naam=$1 WHERE id=$2', [naam, req.params.id]);
  if (Array.isArray(memberIds)) {
    await pool.query('DELETE FROM team_members WHERE team_id=$1', [req.params.id]);
    for (const uid of memberIds) {
      await pool.query('INSERT INTO team_members(team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, uid]);
    }
  }
  res.json({ ok: true });
});
app.delete('/api/teams/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM teams WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Materiaal-databank (standaardinfo per product, bv. voor laadlijsten) ----------
app.get('/api/producten', auth, async (req, res) => {
  const r = await pool.query(`
    SELECT naam, opmerking, motor_type AS "motorType", aantal_motors AS "aantalMotors",
      verlengkabel_standaard AS "verlengkabelStandaard", verlengkabel_dubbel AS "verlengkabelDubbel",
      pinnen, zandzakken, valmatten, overige
    FROM producten ORDER BY naam
  `);
  res.json(r.rows);
});
app.post('/api/producten', auth, adminOnly, async (req, res) => {
  const { naam, opmerking, motorType, aantalMotors, verlengkabelStandaard, verlengkabelDubbel, pinnen, zandzakken, valmatten, overige } = req.body || {};
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht' });
  const n = v => (v === '' || v === undefined || v === null) ? null : parseInt(v, 10);
  await pool.query(
    `INSERT INTO producten(naam, opmerking, motor_type, aantal_motors, verlengkabel_standaard, verlengkabel_dubbel, pinnen, zandzakken, valmatten, overige, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     ON CONFLICT (naam) DO UPDATE SET opmerking=$2, motor_type=$3, aantal_motors=$4, verlengkabel_standaard=$5, verlengkabel_dubbel=$6, pinnen=$7, zandzakken=$8, valmatten=$9, overige=$10, updated_at=now()`,
    [naam.trim(), opmerking || '', motorType || null, n(aantalMotors), n(verlengkabelStandaard), n(verlengkabelDubbel), n(pinnen), n(zandzakken), n(valmatten), overige || '']
  );
  res.json({ ok: true });
});
app.delete('/api/producten', auth, adminOnly, async (req, res) => {
  const { naam } = req.body || {};
  if (naam) await pool.query('DELETE FROM producten WHERE naam=$1', [naam]);
  res.json({ ok: true });
});
app.post('/api/producten/import', auth, adminOnly, async (req, res) => {
  const { fileBase64 } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: 'Geen bestand ontvangen' });
  let rows;
  try {
    const buf = Buffer.from(fileBase64, 'base64');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: '', header: 1 });
  } catch (e) {
    return res.status(400).json({ error: 'Kon het Excel-bestand niet lezen.' });
  }
  const n = v => (v === '' || v === undefined || v === null) ? null : parseInt(v, 10);
  let imported = 0;
  const skipped = [];
  // Zoek de headerrij (bevat 'Motor Type' in een van de kolommen)
  let headerIdx = rows.findIndex(r => r.some(c => String(c).toLowerCase().includes('motor type')));
  if (headerIdx === -1) headerIdx = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const naam = row[0] ? String(row[0]).trim() : '';
    if (!naam) continue;
    try {
      await pool.query(
        `INSERT INTO producten(naam, motor_type, aantal_motors, verlengkabel_standaard, verlengkabel_dubbel, pinnen, zandzakken, valmatten, overige, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (naam) DO UPDATE SET motor_type=$2, aantal_motors=$3, verlengkabel_standaard=$4, verlengkabel_dubbel=$5, pinnen=$6, zandzakken=$7, valmatten=$8, overige=$9, updated_at=now()`,
        [naam, row[1] ? String(row[1]).trim() : null, n(row[2]), n(row[3]), n(row[4]), n(row[5]), n(row[6]), n(row[7]), row[8] ? String(row[8]).trim() : '']
      );
      imported++;
    } catch (e) {
      skipped.push({ rij: i + 1, reden: 'Kon niet opgeslagen worden' });
    }
  }
  res.json({ imported, skipped });
});

// ---------- Handmatig een melding versturen ----------
app.post('/api/notify', auth, adminOnly, async (req, res) => {
  const { teamId, userId, title, message } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: 'Titel en bericht zijn verplicht' });
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(501).json({ error: 'Push-meldingen zijn niet geconfigureerd (VAPID-sleutels ontbreken)' });
  }

  let userIds = [];
  if (teamId) {
    const r = await pool.query('SELECT user_id FROM team_members WHERE team_id=$1', [teamId]);
    userIds = r.rows.map(row => row.user_id);
  } else if (userId) {
    userIds = [userId];
  } else {
    return res.status(400).json({ error: 'Kies een team of een teamlid' });
  }
  if (userIds.length === 0) return res.status(400).json({ error: 'Dit team heeft geen leden' });

  const subsRes = await pool.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::int[])`,
    [userIds]
  );

  let sent = 0, failed = 0;
  for (const sub of subsRes.rows) {
    const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(pushSub, JSON.stringify({ title, message }));
      sent++;
    } catch (e) {
      failed++;
      if (e.statusCode === 404 || e.statusCode === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]);
      }
    }
  }
  res.json({ sent, failed, ontvangers: userIds.length });
});

// ---------- Koppeling met WordPress-website (beschikbaarheid) ----------
app.post('/api/sync-website', auth, adminOnly, async (req, res) => {
  const siteUrl = process.env.WORDPRESS_SITE_URL;
  const syncKey = process.env.WORDPRESS_SYNC_SECRET;
  if (!siteUrl || !syncKey) {
    return res.status(501).json({ error: 'Website-koppeling is nog niet geconfigureerd (WORDPRESS_SITE_URL / WORDPRESS_SYNC_SECRET ontbreken bij Render)' });
  }
  const fullSync = !!(req.body && req.body.fullSync);

  const r = await pool.query(`SELECT data FROM deliveries`);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const bookings = r.rows
    .map(row => row.data)
    .filter(d => d.datum && d.datum >= cutoffStr && d.artikelen)
    .map(d => ({
      booking_id: d.boekingsnummer || d.id,
      item: d.artikelen,
      delivery_date: d.datum,
      collection_date: d.afhaaldatum || d.datum
    }));

  try {
    const wpRes = await fetch(siteUrl.replace(/\/$/, '') + '/wp-json/belair/v1/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Belair-Sync-Key': syncKey },
      body: JSON.stringify({ bookings, full_sync: fullSync })
    });
    const wpData = await wpRes.json().catch(() => null);
    if (!wpRes.ok || !wpData) {
      return res.status(502).json({ error: 'Website antwoordde met een fout (' + wpRes.status + ')', detail: wpData });
    }
    res.json({ verstuurd: bookings.length, ...wpData });
  } catch (e) {
    res.status(502).json({ error: 'Kon de website niet bereiken: ' + e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log('Belair-Fun API draait op poort ' + PORT)))
  .catch(err => {
    console.error('Kon database niet initialiseren:', err);
    process.exit(1);
  });
