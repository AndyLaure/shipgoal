// ShipGoal / Versandziel – Backend (Managed Pricing Variante)
// Express-Server: OAuth, Plan-Check über Shopify Managed Pricing,
// Plan-Sync als App-Metafield (im Theme lesbar), Pflicht-Webhooks, embedded Admin-UI.
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const { shopifyApp } = require('@shopify/shopify-app-express');
const { ApiVersion, DeliveryMethod } = require('@shopify/shopify-api');
const {
  TursoSessionStorage,
  MemorySessionStorage,
} = require('./turso-session-storage');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = (process.env.HOST || 'http://localhost:3000').replace(/\/$/, '');
// App-Handle aus dem Dev Dashboard – Teil der Managed-Pricing-URL
const APP_HANDLE = process.env.APP_HANDLE || 'shipgoal-versandziel';

const sessionStorage = process.env.TURSO_DATABASE_URL
  ? new TursoSessionStorage(
      process.env.TURSO_DATABASE_URL,
      process.env.TURSO_AUTH_TOKEN
    )
  : new MemorySessionStorage();

if (sessionStorage instanceof MemorySessionStorage) {
  console.warn(
    '[ShipGoal] WARNUNG: Kein TURSO_DATABASE_URL gesetzt – Sessions nur im RAM (nicht für Render geeignet).'
  );
}

const shopify = shopifyApp({
  api: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    apiVersion: ApiVersion.July25,
    scopes: (process.env.SCOPES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    hostName: HOST.replace(/^https?:\/\//, ''),
  },
  auth: {
    path: '/api/auth',
    callbackPath: '/api/auth/callback',
  },
  webhooks: {
    path: '/api/webhooks',
  },
  sessionStorage,
});

// ---------------------------------------------------------------------------
// Webhooks (APP_UNINSTALLED + DSGVO-Pflicht-Webhooks für den App Store)
// ---------------------------------------------------------------------------
const webhookHandlers = {
  APP_UNINSTALLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: async (_topic, shop) => {
      const sessions = await sessionStorage.findSessionsByShop(shop);
      await sessionStorage.deleteSessions(sessions.map((s) => s.id));
      console.log(`[ShipGoal] App deinstalliert, Sessions gelöscht: ${shop}`);
    },
  },
  // ShipGoal speichert keine Kundendaten – die DSGVO-Webhooks bestätigen nur.
  CUSTOMERS_DATA_REQUEST: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: async () => {},
  },
  CUSTOMERS_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: async () => {},
  },
  SHOP_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: async () => {},
  },
};

const app = express();

// OAuth-Routen
app.get(shopify.config.auth.path, shopify.auth.begin());

// Eigener Callback statt shopify.auth.callback():
// Seit 1.4.2026 MÜSSEN neue Public Apps ablaufende Offline-Tokens anfordern
// (expiring: true) – sonst lehnt Shopify alle GraphQL-Calls mit 403 ab.
// shopify-app-express reicht diese Option (Stand v6/v7) nicht durch.
shopify.api.webhooks.addHandlers(webhookHandlers);

app.get(shopify.config.auth.callbackPath, async (req, res) => {
  try {
    const callbackResponse = await shopify.api.auth.callback({
      rawRequest: req,
      rawResponse: res,
      expiring: true,
    });
    const session = callbackResponse.session;
    await sessionStorage.storeSession(session);

    try {
      await shopify.api.webhooks.register({ session });
    } catch (whErr) {
      console.error('[ShipGoal] Webhook-Registrierung fehlgeschlagen:', whErr);
    }

    let redirectUrl;
    try {
      redirectUrl = await shopify.api.auth.getEmbeddedAppUrl({
        rawRequest: req,
        rawResponse: res,
      });
    } catch (_e) {
      redirectUrl = `/?shop=${encodeURIComponent(session.shop)}`;
    }
    res.redirect(redirectUrl);
  } catch (e) {
    console.error('[ShipGoal] OAuth-Callback fehlgeschlagen:', e);
    res.status(500).send(`OAuth fehlgeschlagen: ${e.message}`);
  }
});

// Webhook-Verarbeitung (vor express.json(): braucht den rohen Body für HMAC)
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers })
);

// Healthcheck für Render
app.get('/healthz', (_req, res) => res.send('ok'));

// Ab hier: authentifizierte API-Routen (Session-Token aus App Bridge)
app.use('/api/*', shopify.validateAuthenticatedSession());
app.use(express.json());

// ---------------------------------------------------------------------------
// Plan-Metafield: macht den Plan im Theme lesbar als
//   {{ app.metafields.shipgoal.plan }}  ->  "free" | "pro"
// ---------------------------------------------------------------------------
async function syncPlanMetafield(session, plan) {
  const client = new shopify.api.clients.Graphql({ session });

  const current = await client.request(`{ currentAppInstallation { id } }`);
  const ownerId = current.data.currentAppInstallation.id;

  const result = await client.request(
    `mutation SetPlan($metafields: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $metafields) {
         userErrors { field message }
       }
     }`,
    {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: 'shipgoal',
            key: 'plan',
            type: 'single_line_text_field',
            value: plan,
          },
        ],
      },
    }
  );

  const errors = result.data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    console.error('[ShipGoal] Metafield-Fehler:', JSON.stringify(errors));
  }
}

// Aktuellen Plan aus den aktiven Managed-Pricing-Abos lesen
// (Abos heißen so wie die Pläne im Dev Dashboard, z. B. "Pro")
app.get('/api/plan', async (_req, res) => {
  try {
    const session = res.locals.shopify.session;
    const client = new shopify.api.clients.Graphql({ session });
    const r = await client.request(
      `{ currentAppInstallation { activeSubscriptions { name status } } }`
    );
    const subs = r.data?.currentAppInstallation?.activeSubscriptions || [];
    const hasPro = subs.some(
      (s) => s.status === 'ACTIVE' && /pro/i.test(s.name || '')
    );
    const plan = hasPro ? 'pro' : 'free';
    await syncPlanMetafield(session, plan);
    res.json({ plan, shop: session.shop, subscriptions: subs });
  } catch (e) {
    console.error('[ShipGoal] /api/plan:', e);
    res.status(500).json({ error: e.message });
  }
});

// Link zur Shopify-Plan-Auswahl (Managed Pricing) – Upgrade UND Downgrade
app.get('/api/pricing-url', (_req, res) => {
  const session = res.locals.shopify.session;
  const store = session.shop.replace('.myshopify.com', '');
  res.json({
    url: `https://admin.shopify.com/store/${store}/charges/${APP_HANDLE}/pricing_plans`,
  });
});

// ---------------------------------------------------------------------------
// Embedded Admin-UI
// ---------------------------------------------------------------------------
app.use(shopify.cspHeaders());

app.get('/', shopify.ensureInstalledOnShop(), (_req, res) => {
  const html = fs
    .readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8')
    .replace(/%SHOPIFY_API_KEY%/g, process.env.SHOPIFY_API_KEY || '');
  res.set('Content-Type', 'text/html').send(html);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// Sicherheitsnetz: Fehler loggen statt Prozess-Crash
process.on('unhandledRejection', (err) => {
  console.error('[ShipGoal] Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[ShipGoal] Uncaught Exception:', err);
});

app.listen(PORT, () => {
  console.log(`[ShipGoal] läuft auf Port ${PORT} (${HOST})`);
  console.log(`[ShipGoal] Billing: Shopify Managed Pricing (Handle: ${APP_HANDLE})`);
});
