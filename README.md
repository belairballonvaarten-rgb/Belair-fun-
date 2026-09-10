# Belair-Fun app — live zetten op Render.com

Deze map bevat de volledige app (backend + de webapp zelf). Je hoeft dit maar
één keer op te zetten; daarna kan iedereen inloggen via één link.

## Wat je nodig hebt
- Een gratis GitHub-account (github.com) — hier zet je de code neer
- Een gratis Render-account (render.com) — hier draait de app

Geen terminal, geen Node.js installeren op je eigen computer nodig.

---

## Stap 1 — Code op GitHub zetten

1. Ga naar github.com, maak een account (of log in).
2. Klik rechtsboven op **+** → **New repository**.
3. Naam: bv. `belair-fun-app`. Zet op **Private** (niet verplicht, maar veiliger). Klik **Create repository**.
4. Klik op de link **"uploading an existing file"** op de lege repository-pagina.
5. Sleep de hele inhoud van deze map (dus `server.js`, `package.json`, `.env.example`, de map `public` met daarin `index.html`) naar dat scherm.
   - Let op: de map-structuur moet bewaard blijven. Als slepen niet werkt met mappen, upload dan via de "Add file" → "Upload files" knop en sleep de `public`-map in één keer mee (GitHub houdt de mapstructuur aan bij slepen vanuit je bestandsverkenner).
6. Klik onderaan **Commit changes**.

Je hebt nu een online kopie van de code.

## Stap 2 — Database aanmaken op Render

1. Ga naar render.com, maak een account aan (kan met je GitHub-account).
2. Klik **New +** → **PostgreSQL**.
3. Geef een naam, bv. `belair-fun-db`. Regio: kies Frankfurt (dichtst bij België). Klik **Create Database**.
4. Wacht tot hij "Available" is. Klik erop en zoek **"Internal Database URL"** — kopieer die volledige tekst (begint met `postgres://...`). Die heb je zo dadelijk nodig.

## Stap 3 — Web Service aanmaken

1. Klik **New +** → **Web Service**.
2. Kies **"Build and deploy from a Git repository"**, koppel je GitHub-account en selecteer de `belair-fun-app` repository.
3. Vul in:
   - **Name**: bv. `belair-fun-app`
   - **Region**: Frankfurt
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Scroll naar **Environment Variables** en voeg toe:
   - `DATABASE_URL` → plak de Internal Database URL van Stap 2
   - `JWT_SECRET` → verzin een lange, willekeurige tekst (bv. 30 willekeurige tekens)
   - `SETUP_KEY` → verzin een eigen eenmalige installatiecode (onthoud deze, je hebt hem zo nodig)
5. Klik **Create Web Service**.

Render bouwt en start de app nu automatisch. Dit duurt 1-3 minuten. Zodra je
bovenaan **"Live"** ziet staan, krijg je een link zoals
`https://belair-fun-app.onrender.com`.

## Stap 4 — Eerste account aanmaken

1. Open de link die Render je gaf in je browser.
2. Omdat er nog geen gebruikers zijn, zie je automatisch het installatiescherm.
3. Vul de **installatiecode** in die je bij `SETUP_KEY` hebt ingesteld, plus je naam, een gebruikersnaam en wachtwoord voor jezelf.
4. Klik "Account aanmaken" — je bent meteen ingelogd als administrator.

## Stap 5 — Teamleden toevoegen

Ga naar het tabblad **Team** onderaan (enkel zichtbaar voor administrators),
en voeg daar je plaatsers toe met een eigen gebruikersnaam en wachtwoord. Zij
loggen in via dezelfde link en zien meteen de gedeelde planning.

---

## Planning importeren via Excel

Op het tabblad **Nieuw** vindt de administrator een importvak. Verwacht
bestandstype: `.xlsx`. Vereiste kolommen (exacte namen, hoofdletters maken
niet uit): `Delivery Date, Drop Off, Collection Date, Collection, Customer
Name, Mobile, Email, Delivery Address 1, Delivery Town, Delivery Postcode,
Item, Balance, Surface`.

Werk je in Apple Numbers? Exporteer eerst naar Excel: **Bestand → Exporteer
naar → Excel…** in de Numbers-app, en upload dat `.xlsx`-bestand.

Elke geïmporteerde rij wordt een nieuwe levering — er is geen automatische
detectie van dubbels, dus importeer bij voorkeur enkel de nieuwe boekingen.

## Later een wijziging doorvoeren

Als ik je later aangepaste bestanden geef: upload ze via GitHub op dezelfde
manier (Stap 1, bestanden overschrijven in de bestaande repository — GitHub
vraagt of je wil vervangen). Render herbouwt en herstart de app dan automatisch
binnen enkele minuten.

## Logo wijzigen

Het logo staat in `public/logo.png`. Wil je het later vervangen: upload gewoon
een nieuw bestand met exact die naam (`public/logo.png`) naar GitHub — geen
codewijziging nodig. Ontbreekt het bestand, dan valt de app automatisch terug
op de tekst "Belair·Fun".

## Kosten

- De PostgreSQL-database is gratis voor de eerste 30 dagen, daarna meestal
  een paar euro per maand voor het kleinste plan (prijzen kunnen wijzigen,
  check render.com/pricing).
- De Web Service zelf heeft een gratis tier (met als nadeel: hij "slaapt" na
  inactiviteit en moet dan even opstarten bij het eerste bezoek). Voor een
  bedrijfsapp die dagelijks gebruikt wordt, is het instant-actieve betaalde
  plan (~7 €/maand) comfortabeler.
