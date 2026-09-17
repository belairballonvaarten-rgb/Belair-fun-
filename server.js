require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const webpush = require('web-push');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:info@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const app = express();
app.use(express.json({ limit: '20mb' })); // foto's zijn base64, dus ruim genoeg limiet
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// STAGE 3 — GEDEELDE DATABANK MET HET BOEKINGSPLATFORM
// ============================================================
// Vanaf hier draait deze app rechtstreeks op DEZELFDE Postgres-databank als
// het boekingsplatform (belair-boekingsplatform) — DATABASE_URL moet dus
// bij Render op die databank wijzen, niet meer op de vroegere, eigen databank
// van deze app. Boekingen/klanten/producten/leveringen/voertuigen bestaan
// enkel nog daar; deze app maakt ze niet meer zelf aan en schrijft er ook
// nooit een nieuwe boeking (reservatie) in weg — dat blijft uitsluitend een
// taak van het boekingsplatform. Wat hier wél nog leeft, is puur
// app-specifiek: gebruikers/login, push-abonnementen, instellingen en
// live-locatie tijdens gebruik.
//
// De oude, eigen tabellen van deze app (deliveries, photos, teams,
// team_members, en zijn eigen 'producten'-kopie) worden hier bewust NIET
// meer aangemaakt of gebruikt. Bestaan ze nog in de oude databank, dan mogen
// die gerust blijven staan als opkuis voor later — Jonas heeft bevestigd dat
// die oudere/losstaande gegevens verloren mogen gaan zodra de overstap rond is.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
});

const JWT_SECRET = process.env.JWT_SECRET || 'verander-deze-waarde';
const SETUP_KEY = process.env.SETUP_KEY || 'verander-deze-waarde-ook';
// Waarschuwing i.p.v. de app te laten weigeren op te starten — een bestaande
// productie-omgeving zou anders plots niet meer opstarten (of, nog erger, als
// we in plaats daarvan een WILLEKEURIGE waarde per opstart zouden gebruiken:
// alle crewleden zouden dan bij elke herstart/deploy plots uitgelogd worden).
// Maar met de standaardwaarde kan IEDEREEN die deze (publieke, open-source-
// achtige) code kent zelf geldige inlogtokens vervalsen — dus toch best even
// nakijken/instellen bij Render als dit hieronder verschijnt in de logs.
if (!process.env.JWT_SECRET) console.warn('⚠️  JWT_SECRET niet ingesteld — gebruikt onveilige standaardwaarde. Zet dit bij Render (omgevingsvariabelen)!');
if (!process.env.SETUP_KEY) console.warn('⚠️  SETUP_KEY niet ingesteld — gebruikt onveilige standaardwaarde. Zet dit bij Render (omgevingsvariabelen)!');

// Eenvoudige, in-memory rate limiter — geen extra npm-package nodig (dat kan
// hier niet getest worden). Enkel bedoeld om /api/login en /api/device-login
// te beschermen tegen ongelimiteerd (bv. de numerieke voertuig-toegangscode)
// afgaan/brute-forcen, niet als volwaardige productiebeveiliging. Telt per
// (endpoint + IP) hoeveel POGINGEN er binnen het venster gebeurd zijn; enkel
// mislukte pogingen tellen mee (een geslaagde login reset de teller niet
// expliciet, maar telt zelf ook niet mee als "poging").
const RATE_LIMIT_VENSTER_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_POGINGEN = 10;
const rateLimitPogingen = new Map(); // sleutel -> [tijdstip, tijdstip, ...]
function rateLimiter(naam) {
  return (req, res, next) => {
    const sleutel = `${naam}:${req.ip}`;
    const nu = Date.now();
    const pogingen = (rateLimitPogingen.get(sleutel) || []).filter((t) => nu - t < RATE_LIMIT_VENSTER_MS);
    if (pogingen.length >= RATE_LIMIT_MAX_POGINGEN) {
      return res.status(429).json({ error: 'Te veel mislukte pogingen — probeer het over enkele minuten opnieuw.' });
    }
    rateLimitPogingen.set(sleutel, pogingen);
    res.locals.registreerMislukteInlogpoging = () => {
      pogingen.push(nu);
      rateLimitPogingen.set(sleutel, pogingen);
    };
    next();
  };
}

