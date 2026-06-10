# ShipGoal / Versandziel

Gratisversand-Fortschrittsbalken für Shopify: „Noch X € bis zum Gratisversand!"
Zweite App von teamsichtbar.de · Free + Pro (2,99 €/Monat, 14 Tage Trial).

## Architektur (bewusst minimal)

- **Theme App Extension** (`extensions/shipgoal-bar`): App-Embed-Block, rendert die Leiste
  direkt im Storefront. Alle Einstellungen (Schwelle, Texte, Farben, Position) macht der
  Händler im **Theme-Editor** – kein eigenes Settings-Backend nötig.
- **Backend** (`server/`): nur OAuth, Billing und Pflicht-Webhooks. Keine Shop-Daten,
  keine Kundendaten. Sessions liegen in **Turso**.
- **Pro-Gating** über ein App-Metafield: Das Backend schreibt `shipgoal.plan = free|pro`
  auf die App-Installation, der Liquid-Block liest `app.metafields.shipgoal.plan` und
  schaltet Pro-Optionen serverseitig frei (nicht per JS umgehbar).
- **Live-Update** im Storefront: fetch/XHR-Interception auf `/cart/add|change|update|clear`
  plus gängige Theme-Events (`cart:updated` etc.), danach `GET /cart.js`.

## Free vs. Pro

| | Free | Pro (2,99 €/Monat) |
|---|---|---|
| Fortschrittsbalken + Live-Update | ✓ | ✓ |
| Eigene Texte ({amount}-Platzhalter) | ✓ | ✓ |
| Eigene Farben | – | ✓ |
| Position fixiert oben/unten | – | ✓ |
| Konfetti beim Erreichen | – | ✓ |

## Setup – Schritt für Schritt

### 1. App im Partner Dashboard anlegen
1. partners.shopify.com → Apps → **App erstellen** → „ShipGoal – Versandziel".
2. **App-URL:** `https://shipgoal.onrender.com`
   **Redirect-URL:** `https://shipgoal.onrender.com/api/auth/callback`
3. Client ID + Secret notieren.

### 2. Render-Service erstellen
1. Repo zu GitHub pushen (z. B. `AndyLaure/shipgoal`).
2. Render → New → Web Service → Repo verbinden (oder `render.yaml` nutzen).
   Build: `npm install` · Start: `node server/index.js` · Health: `/healthz`.
3. Environment-Variablen setzen (siehe `.env.example`):
   `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `HOST=https://shipgoal.onrender.com`,
   `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BILLING_TEST=true`.
4. Turso: neue DB anlegen (`turso db create shipgoal`) – die Tabelle erstellt der
   Server selbst beim Start.

### 3. Theme Extension deployen
```bash
npm install
shopify app config link        # verknüpft das Projekt mit der Partner-App
shopify app deploy             # deployt die Theme Extension
```
(Shopify CLI: `npm i -g @shopify/cli` falls noch nicht installiert.)

### 4. Auf dem Dev-Shop installieren
Im Browser öffnen:
```
https://shipgoal.onrender.com/api/auth?shop=oeffnungszeiten-test.myshopify.com
```
→ OAuth durchlaufen → App öffnet sich embedded im Admin.

### 5. Im Theme aktivieren
Theme-Editor → links unten **App-Embeds** → „Versandziel Leiste" einschalten →
Schwelle + Texte einstellen → Speichern.

> Wichtig: Die Schwelle in der App muss zur echten Versandregel passen
> (Einstellungen → Versand → Gratisversand ab X €). Die App zeigt nur an,
> sie ändert keine Versandkosten.

## Test-Checkliste (Dev-Shop)

- [ ] Leerer Warenkorb → „Gratisversand ab 50 €" (bzw. ausgeblendet, wenn Option aktiv)
- [ ] Produkt hinzufügen (AJAX, ohne Reload) → Leiste aktualisiert sich
- [ ] Schwelle überschreiten → „🎉 erreicht", Balken 100 %
- [ ] Menge reduzieren → Leiste zählt zurück
- [ ] Admin: Plan lädt, Badge „Free", Billing-Testmodus-Badge sichtbar
- [ ] Upgrade → Shopify-Bestätigungsseite (Test-Abo) → zurück → Badge „Pro"
- [ ] Theme-Editor: Pro-Optionen (Farben, Position, Konfetti) wirken jetzt
- [ ] Downgrade → Pro-Optionen fallen auf Defaults zurück
- [ ] App deinstallieren → Webhook löscht Sessions (Render-Logs prüfen)

## Bekannte offene Punkte (ehrlich)

1. **Ungetestet gegen echte Shopify-API** – gebaut nach dem Muster von Öffnungszeiten
   Sync, aber rechne mit 1–2 Fix-Runden beim ersten Test (typische Kandidaten:
   GraphQL-Response-Struktur, Metafield-Namespace im Liquid-Zugriff).
2. **Metafield in Liquid:** Falls `app.metafields.shipgoal.plan` leer bleibt, einmal die
   Admin-Seite der App öffnen (synct das Metafield) und Namespace prüfen.
3. **Vor App-Store-Submission:** `BILLING_TEST=false`, Screenshots, Listing-Texte,
   Datenschutzerklärung (App speichert keine personenbezogenen Daten).
4. **Themes mit eigenem Cart-System** (selten): Falls ein Theme weder Standard-AJAX-Routen
   noch Events nutzt, aktualisiert die Leiste erst beim nächsten Seitenwechsel.
