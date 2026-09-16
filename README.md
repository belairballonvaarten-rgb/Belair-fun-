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

## Foto's automatisch kopiëren naar Dropbox (optioneel)

De app slaat foto's altijd op in de database, zodat ze in de app zelf en in
het PDF-verslag blijven werken. Wil je daarnaast automatisch een kopie in je
eigen Dropbox, doorloop dan éénmalig deze stappen.

### 1. Maak een Dropbox-app aan
1. Ga naar https://www.dropbox.com/developers/apps → **Create app**.
2. Kies **Scoped access**.
3. Kies als toegangstype **App folder** (de app krijgt dan enkel toegang tot
   zijn eigen mapje in jouw Dropbox, niet tot de rest van je bestanden).
4. Geef een naam, bv. `belair-fun-fotos` (moet uniek zijn — voeg iets toe als
   de naam al bestaat). Klik **Create app**.

### 2. Zet de juiste rechten aan
1. Ga naar het tabblad **Permissions** van je nieuwe app.
2. Vink **files.content.write** aan.
3. Klik onderaan op **Submit**.

### 3. Noteer je App key en App secret
Ga naar het tabblad **Settings** en kopieer **App key** en **App secret**.

### 4. Vraag een eenmalige toestemmingscode aan
Vervang `APP_KEY` in onderstaande link door je eigen App key, en open de link
in je browser terwijl je in Dropbox bent ingelogd:

```
https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&token_access_type=offline&response_type=code
```

Klik **Allow**. Dropbox toont je een code — kopieer die.

### 5. Wissel de code in voor een refresh-token
Open een terminal (Mac: Terminal-app, Windows: PowerShell — beide hebben
`curl` ingebouwd) en voer dit uit, met je eigen gegevens ingevuld:

```
curl https://api.dropboxapi.com/oauth2/token -d code=PLAK_JE_CODE -d grant_type=authorization_code -d client_id=PLAK_APP_KEY -d client_secret=PLAK_APP_SECRET
```

Je krijgt een antwoord terug met daarin `"refresh_token": "..."` — kopieer
die waarde. Dit is de enige keer dat je deze stap moet doen; deze token
verloopt niet.

### 6. Vul in bij Render
Ga naar je Web Service → **Environment** en voeg toe:
- `DROPBOX_APP_KEY` = je App key
- `DROPBOX_APP_SECRET` = je App secret
- `DROPBOX_REFRESH_TOKEN` = de refresh-token uit stap 5

Sla op, wacht op de herdeploy. Vanaf nu verschijnt elke nieuwe foto ook
automatisch in je Dropbox, in een map per leverdatum en klantnaam. Bestaande
foto's van vóór deze koppeling worden niet met terugwerkende kracht
gekopieerd.

## Automatisch e-mails versturen (bv. Google review-verzoek)

Zonder verdere instelling opent de "Verstuur via e-mail"-knop gewoon de
mail-app van de gebruiker (zoals nu). Wil je dat de app de mail **zelf en
automatisch** verstuurt zodra je op de knop drukt, koppel dan Resend
(gratis tot 3.000 mails/maand):

### 1. Maak een Resend-account
Ga naar https://resend.com en maak een gratis account.

### 2. Maak een API-sleutel
Ga naar **API Keys** in het Resend-dashboard → **Create API Key**. Kopieer
de sleutel meteen (je ziet hem maar één keer).

### 3. Regel een verzendadres
De eenvoudigste weg: verifieer je eigen domein bij Resend (**Domains** →
**Add Domain**, en voeg de getoonde DNS-records toe bij je domeinregistrar
— bv. Combell, als je daar je domeinnaam beheert). Zodra geverifieerd, kan
je bv. `noreply@belairfun.be` als verzendadres gebruiken. Domeinverificatie
kan tot 24u duren.

Nog geen zin om dat nu te doen? Dan kan je Resend's eigen testadres
proberen, maar controleer zelf in de Resend-documentatie wat daarvoor op
dit moment de voorwaarden zijn — dat kan wijzigen.

### 4. Vul in bij Render
Ga naar je Web Service → **Environment** en voeg toe:
- `RESEND_API_KEY` = je API-sleutel uit stap 2
- `RESEND_FROM_EMAIL` = het verzendadres uit stap 3 (bv. `Belair-Fun <noreply@belairfun.be>`)

Sla op, wacht op de herdeploy. De "Verstuur via e-mail"-knop verstuurt vanaf
nu automatisch, zonder dat er een mail-app moet opengaan.

## Push-meldingen naar teams/chauffeurs

Op het tabblad **Team** kan je (als admin) **voertuigteams** aanmaken —
bijvoorbeeld "Voertuig 1" met een chauffeur en één of twee begeleiders erin —
en handmatig een push-melding met eigen tekst naar zo'n team of naar één
teamlid sturen. Er gebeurt niets automatisch: jij bepaalt telkens zelf
wanneer en wat er verstuurd wordt.