async function initDb() {
  // Enkel de tabellen die uitsluitend van DEZE app zijn — alle boekings-/
  // leverings-/voertuiggegevens leven op het gedeelde platform-schema
  // (migraties in belair-boekingsplatform/src/db/migrations), dat al draait
  // tegen de tijd dat deze app opstart.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      naam TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'plaatser',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    -- Standaard voertuig van dit crewlid (ingesteld via de Crew-pagina op het
    -- platform) — voor vaste voertuig-accounts (bv. de iPad in de camionette)
    -- zodat /api/my-teams hieronder dat voertuig automatisch kan toewijzen i.p.v.
    -- dat er elke dag manueel een voertuig gekozen moet worden. Geen echte FK
    -- (net als elders tussen deze twee apps): verwijst naar voertuigen.id op het
    -- platform. ADD COLUMN IF NOT EXISTS omdat deze app geen migratiesysteem
    -- heeft — CREATE TABLE IF NOT EXISTS hierboven is een no-op zodra de tabel
    -- al bestaat.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS standaard_voertuig_id UUID;
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
  `);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, naam: user.naam, rol: user.rol },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// ---------- Kleine datum/tijd-helpers (zelfde conventies als het platform) ----------
const HHMM_REGEX = /^\d{2}:\d{2}$/;
const ISODATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function naarDatumString(waarde) {
  if (!waarde) return '';
  return new Date(waarde).toISOString().slice(0, 10);
}
// Zelfde aanpak als sync.js op het platform: TIMESTAMPTZ -> HH:MM. Let op,
// dit is bewust identiek aan de bestaande platformcode (ook al zou je in
// een niet-UTC tijdzone strikt genomen liever de lokale tijd aflezen) —
// consistent blijven met hoe het platform dit al overal doet is hier
// belangrijker dan dit in mijn eentje "corrigeren".
function naarTijdString(waarde) {
  if (!waarde) return '';
  return new Date(waarde).toISOString().slice(11, 16);
}
function naarIntOfNull(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function naarBoolOfNull(v) {
  if (v === undefined) return null;
  return !!v;
}

// Zelfde logica als dashboard.js/sync.js op het platform: bij zelfafhaling is
// er geen leveringsadres nodig; anders valt het terug op het adres van de
// klant zelf zolang er geen (afwijkend) leveringsadres expliciet is ingevuld.
function berekenAdres(row) {
  if (row.leveringswijze === 'afhaling') return '';
  return row.leveringsadres
    || [row.klant_adres, [row.klant_postcode, row.klant_gemeente].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
}

function statusVoorLevering(leveringVoltooid, afhalingVoltooid) {
  if (afhalingVoltooid) return 'afgerond';
  if (leveringVoltooid) return 'geplaatst';
  return 'te-leveren';
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
app.post('/api/login', rateLimiter('login'), async (req, res) => {
  const { username, password } = req.body || {};
  const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  if (r.rows.length === 0) { res.locals.registreerMislukteInlogpoging(); return res.status(401).json({ error: 'Onbekende gebruiker' }); }
  const user = r.rows[0];
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) { res.locals.registreerMislukteInlogpoging(); return res.status(401).json({ error: 'Verkeerd wachtwoord' }); }
  res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, naam: user.naam, rol: user.rol }
  });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// ---------- Gebruikersbeheer (enkel admin) ----------
// Let op: het beheer zelf (crewlid aanmaken/wijzigen, telefoon/opmerking) gebeurt
// voortaan via de "Crew"-pagina op het boekingsplatform (Logistiek) — deze
// endpoints blijven bestaan zodat de crew-app's eigen Instellingen-tab nog
// werkt, en om achterwaarts compatibel te blijven.
app.get('/api/users', auth, adminOnly, async (req, res) => {
  const r = await pool.query('SELECT id,username,naam,rol,telefoon,opmerking,created_at FROM users ORDER BY naam');
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

// ============================================================
// VOERTUIG-TOESTEL (vaste iPad-login per voertuig, los van crewleden)
// ============================================================
// Publieke (niet-ingelogde) lijst van voertuignamen — enkel nodig om in het
// inlogscherm van voertuig.html een voertuig te kunnen kiezen. Toont bewust
// geen toegangscodes of andere gevoelige info.
app.get('/api/voertuigen-publiek', async (req, res) => {
  const r = await pool.query('SELECT id, naam FROM voertuigen ORDER BY naam');
  res.json(r.rows);
});

// Lichte crewlijst (enkel id+naam, geen gebruikersnaam/wachtwoord/telefoon) —
// voor NIET-admin gebruikers, zodat een vast voertuig-account (bv. de iPad in
// een bestelwagen) zelf kan aanduiden wie van de crew vandaag mee rijdt, via
// /api/mijn-voertuig-bemanning hieronder. /api/users (met alle velden) blijft
// adminOnly.
app.get('/api/crew-publiek', auth, async (req, res) => {
  const r = await pool.query('SELECT id, naam FROM users ORDER BY naam');
  res.json(r.rows);
});

app.post('/api/device-login', rateLimiter('device-login'), async (req, res) => {
  const { voertuigId, code } = req.body || {};
  if (!voertuigId || !code) return res.status(400).json({ error: 'Kies een voertuig en vul de toegangscode in' });
  const r = await pool.query('SELECT id, naam, toegangscode FROM voertuigen WHERE id = $1', [voertuigId]);
  const voertuig = r.rows[0];
  if (!voertuig || !voertuig.toegangscode || voertuig.toegangscode !== code) {
    res.locals.registreerMislukteInlogpoging();
    return res.status(401).json({ error: 'Ongeldige toegangscode' });
  }
  // Lang geldig (~10 jaar): dit toestel logt in principe maar één keer in en
  // blijft dan permanent aangemeld, net zoals een kiosk-toestel.
  const token = jwt.sign(
    { type: 'device', voertuigId: voertuig.id, naam: voertuig.naam, rol: 'device' },
    JWT_SECRET,
    { expiresIn: '3650d' }
  );
  res.json({ token, voertuig: { id: voertuig.id, naam: voertuig.naam } });
});

function deviceOnly(req, res, next) {
  if (req.user.type !== 'device') return res.status(403).json({ error: 'Enkel voor een voertuig-toestel' });
  next();
}

// ============================================================
// LEVERINGEN — gelezen/geschreven rechtstreeks op boekingen/klanten/
// leveringen/boeking_producten/producten van het boekingsplatform.
// ============================================================

// Zelfde statuslijst als het boekingsplatform gebruikt op Dashboard/Planning:
// enkel "definitief genoeg" geplande boekingen zijn interessant voor de crew
// — een kale website-aanvraag die Jonas nog niet aanvaard heeft, hoort hier
// niet tussen te staan.
const GEPLANDE_STATUSSEN = [
  'geaccepteerd', 'ingepland', 'bevestigd', 'betaalverzoek_verstuurd',
  'betaald_deels', 'betaald_volledig', 'gefactureerd', 'voldaan_manueel',
];

const DELIVERIES_SELECT = `
  SELECT b.id, b.leveringswijze, b.leveringsadres, b.type_ondergrond,
         b.gewenste_datum_start, b.gewenste_datum_einde,
         k.naam AS klant, k.telefoon, k.email,
         k.adres AS klant_adres, k.postcode AS klant_postcode, k.gemeente AS klant_gemeente,
         l.id AS leveringen_id, l.voertuig_levering, l.voertuig_afhaling,
         l.leveringstijd, l.afhaaltijd,
         l.volgorde_levering, l.volgorde_afhaling,
         COALESCE(l.levering_voltooid, false) AS levering_voltooid,
         COALESCE(l.afhaling_voltooid, false) AS afhaling_voltooid,
         l.plaatsing_correct, l.plaatsing_bevestiging, l.plaatsing_valmatten, l.plaatsing_verlengkabel,
         l.plaatsing_aantal_kabels, l.plaatsing_aantal_zandzakken, l.plaatsing_netjes, l.plaatsing_opmerkingen,
         l.plaatsing_grasrobot_uit, l.plaatsing_handtekening, l.plaatsing_handtekening_naam, l.plaatsing_handtekening_op,
         COALESCE(l.plaatsing_bevestigd, false) AS plaatsing_bevestigd, l.plaatsing_bevestigd_op,
         l.afhaling_valmatten_terug, l.afhaling_kabels_terug, l.afhaling_bevestiging_terug,
         l.afhaling_nat_of_vuil, l.afhaling_reiniging_nodig, l.afhaling_opmerkingen,
         COALESCE(l.afhaling_bevestigd, false) AS afhaling_bevestigd, l.afhaling_bevestigd_op,
         COALESCE(l.afhaling_verzet_aangevraagd, false) AS afhaling_verzet_aangevraagd,
         l.afhaling_verzet_naar_datum, l.afhaling_verzet_reden,
         l.betaling_ter_plekke_status, l.betaling_ter_plekke_opmerking,
         bp.producten_namen, COALESCE(bp.totaal, 0) AS totaal
  FROM boekingen b
  JOIN klanten k ON k.id = b.klant_id
  LEFT JOIN leveringen l ON l.boeking_id = b.id
  LEFT JOIN (
    SELECT bp.boeking_id,
           string_agg(p.naam || CASE WHEN bp.aantal > 1 THEN ' (x' || bp.aantal || ')' ELSE '' END, ', ' ORDER BY p.naam) AS producten_namen,
           SUM(bp.prijs * bp.aantal) AS totaal
    FROM boeking_producten bp
    JOIN producten p ON p.id = bp.product_id
    GROUP BY bp.boeking_id
  ) bp ON bp.boeking_id = b.id
  WHERE b.status = ANY($1)
    -- b.status ("bevestigd" e.d.) blijft voor altijd staan, ook lang na de
    -- uitvoering — dus zonder datumgrens komt hier elke ooit-bevestigde
    -- boeking in te staan, tot jaren terug. Daarom enkel boekingen tonen
    -- waarvan de leverdatum ÓF afhaaldatum niet meer dan een paar dagen
    -- geleden is (kleine marge voor een afhaling die net iets te laat is).
    AND GREATEST(b.gewenste_datum_start, b.gewenste_datum_einde) >= (CURRENT_DATE - INTERVAL '3 days')
