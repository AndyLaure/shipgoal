// Einmalige Umstellung alter, nicht ablaufender Offline-Tokens auf ablaufende Tokens
// (Shopify-Pflicht fuer oeffentliche Apps bis 01.01.2027).
//
// Im ShipGoal-Container ausfuehren:
//   node server/migrate-expiring-tokens.js           -> nur anzeigen (Probelauf)
//   node server/migrate-expiring-tokens.js --apply   -> wirklich umstellen
//
// Shopify macht den alten Token mit der Umstellung sofort ungueltig; der neue wird direkt
// gespeichert. Schlaegt das Speichern fehl: erneut mit --apply starten - Shopify liefert
// innerhalb von 7 Tagen fuer denselben alten Token dasselbe neue Token-Paar.
require('dotenv').config();
require('@shopify/shopify-api/adapters/node');
const { shopifyApi, ApiVersion } = require('@shopify/shopify-api');
const { TursoSessionStorage } = require('./turso-session-storage');

(async () => {
  const apply = process.argv.includes('--apply');
  if (!process.env.TURSO_DATABASE_URL) {
    console.error('TURSO_DATABASE_URL fehlt - Abbruch.');
    process.exit(1);
  }
  const HOST = (process.env.HOST || '').replace(/\/$/, '');
  const api = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    apiVersion: ApiVersion.July25,
    scopes: (process.env.SCOPES || '').split(',').map((s) => s.trim()).filter(Boolean),
    hostName: HOST.replace(/^https?:\/\//, ''),
    isEmbeddedApp: true,
  });

  const storage = new TursoSessionStorage(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN);
  await storage.ready;
  const r = await storage.client.execute('SELECT id, shop, payload FROM shipgoal_sessions ORDER BY shop');
  const old = r.rows
    .map((row) => ({ id: String(row.id), shop: String(row.shop), s: JSON.parse(String(row.payload)) }))
    .filter((x) => !x.s.isOnline && x.s.accessToken && !x.s.refreshToken);

  console.log(`${r.rows.length} Session(s) gespeichert, davon ${old.length} Offline-Token(s) ohne Ablaufdatum.` +
    (apply ? '' : ' (Probelauf - nichts geaendert)'));

  let ok = 0;
  let fail = 0;
  for (const x of old) {
    if (!apply) {
      console.log(`  wuerde umstellen: ${x.shop}`);
      continue;
    }
    try {
      const { session } = await api.auth.migrateToExpiringToken({
        shop: x.shop,
        nonExpiringOfflineAccessToken: x.s.accessToken,
      });
      if (session.id !== x.id) console.log(`  WARN ${x.shop}: neue Session-ID ${session.id} weicht von ${x.id} ab`);
      await storage.storeSession(session);
      ok++;
      console.log(`  OK   ${x.shop}`);
    } catch (e) {
      fail++;
      const body = e && e.response && e.response.body ? ` ${JSON.stringify(e.response.body)}` : '';
      console.log(`  FAIL ${x.shop}: ${e.message}${body}`);
    }
  }
  if (apply) console.log(`Fertig: ${ok} umgestellt, ${fail} fehlgeschlagen.`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