Om dit te activeren, zijn er twee sleutels nodig die je zelf genereert (dit
is eenmalig en gratis, geen account bij een externe partij nodig). Gebruik
onderstaand sleutelpaar, of genereer je eigen paar als je dat liever hebt
(met de `web-push`-tool: `npx web-push generate-vapid-keys`):

```
VAPID_PUBLIC_KEY=BIepDH8nM3dtXyNmQr_KvDmZAF1PhqoaKPOk8rjQQ441CDlz9V2lD_SRQAZT4AdMP4ytzDX5HX8vTy6Z81D6y7Y
VAPID_PRIVATE_KEY=BwC57C2barp2Q38lAuXlwBvwfXE4xBr2IHB_uGgX2lc
VAPID_SUBJECT=mailto:jouw-email@voorbeeld.be
```

Vul deze drie in bij Render → Environment (vervang het e-mailadres in
`VAPID_SUBJECT` door je eigen adres). Sla op, wacht op de herdeploy.

**Belangrijk voor gebruikers (chauffeurs/begeleiders):** de browser vraagt
bij het inloggen eenmalig toestemming voor meldingen — die moet aanvaard
worden. Op iPad/iPhone werkt dit enkel als de app via "Zet op beginscherm"
is toegevoegd, en enkel op iOS/iPadOS 16.4 of nieuwer.

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

## Koppeling met de WordPress-website (beschikbaarheid)

De app kan de actuele boekingen doorsturen naar de WordPress-plugin "Belair
Beschikbaarheid" (bestand `belair-availability.php`), zodat de kalender op
de website automatisch bijgewerkt blijft — geen aparte Excel/CSV meer nodig.

### 1. Plugin installeren/bijwerken op WordPress
Upload `belair-availability.php` naar `wp-content/plugins/` op de website
(via FTP, hostingpaneel-bestandsbeheer, of de Plugin-bestandseditor in
WordPress zelf), ter vervanging van de bestaande versie. Deze bevat een
extra, apart stukje code (een REST-API-toegang) bovenop de bestaande
functionaliteit — niets van de bestaande CSV-import of handmatige
blokkeringen wordt aangepast.

### 2. Sleutel en adres ophalen
Ga in WordPress naar **Beschikbaarheid → Instellingen**. Bovenaan staat nu
een sectie "Koppeling met de Belair-Fun app" met:
- Een **API-adres** (eindigt op `/wp-json/belair/v1/sync`)
- Een **geheime sleutel** (kan je op diezelfde pagina ook opnieuw genereren
  als je vermoedt dat hij gelekt is — pas ze dan wel meteen ook hieronder aan)

### 3. Vul in bij Render
Ga naar de Web Service van de Belair-Fun app → **Environment** en voeg toe:
- `WORDPRESS_SITE_URL` = het normale site-adres, bv. `https://www.belair-fun.be`
  (dus **niet** het volledige API-adres met `/wp-json/...` erachter — de app
  voegt dat er zelf aan toe)
- `WORDPRESS_SYNC_SECRET` = de geheime sleutel uit stap 2

### 4. Synchroniseren
In de Belair-Fun app, bij **Instellingen → Website-koppeling**, staat een
knop **"🔄 Nu synchroniseren"**. Dit gebeurt **enkel** wanneer hierop gedrukt
wordt — niets automatisch, niets op de achtergrond. De app stuurt dan alle
boekingen vanaf 2 dagen geleden tot in de toekomst door (leverdatum,
afhaaldatum, artikelen per boeking).

Er is ook een vinkje **"Volledige synchronisatie"** — enkel gebruiken als je
zeker weet dat de volledige actuele planning in de app zit, want dit
vervangt alle eerder via de app doorgestuurde blokkeringen op de website
(handmatige blokkeringen en CSV-imports op de website blijven wel altijd
gewoon staan, die worden nooit aangeraakt).

### Productnamen laten overeenkomen
De matching tussen wat in een boeking staat (bv. "CM springkasteel") en de
producten op de website gebeurt op dezelfde manier als de bestaande
CSV-import van de plugin (aliaslijst + exacte naam). Klopt een naam niet,
dan toont het resultaatbericht na synchroniseren duidelijk welke
productnamen niet herkend werden, en of het product op de website wel
"actief voor beschikbaarheid" staat (Beschikbaarheid → Instellingen →
"Welke producten gebruiken beschikbaarheid?").

## Koppeling met het boekingsplatform

Het aparte boekingsplatform (het beheerscherm waarin reservaties worden
aangemaakt/opgevolgd) kan geplande boekingen doorsturen naar déze app, zodat
de crew ze hier niet manueel moet overtypen. De richting is dus omgekeerd
t.o.v. de WordPress-koppeling hierboven: hier is de Belair-Fun-app de
**ontvanger**, niet de verzender.