`;

function rijNaarLevering(row, voertuigenPerNaam) {
  function toewijzing(naam) {
    if (!naam) return null;
    const v = voertuigenPerNaam.get(naam.toLowerCase());
    return { type: 'team', id: v ? v.id : null, naam };
  }
  const bedragNum = Math.round(Number(row.totaal || 0));
  return {
    id: row.id,
    klant: row.klant || '',
    telefoon: row.telefoon || '',
    email: row.email || '',
    adres: berekenAdres(row),
    postcode: row.klant_postcode || '',
    ondergrond: row.type_ondergrond || '',
    datum: naarDatumString(row.gewenste_datum_start),
    tijdslot: naarTijdString(row.leveringstijd),
    afhaaldatum: naarDatumString(row.gewenste_datum_einde),
    afhaaltijd: naarTijdString(row.afhaaltijd),
    artikelen: row.producten_namen || '',
    bedrag: bedragNum > 0 ? String(bedragNum) : '',
    boekingsnummer: row.id,
    status: statusVoorLevering(row.levering_voltooid, row.afhaling_voltooid),
    toegewezenAan: toewijzing(row.voertuig_levering),
    toegewezenAanAfhaling: toewijzing(row.voertuig_afhaling),
    handmatigeVolgordeLevering: row.volgorde_levering != null ? row.volgorde_levering : null,
    handmatigeVolgordeAfhaling: row.volgorde_afhaling != null ? row.volgorde_afhaling : null,
    geo: null,
    oorspronkelijkBedrag: null,
    plaatsing: {
      correctGeplaatst: !!row.plaatsing_correct,
      bevestiging: row.plaatsing_bevestiging || '',
      valmatten: !!row.plaatsing_valmatten,
      verlengkabel: !!row.plaatsing_verlengkabel,
      aantalKabels: row.plaatsing_aantal_kabels != null ? String(row.plaatsing_aantal_kabels) : '',
      aantalZandzakken: row.plaatsing_aantal_zandzakken != null ? String(row.plaatsing_aantal_zandzakken) : '',
      netjes: !!row.plaatsing_netjes,
      opmerkingen: row.plaatsing_opmerkingen || '',
      grasrobotUit: !!row.plaatsing_grasrobot_uit,
      handtekening: row.plaatsing_handtekening || '',
      handtekeningNaam: row.plaatsing_handtekening_naam || '',
      handtekeningOp: row.plaatsing_handtekening_op ? new Date(row.plaatsing_handtekening_op).toISOString() : '',
      tijdstip: '',
      bevestigd: !!row.plaatsing_bevestigd,
      bevestigdOp: row.plaatsing_bevestigd_op ? new Date(row.plaatsing_bevestigd_op).toISOString() : ''
    },
    betaling: {
      status: row.betaling_ter_plekke_status || '',
      opmerking: row.betaling_ter_plekke_opmerking || ''
    },
    afhaling: {
      valmattenTerug: !!row.afhaling_valmatten_terug,
      kabelsTerug: !!row.afhaling_kabels_terug,
      bevestigingTerug: !!row.afhaling_bevestiging_terug,
      natOfVuil: !!row.afhaling_nat_of_vuil,
      reinigingNodig: !!row.afhaling_reiniging_nodig,
      opmerkingen: row.afhaling_opmerkingen || '',
      tijdstip: '',
      bevestigd: !!row.afhaling_bevestigd,
      bevestigdOp: row.afhaling_bevestigd_op ? new Date(row.afhaling_bevestigd_op).toISOString() : '',
      verzetAangevraagd: !!row.afhaling_verzet_aangevraagd,
      verzetNaarDatum: naarDatumString(row.afhaling_verzet_naar_datum),
      verzetReden: row.afhaling_verzet_reden || ''
    }
  };
}

async function haalVoertuigenPerNaamOp() {
  const { rows } = await pool.query('SELECT id, naam FROM voertuigen');
  const map = new Map();
  rows.forEach(v => map.set(v.naam.toLowerCase(), v));
  return map;
}

app.get('/api/deliveries', auth, async (req, res) => {
  const [{ rows }, voertuigenPerNaam] = await Promise.all([
    pool.query(DELIVERIES_SELECT, [GEPLANDE_STATUSSEN]),
    haalVoertuigenPerNaamOp(),
  ]);
  res.json(rows.map(row => rijNaarLevering(row, voertuigenPerNaam)));
});

// Alleen-lezen dagoverzicht voor het vaste voertuig-scherm (voertuig.html) —
// geen enkele wijziging/checklist/foto is hier mogelijk, dat blijft voorbehouden
// aan een crewlid die persoonlijk inlogt. Puur "wat moet dit voertuig vandaag
// doen" + de meldingengeschiedenis.
app.get('/api/device/vandaag', auth, deviceOnly, async (req, res) => {
  const vandaag = vandaagIso();
  const [{ rows }, voertuigenPerNaam] = await Promise.all([
    pool.query(DELIVERIES_SELECT, [GEPLANDE_STATUSSEN]),
    haalVoertuigenPerNaamOp(),
  ]);
  const alles = rows.map(row => rijNaarLevering(row, voertuigenPerNaam));
  const naamLower = (req.user.naam || '').toLowerCase();
  const leveringen = alles
    .filter(d => d.datum === vandaag && d.toegewezenAan && d.toegewezenAan.naam && d.toegewezenAan.naam.toLowerCase() === naamLower)
    .sort((a, b) => (a.tijdslot || '').localeCompare(b.tijdslot || ''));
  const afhalingen = alles
    .filter(d => (d.afhaaldatum || d.datum) === vandaag && d.toegewezenAanAfhaling && d.toegewezenAanAfhaling.naam && d.toegewezenAanAfhaling.naam.toLowerCase() === naamLower)
    .sort((a, b) => (a.afhaaltijd || '').localeCompare(b.afhaaltijd || ''));
  res.json({ voertuig: req.user.naam, datum: vandaag, leveringen, afhalingen });
});

app.get('/api/device/meldingen', auth, deviceOnly, async (req, res) => {
  const r = await pool.query(
    'SELECT id, titel, bericht, aangemaakt_op FROM voertuig_meldingen WHERE voertuig_id=$1 ORDER BY aangemaakt_op DESC LIMIT 50',
    [req.user.voertuigId]
  );
  res.json(r.rows);
});

// LET OP: bewust GEEN "levering aanmaken" endpoint meer — deze app is puur
// voor UITVOERING van boekingen die al op het boekingsplatform bestaan. Een
// nieuwe reservatie aanmaken kan enkel daar. Om dezelfde reden ook geen
// "levering verwijderen": een boeking (weg)beheren is een taak van het
// boekingsplatform, nooit van deze app.
app.put('/api/deliveries/:id', auth, async (req, res) => {
  const d = req.body || {};
  const boekingId = req.params.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const huidigRes = await client.query(
      `SELECT b.leveringswijze, b.leveringsadres, b.gewenste_datum_start, b.gewenste_datum_einde,
              k.adres AS klant_adres, k.postcode AS klant_postcode, k.gemeente AS klant_gemeente
       FROM boekingen b JOIN klanten k ON k.id = b.klant_id WHERE b.id = $1 FOR UPDATE OF b`,
      [boekingId]
    );
    if (huidigRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Boeking niet gevonden' });
    }
    const huidig = huidigRes.rows[0];

    // Leverdatum/afhaaldatum: "details van de boeking aanpassen" mag van
    // Jonas vanuit de app, dus deze schrijven we door naar de boeking zelf
    // (dezelfde datums die ook op de Planning-pagina van het platform staan).
    const nieuweDatum = ISODATE_REGEX.test(d.datum || '') ? d.datum : naarDatumString(huidig.gewenste_datum_start);
    const nieuweAfhaaldatum = ISODATE_REGEX.test(d.afhaaldatum || '') ? d.afhaaldatum : naarDatumString(huidig.gewenste_datum_einde);
    await client.query(
      'UPDATE boekingen SET gewenste_datum_start = $1, gewenste_datum_einde = $2, bijgewerkt_op = now() WHERE id = $3',
      [nieuweDatum, nieuweAfhaaldatum, boekingId]
    );

    // Leveringsadres: enkel effectief overschrijven als de chauffeur het
    // echt aangepast heeft (afwijkt van het automatisch berekende adres) —
    // anders zouden we per ongeluk het klantadres "bevriezen" bij elke
        // gewone opslag (bv. een checklist-vinkje), terwijl een leeg
    // leveringsadres net bedoeld is om automatisch mee te veranderen als het
    // klantadres ooit wijzigt.
    const huidigBerekend = berekenAdres({ ...huidig });
    const ingevoerdAdres = (d.adres || '').trim();
    if (ingevoerdAdres !== huidigBerekend.trim()) {
      await client.query('UPDATE boekingen SET leveringsadres = $1 WHERE id = $2', [ingevoerdAdres || null, boekingId]);
    }

    // Status (te-leveren/geplaatst/afgerond) vertaalt zich naar de 2
    // aparte "voltooid"-vlaggen — dezelfde kolommen die het Dashboard en de
    // Planning-pagina van het platform al gebruiken voor de groene
    // "afgerond"-markering.
    const status = ['te-leveren', 'geplaatst', 'afgerond'].includes(d.status) ? d.status : 'te-leveren';
    const leveringVoltooid = status === 'geplaatst' || status === 'afgerond';
    const afhalingVoltooid = status === 'afgerond';

    const plaatsing = d.plaatsing || {};
    const afhaling = d.afhaling || {};
    const betaling = d.betaling || {};

    // Tijdslot/afhaaltijd: enkel doorschrijven naar de strikte, sorteerbare
    // leveringstijd/afhaaltijd-kolommen (dezelfde die het Dashboard gebruikt)
    // als het echt een geldig UU:MM is — zo kan hier nooit per ongeluk iets
    // onbruikbaars in die kolom terechtkomen.
    const leveringstijdWaarde = HHMM_REGEX.test(d.tijdslot || '') ? `${nieuweDatum} ${d.tijdslot}` : null;
    const afhaaltijdWaarde = HHMM_REGEX.test(d.afhaaltijd || '') ? `${nieuweAfhaaldatum} ${d.afhaaltijd}` : null;

    const voertuigLevering = (d.toegewezenAan && d.toegewezenAan.naam) ? d.toegewezenAan.naam : null;
    const voertuigAfhaling = (d.toegewezenAanAfhaling && d.toegewezenAanAfhaling.naam) ? d.toegewezenAanAfhaling.naam : null;

    const velden = {
      voertuig_levering: voertuigLevering,
      voertuig_afhaling: voertuigAfhaling,
      volgorde_levering: naarIntOfNull(d.handmatigeVolgordeLevering),
      volgorde_afhaling: naarIntOfNull(d.handmatigeVolgordeAfhaling),
      levering_voltooid: leveringVoltooid,
      afhaling_voltooid: afhalingVoltooid,
      leveringstijd: leveringstijdWaarde,
      afhaaltijd: afhaaltijdWaarde,
      plaatsing_correct: naarBoolOfNull(plaatsing.correctGeplaatst),
      plaatsing_bevestiging: plaatsing.bevestiging || null,
      plaatsing_valmatten: naarBoolOfNull(plaatsing.valmatten),
      plaatsing_verlengkabel: naarBoolOfNull(plaatsing.verlengkabel),
      plaatsing_aantal_kabels: naarIntOfNull(plaatsing.aantalKabels),
      plaatsing_aantal_zandzakken: naarIntOfNull(plaatsing.aantalZandzakken),
      plaatsing_netjes: naarBoolOfNull(plaatsing.netjes),
      plaatsing_opmerkingen: plaatsing.opmerkingen || null,
      plaatsing_grasrobot_uit: naarBoolOfNull(plaatsing.grasrobotUit),
      // Handtekening (base64 PNG) + naam ondertekenaar — de app stuurt bij elke
      // opslag het volledige leveringsobject mee (incl. een reeds bestaande
      // handtekening), dus dit is telkens gewoon dezelfde waarde herschrijven
      // totdat er via het tekenscherm effectief een nieuwe bij komt.
      plaatsing_handtekening: plaatsing.handtekening || null,
      plaatsing_handtekening_naam: plaatsing.handtekeningNaam || null,
      plaatsing_handtekening_op: plaatsing.handtekeningOp || null,
      plaatsing_bevestigd: !!plaatsing.bevestigd,
      plaatsing_bevestigd_op: plaatsing.bevestigdOp || null,
      afhaling_valmatten_terug: naarBoolOfNull(afhaling.valmattenTerug),
      afhaling_kabels_terug: naarBoolOfNull(afhaling.kabelsTerug),
      afhaling_bevestiging_terug: naarBoolOfNull(afhaling.bevestigingTerug),
      afhaling_nat_of_vuil: naarBoolOfNull(afhaling.natOfVuil),
      afhaling_reiniging_nodig: naarBoolOfNull(afhaling.reinigingNodig),
      afhaling_opmerkingen: afhaling.opmerkingen || null,
      afhaling_bevestigd: !!afhaling.bevestigd,
      afhaling_bevestigd_op: afhaling.bevestigdOp || null,
      afhaling_verzet_aangevraagd: !!afhaling.verzetAangevraagd,
      afhaling_verzet_naar_datum: ISODATE_REGEX.test(afhaling.verzetNaarDatum || '') ? afhaling.verzetNaarDatum : null,
      afhaling_verzet_reden: afhaling.verzetReden || null,
      betaling_ter_plekke_status: betaling.status || null,
      betaling_ter_plekke_opmerking: betaling.opmerking || null,
    };
    const kolommen = Object.keys(velden);
    const upsert = await client.query(
      `INSERT INTO leveringen (boeking_id, ${kolommen.join(', ')})
       VALUES ($1, ${kolommen.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (boeking_id) DO UPDATE SET
         ${kolommen.map((k) => (k === 'leveringstijd' || k === 'afhaaltijd')
           ? `${k} = COALESCE(EXCLUDED.${k}, leveringen.${k})`
           : `${k} = EXCLUDED.${k}`).join(', ')}
       RETURNING id`,
      [boekingId, ...kolommen.map((k) => velden[k])]
    );

    // "Kasteel nat/vuil" of "reiniging nodig" bij de afhaling-checklist moet
    // zich vertalen naar producten.staat = 'vuil' op het boekingsplatform (zie
    // de uitleg hierover in migratie 020_crew_app_consolidatie.sql) — dat is
    // wat het Dagoverzicht daar toont/waarschuwt. Die vertaling gebeurde tot
    // nu toe nergens echt: het vinkje in de app werd wel opgeslagen, maar
    // kwam nooit door naar het product zelf. Geldt voor alle producten van
    // deze boeking (de checklist maakt geen onderscheid per productregel).
    if (velden.afhaling_nat_of_vuil || velden.afhaling_reiniging_nodig) {
      await client.query(
        `UPDATE producten SET staat = 'vuil', staat_bijgewerkt_op = now()
         WHERE id IN (SELECT product_id FROM boeking_producten WHERE boeking_id = $1)`,
        [boekingId]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, leveringenId: upsert.rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[deliveries] opslaan mislukt:', e);
    res.status(500).json({ error: 'Opslaan mislukt: ' + e.message });
  } finally {
    client.release();
  }
});

// ---------- Foto's (plaatsing/afhaling) ----------
app.get('/api/deliveries/:id/photos', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT lf.id, lf.naam, lf.fase, lf.data_url AS "dataUrl" FROM leveringen_fotos lf
     JOIN leveringen l ON l.id = lf.leveringen_id
     WHERE l.boeking_id = $1 ORDER BY lf.id`,
    [req.params.id]
  );
  res.json(r.rows);
});
app.post('/api/deliveries/:id/photos', auth, async (req, res) => {
  const { naam, dataUrl, fase } = req.body || {};
  const gekozenFase = fase === 'afhaling' ? 'afhaling' : 'plaatsing';
  try {
    // Bijna altijd bestaat de leveringen-rij al (aangemaakt bij de eerste
    // opslag van de checklist), maar voor de zekerheid: als die rij er nog
    // niet is (bv. meteen een foto nemen vóór iets anders opgeslagen werd),
    // maken we ze hier leeg aan.
    const upsertLevering = await pool.query(
      `INSERT INTO leveringen (boeking_id) VALUES ($1)
       ON CONFLICT (boeking_id) DO UPDATE SET boeking_id = EXCLUDED.boeking_id
       RETURNING id`,
      [req.params.id]
    );
    const leveringenId = upsertLevering.rows[0].id;
    const ins = await pool.query(
      'INSERT INTO leveringen_fotos(leveringen_id, fase, naam, data_url) VALUES ($1,$2,$3,$4) RETURNING id, naam, data_url AS "dataUrl"',
      [leveringenId, gekozenFase, naam || '', dataUrl]
    );
    const photo = ins.rows[0];
    res.json(photo);

    // Best-effort kopie naar Dropbox, ná het antwoord — mag de app nooit vertragen of blokkeren
    (async () => {
      try {
        const delRes = await pool.query(
          `SELECT k.naam AS klant, b.gewenste_datum_start AS datum
           FROM boekingen b JOIN klanten k ON k.id = b.klant_id WHERE b.id = $1`,
          [req.params.id]
        );
        if (delRes.rows.length === 0) return;
        const delivery = delRes.rows[0];
        const base64 = (dataUrl || '').split(',')[1];
        if (!base64) return;
        const buffer = Buffer.from(base64, 'base64');
        const folder = sanitizeForPath(naarDatumString(delivery.datum) || 'ongedateerd') + '_' + sanitizeForPath(delivery.klant);
        const dropboxPath = '/' + folder + '/foto-' + photo.id + '.jpg';
        await uploadToDropbox(dropboxPath, buffer);
      } catch (e) {
        console.error('Dropbox-kopie mislukt:', e.message);
      }
    })();
  } catch (e) {
    res.status(500).json({ error: 'Foto opslaan mislukt: ' + e.message });
  }
});
app.delete('/api/deliveries/:deliveryId/photos/:photoId', auth, async (req, res) => {
  await pool.query(
    `DELETE FROM leveringen_fotos lf USING leveringen l
     WHERE lf.id = $1 AND lf.leveringen_id = l.id AND l.boeking_id = $2`,
    [req.params.photoId, req.params.deliveryId]
  );
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

// ---------- Instellingen (bv. Google review-link, betaal-QR) ----------
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
    const r = await pool.query(
      `SELECT k.naam AS klant, k.email FROM boekingen b JOIN klanten k ON k.id = b.klant_id WHERE b.id = $1`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Levering niet gevonden' });
    const d = r.rows[0];
    if (!d.email) return res.status(400).json({ error: 'Geen e-mailadres bekend voor deze klant' });

    const settingsRes = await pool.query("SELECT value FROM app_settings WHERE key='googleReviewUrl'");
    const reviewUrl = settingsRes.rows[0] ? settingsRes.rows[0].value : '';
    if (!reviewUrl) return res.status(400).json({ error: 'Stel eerst een Google review-link in bij Instellingen' });

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
  // Een voertuig-toestel (zie deviceOnly) abonneert op naam van het VOERTUIG
  // i.p.v. een gebruiker — zo kan het platform straks rechtstreeks naar dat
  // voertuig pushen, los van wie er die dag in rijdt.
  const isDevice = req.user.type === 'device';
  await pool.query(
    `INSERT INTO push_subscriptions(user_id, voertuig_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, voertuig_id=$2, p256dh=$4, auth=$5`,
    [isDevice ? null : req.user.id, isDevice ? req.user.voertuigId : null, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  );
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
  res.json({ ok: true });
});

// ============================================================
// VOERTUIGEN & BEMANNING
// ============================================================
// Voertuigen zelf ("Belair Camionette", "Linirent bus", ...) worden enkel nog
// op het boekingsplatform beheerd (Instellingen -> Voertuigen daar) — hier
// enkel uitlezen, nooit aanmaken/hernoemen/verwijderen vanuit de app.
//
// De WIE-zit-in-welk-voertuig-vandaag ("bemanning") is wél hier volledig
// herwerkt volgens Jonas' vraag: per dag, per richting (levering/afhaling)
// apart, ten allen tijde aanpasbaar, en elke nieuwe dag standaard leeg (geen
// automatische overname van de vorige dag) — zie voertuig_bemanning
// (migratie 022 op het platform).

function vandaagIso() {
  return new Date().toISOString().slice(0, 10);
}

// Kort overzicht van de voertuigen, telkens met de bemanning van VANDAAG voor
// de levering-fase als "leden" — dit is bewust een eenvoudige, snelle
// momentopname voor weergavedoeleinden (samenvattingsregels, kaartkleuren,
// het "naar wie versturen"-lijstje bij Melding versturen). De echte,
// dag-/fase-specifieke bewerking van de bemanning gebeurt via
// /api/voertuig-bemanning en /api/mijn-voertuig hieronder.
app.get('/api/teams', auth, async (req, res) => {
  const [voertuigenRes, bemanningRes] = await Promise.all([
    pool.query('SELECT id, naam FROM voertuigen ORDER BY naam'),
    pool.query(
      `SELECT voertuig_id, gebruiker_id AS id, gebruiker_naam AS naam
       FROM voertuig_bemanning WHERE datum = $1 AND fase = 'levering'`,
      [vandaagIso()]
    ),
  ]);
  const ledenPerVoertuig = new Map();
  bemanningRes.rows.forEach(r => {
    if (!ledenPerVoertuig.has(r.voertuig_id)) ledenPerVoertuig.set(r.voertuig_id, []);
    ledenPerVoertuig.get(r.voertuig_id).push({ id: r.id, naam: r.naam });
  });
  res.json(voertuigenRes.rows.map(v => ({ id: v.id, naam: v.naam, leden: ledenPerVoertuig.get(v.id) || [] })));
});

// Voertuig(en) van de ingelogde gebruiker voor VANDAAG, per fase — gebruikt
// om her en der (bv. "jouw voertuig"-markering) te tonen of iets voor jou is.
app.get('/api/my-teams', auth, async (req, res) => {
  const datum = vandaagIso();
  let r = await pool.query(
    `SELECT vb.voertuig_id AS id, v.naam, vb.fase
     FROM voertuig_bemanning vb JOIN voertuigen v ON v.id = vb.voertuig_id
     WHERE vb.gebruiker_id = $1 AND vb.datum = $2`,
    [req.user.id, datum]
  );
  // Nog HELEMAAL geen bemanning vandaag (geen enkele fase)? Dan het "standaard
  // voertuig" van dit crewlid (ingesteld via de Crew-pagina op het platform,
  // bedoeld voor vaste voertuig-accounts zoals de iPad in de camionette)
  // automatisch toewijzen voor zowel levering als afhaling. Dit endpoint wordt
  // bij elke app-start aangeroepen (i.t.t. /api/login, dat door het 30 dagen
  // geldige token soms wekenlang niet opnieuw gebeurt), dus dit is de juiste
  // plek om dit "elke dag opnieuw" te laten gebeuren. Enkel bij HELEMAAL niets
  // — zo overschrijft dit nooit een handmatige wijziging via "Wijzig van
  // wagen", ook niet gedeeltelijk (bv. enkel levering al manueel gezet).
  if (r.rows.length === 0) {
    const { rows: userRows } = await pool.query('SELECT standaard_voertuig_id FROM users WHERE id = $1', [req.user.id]);
    const standaardVoertuigId = userRows[0] && userRows[0].standaard_voertuig_id;
    if (standaardVoertuigId) {
      try {
        await pool.query(
          `INSERT INTO voertuig_bemanning (voertuig_id, gebruiker_id, gebruiker_naam, datum, fase)
           SELECT $1, $2, $3, $4, fase FROM (VALUES ('levering'), ('afhaling')) AS f(fase)
           ON CONFLICT (gebruiker_id, datum, fase) DO NOTHING`,
          [standaardVoertuigId, req.user.id, req.user.naam, datum]
        );
        r = await pool.query(
          `SELECT vb.voertuig_id AS id, v.naam, vb.fase
           FROM voertuig_bemanning vb JOIN voertuigen v ON v.id = vb.voertuig_id
           WHERE vb.gebruiker_id = $1 AND vb.datum = $2`,
          [req.user.id, datum]
        );
      } catch (e) {
        // Standaard voertuig verwijderd o.i.d. — gewoon negeren, dan kiest het
        // crewlid manueel zoals voorheen.
      }
    }
  }
  res.json(r.rows);
});

// Zelf je voertuig kiezen voor een gekozen dag (standaard vandaag) — apart
// voor levering en afhaling, want Jonas wil dat een crewlid voor de levering
// in een ander voertuig kan zitten dan voor de afhaling, op dezelfde dag.
app.get('/api/mijn-voertuig', auth, async (req, res) => {
  const datum = ISODATE_REGEX.test(req.query.datum || '') ? req.query.datum : vandaagIso();
  const r = await pool.query(
    `SELECT voertuig_id, fase FROM voertuig_bemanning WHERE gebruiker_id = $1 AND datum = $2`,
    [req.user.id, datum]
  );
  const result = { datum, levering: null, afhaling: null };
  r.rows.forEach(row => { result[row.fase] = row.voertuig_id; });
  res.json(result);
});
app.put('/api/mijn-voertuig', auth, async (req, res) => {
  const { datum, fase, voertuigId } = req.body || {};
  if (!['levering', 'afhaling'].includes(fase)) {
    return res.status(400).json({ error: 'fase moet "levering" of "afhaling" zijn' });
  }
  const gekozenDatum = ISODATE_REGEX.test(datum || '') ? datum : vandaagIso();
  if (!voertuigId) {
    await pool.query(
      'DELETE FROM voertuig_bemanning WHERE gebruiker_id=$1 AND datum=$2 AND fase=$3',
      [req.user.id, gekozenDatum, fase]
    );
    return res.json({ ok: true });
  }
  try {
    await pool.query(
      `INSERT INTO voertuig_bemanning (voertuig_id, gebruiker_id, gebruiker_naam, datum, fase)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (gebruiker_id, datum, fase) DO UPDATE SET voertuig_id = EXCLUDED.voertuig_id, gebruiker_naam = EXCLUDED.gebruiker_naam`,
      [voertuigId, req.user.id, req.user.naam, gekozenDatum, fase]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Kon voertuig niet instellen: ' + e.message });
  }
});

// Zelfde voertuig-bepaling als /api/my-teams hierboven (voertuig_bemanning
// van vandaag, anders het standaard voertuig) — hier apart getrokken zodat
// /api/mijn-voertuig-bemanning (GET/PUT) hieronder exact hetzelfde voertuig
// gebruikt, ongeacht welk van de twee endpoints het eerst aangeroepen werd.
async function bepaalMijnVoertuigId(gebruikerId, fase, datum) {
  const r = await pool.query(
    'SELECT voertuig_id FROM voertuig_bemanning WHERE gebruiker_id=$1 AND datum=$2 AND fase=$3',
    [gebruikerId, datum, fase]
  );
  if (r.rows[0]) return r.rows[0].voertuig_id;
  const { rows: userRows } = await pool.query('SELECT standaard_voertuig_id FROM users WHERE id=$1', [gebruikerId]);
  return (userRows[0] && userRows[0].standaard_voertuig_id) || null;
}

// Niet-admin variant van "Huidige bezetting": een crewlid (in de praktijk
// vooral een vast voertuig-account, bv. de iPad in een bestelwagen) mag ENKEL
// de bemanning van zijn EIGEN voertuig van vandaag bewerken — het voertuig
// wordt hier dus altijd zelf bepaald (bepaalMijnVoertuigId), nooit door de
// client meegegeven, zodat dit nooit de bemanning van een ANDER voertuig kan
// wijzigen (dat blijft voorbehouden aan /api/voertuig-bemanning, adminOnly).
app.get('/api/mijn-voertuig-bemanning', auth, async (req, res) => {
  const datum = ISODATE_REGEX.test(req.query.datum || '') ? req.query.datum : vandaagIso();
  const fase = req.query.fase === 'afhaling' ? 'afhaling' : 'levering';
  const voertuigId = await bepaalMijnVoertuigId(req.user.id, fase, datum);
  if (!voertuigId) return res.json({ datum, fase, voertuigId: null, voertuigNaam: '', leden: [] });
  const [voertuigRes, ledenRes] = await Promise.all([
    pool.query('SELECT naam FROM voertuigen WHERE id=$1', [voertuigId]),
    // Het ingelogde account zelf staat hier ook altijd tussen (zie /api/my-teams)
    // — dat is geen "echte" bijrijder, dus niet tonen in de aan-te-vinken lijst.
    pool.query(
      'SELECT gebruiker_id AS id, gebruiker_naam AS naam FROM voertuig_bemanning WHERE voertuig_id=$1 AND datum=$2 AND fase=$3 AND gebruiker_id != $4',
      [voertuigId, datum, fase, req.user.id]
    ),
  ]);
  res.json({
    datum, fase, voertuigId,
    voertuigNaam: voertuigRes.rows[0] ? voertuigRes.rows[0].naam : '',
    leden: ledenRes.rows,
  });
});
app.put('/api/mijn-voertuig-bemanning', auth, async (req, res) => {
  const { datum, fase, gebruikerIds } = req.body || {};
  if (!['levering', 'afhaling'].includes(fase) || !Array.isArray(gebruikerIds)) {
    return res.status(400).json({ error: 'fase (levering/afhaling) en gebruikerIds (lijst) zijn verplicht' });
  }
  const gekozenDatum = ISODATE_REGEX.test(datum || '') ? datum : vandaagIso();
  const voertuigId = await bepaalMijnVoertuigId(req.user.id, fase, gekozenDatum);
  if (!voertuigId) {
    return res.status(400).json({ error: 'Aan dit account hangt nog geen voertuig — laat de admin dit instellen via de Crew-pagina ("Standaard voertuig").' });
  }
  // Zichzelf altijd mee opslaan (naast de gekozen bijrijders) — anders raakt
  // de eigen voertuig-koppeling (nodig voor "voor mij"/de oranje balk) hier
  // per ongeluk kwijt, want de DELETE hieronder ruimt ook de eigen rij op.
  const idsZonderMezelf = gebruikerIds.map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id) && id !== req.user.id);
  const ids = Array.from(new Set([...idsZonderMezelf, req.user.id]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM voertuig_bemanning
       WHERE datum = $1 AND fase = $2 AND (voertuig_id = $3 OR gebruiker_id = ANY($4::int[]))`,
      [gekozenDatum, fase, voertuigId, ids]
    );
    await client.query(
      `INSERT INTO voertuig_bemanning (voertuig_id, gebruiker_id, gebruiker_naam, datum, fase)
       SELECT $1, u.id, u.naam, $2, $3 FROM users u WHERE u.id = ANY($4::int[])`,
      [voertuigId, gekozenDatum, fase, ids]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Bemanning bijwerken mislukt: ' + e.message });
  } finally {
    client.release();
  }
});

// Admin-overzicht/-bewerking: "wie zit vandaag (of een gekozen dag) in welk
// voertuig", apart per fase — dit is het scherm achter "Huidige bezetting".
app.get('/api/voertuig-bemanning', auth, adminOnly, async (req, res) => {
  const datum = ISODATE_REGEX.test(req.query.datum || '') ? req.query.datum : vandaagIso();
  const fase = req.query.fase === 'afhaling' ? 'afhaling' : 'levering';
  const r = await pool.query(
    'SELECT voertuig_id, gebruiker_id AS id, gebruiker_naam AS naam FROM voertuig_bemanning WHERE datum=$1 AND fase=$2',
    [datum, fase]
  );
  const perVoertuig = {};
  r.rows.forEach(row => {
    if (!perVoertuig[row.voertuig_id]) perVoertuig[row.voertuig_id] = [];
    perVoertuig[row.voertuig_id].push({ id: row.id, naam: row.naam });
  });
  res.json({ datum, fase, bemanning: perVoertuig });
});
// Vervangt in één keer de volledige bemanning van één voertuig, voor één dag
// + fase — verwijdert de gekozen gebruikers ook automatisch uit een ANDER
// voertuig voor diezelfde dag/fase (één crewlid kan er maar in één zitten).
app.put('/api/voertuig-bemanning', auth, adminOnly, async (req, res) => {
  const { voertuigId, datum, fase, gebruikerIds } = req.body || {};
  if (!voertuigId || !['levering', 'afhaling'].includes(fase) || !Array.isArray(gebruikerIds)) {
    return res.status(400).json({ error: 'voertuigId, fase (levering/afhaling) en gebruikerIds (lijst) zijn verplicht' });
  }
  const gekozenDatum = ISODATE_REGEX.test(datum || '') ? datum : vandaagIso();
  const ids = gebruikerIds.map(id => parseInt(id, 10)).filter(Number.isFinite);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Weg met: (a) de huidige bemanning van dit voertuig voor deze dag/fase
    // (wordt zo dadelijk vervangen), en (b) elke bestaande koppeling van de
    // NIEUW gekozen gebruikers met een ANDER voertuig voor diezelfde dag/fase.
    await client.query(
      `DELETE FROM voertuig_bemanning
       WHERE datum = $1 AND fase = $2 AND (voertuig_id = $3 OR gebruiker_id = ANY($4::int[]))`,
      [gekozenDatum, fase, voertuigId, ids]
    );
    if (ids.length) {
      await client.query(
        `INSERT INTO voertuig_bemanning (voertuig_id, gebruiker_id, gebruiker_naam, datum, fase)
         SELECT $1, u.id, u.naam, $2, $3 FROM users u WHERE u.id = ANY($4::int[])`,
        [voertuigId, gekozenDatum, fase, ids]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Bemanning bijwerken mislukt: ' + e.message });
  } finally {
    client.release();
  }
});

// ---------- Materiaal-info per product — enkel uitlezen (platform beheert dit) ----------
// Sinds migratie 024 (platform) heeft "producten" ook weer de velden die
// vroeger enkel in de crew-app's eigen tabel zaten (aantal_motors,
// verlengkabel_standaard/dubbel, overige_benodigdheden, materiaal_opmerking)
// — dus niet langer hardgecodeerd NULL, gewoon rechtstreeks meelezen.
app.get('/api/producten', auth, async (req, res) => {
  const r = await pool.query(`
    SELECT naam,
           materiaal_opmerking AS opmerking,
           motor_type AS "motorType",
           aantal_motors AS "aantalMotors",
           verlengkabel_standaard AS "verlengkabelStandaard",
           verlengkabel_dubbel AS "verlengkabelDubbel",
           aantal_piketten AS pinnen,
           aantal_zandzakken AS zandzakken,
           aantal_valmatten AS valmatten,
           overige_benodigdheden AS overige,
           gemiddelde_opsteltijd_minuten AS "opsteltijdMinuten"
    FROM producten ORDER BY naam
  `);
  res.json(r.rows);
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
    const r = await pool.query(
      `SELECT DISTINCT gebruiker_id FROM voertuig_bemanning WHERE voertuig_id=$1 AND datum=$2`,
      [teamId, vandaagIso()]
    );
    userIds = r.rows.map(row => row.gebruiker_id);
  } else if (userId) {
    userIds = [userId];
  } else {
    return res.status(400).json({ error: 'Kies een voertuig of een teamlid' });
  }
  if (userIds.length === 0) return res.status(400).json({ error: 'Voor dit voertuig is vandaag niemand ingedeeld' });

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

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT b.id, b.gewenste_datum_start, b.gewenste_datum_einde, bp.producten_namen
     FROM boekingen b
     LEFT JOIN (
       SELECT bp.boeking_id,
              string_agg(p.naam || CASE WHEN bp.aantal > 1 THEN ' (x' || bp.aantal || ')' ELSE '' END, ', ' ORDER BY p.naam) AS producten_namen
       FROM boeking_producten bp JOIN producten p ON p.id = bp.product_id
       GROUP BY bp.boeking_id
     ) bp ON bp.boeking_id = b.id
     WHERE b.status = ANY($1) AND b.gewenste_datum_einde >= $2`,
    [GEPLANDE_STATUSSEN, cutoffStr]
  );

  const bookings = rows
    .filter(d => d.producten_namen)
    .map(d => ({
      booking_id: d.id,
      item: d.producten_namen,
      delivery_date: naarDatumString(d.gewenste_datum_start),
      collection_date: naarDatumString(d.gewenste_datum_einde) || naarDatumString(d.gewenste_datum_start),
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
  .then(() => app.listen(PORT, () => console.log('Belair-Fun App draait op poort ' + PORT)))
  .catch(err => {
    console.error('Kon database niet initialiseren:', err);
    process.exit(1);
  });