### 1. Sleutel + adres instellen bij Render
Ga naar de Web Service van de Belair-Fun app → **Environment** en voeg toe:
- `SYNC_SECRET_BOEKINGSPLATFORM` = een lange, willekeurige tekst (verzin er
  zelf een — het is enkel een gedeeld geheim, geen bestaand wachtwoord)
- `BOEKINGSPLATFORM_URL` = het adres van het boekingsplatform zelf (bv.
  `https://belair-boekingsplatform.onrender.com`) — nodig voor de live
  terugkoppeling van de status (zie verder); laat leeg als je enkel de
  manuele "Nu synchroniseren"-knop wil gebruiken.

Vul exact dezelfde sleutel-waarde in bij het boekingsplatform zelf, bij
**Instellingen → Koppeling met de leveringen-app** (`LEVERINGEN_APP_SYNC_SECRET`
in diens omgevingsvariabelen), samen met het adres van déze app
(`LEVERINGEN_APP_URL`, bv. `https://belair-fun.onrender.com`).

### 2. Synchroniseren
Gebeurt volledig vanuit het boekingsplatform (knop **"🔄 Nu synchroniseren"**
bij Instellingen daar) — hier hoef je niets te doen. Net als bij de
WordPress-koppeling: enkel wanneer daarop gedrukt wordt, niets automatisch.

### Voertuig-toewijzing en routevolgorde (Planning-pagina)
Het boekingsplatform heeft een **Planning-pagina** waar per dag een voertuig
en een routevolgorde (▲/▼) ingesteld kunnen worden per levering/afhaling.
Wijst het boekingsplatform daar een voertuig toe, dan wordt dat hier
automatisch gekoppeld aan het **team** met exact dezelfde naam (Team-tabblad,
enkel voor administrators) — en zet het meteen ook `handmatigeVolgordeLevering`/
`handmatigeVolgordeAfhaling` (dezelfde velden die de bestaande handmatige
volgorde-functie hier al gebruikt om de lijst van een chauffeur te sorteren).
Levering en afhaling van dezelfde boeking krijgen elk hun eigen voertuig/team
en volgorde. Komt een voertuignaam niet overeen met een team hier, dan blijft
de levering gewoon aangemaakt/bijgewerkt — enkel zonder ploeg-toewijzing voor
dat stuk — en toont het boekingsplatform na de sync welke naam niet herkend
werd.

Belangrijk: **zodra Planning voor een levering/afhaling een voertuig of
volgorde instelt, overschrijft een volgende "Nu synchroniseren" dat hier ook
telkens opnieuw** (Planning is dus de "master" zodra ze gebruikt wordt) — is
er op het boekingsplatform nog niets ingesteld voor een bepaalde boeking, dan
blijft een eventuele bestaande toewijzing hier (rechtstreeks in de app gezet)
gewoon staan.

### Status komt terug naar het Dashboard — live, zonder knop
Zodra een chauffeur hier een levering markeert als geleverd (`geplaatst`) of
ook al opgehaald (`afgerond`), stuurt deze app dat **onmiddellijk** zelf door
naar `POST {BOEKINGSPLATFORM_URL}/api/sync/leveringen-app/status-update`
(zelfde gedeelde sleutel als hierboven) — het boekingsplatform zet daarmee
meteen de "voltooid"-markering op zijn eigen Dashboard, zonder dat daar iemand
op een knop moet drukken. Vereist dat `BOEKINGSPLATFORM_URL` hier ingesteld
staat (zie `.env.example`); staat die leeg, dan gebeurt deze live stap gewoon
niet (geen foutmelding voor de chauffeur — die actie zelf blijft altijd werken).

Als terugvaloptie (bv. bij een tijdelijke netwerkhik, of voor leveringen van
vóór deze live-koppeling bestond) haalt het boekingsplatform bij elke "Nu
synchroniseren" ook nog eens de huidige status van alle gesynchroniseerde
leveringen op (`GET /api/sync/boekingsplatform/status`) en herstelt daarmee
dezelfde "voltooid"-markering. Beide manieren zetten uiteindelijk hetzelfde:
`geplaatst` → levering voltooid, `afgerond` → ook de afhaling.

### Bestaande leveringen blijven veilig
Een boeking die hier al bestaat (herkend via het boekingsnummer) wordt bij een
nieuwe sync enkel bijgewerkt in de planninggegevens (klant, adres, data,
artikelen, bedrag, en — zoals hierboven — voertuig/volgorde zodra Planning die
instelt). Checklist, foto's en status blijven altijd onaangeroerd. Een sync
kan dus nooit dat soort werk van de plaatsers overschrijven.

