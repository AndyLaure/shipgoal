// ShipGoal / Versandziel – Backend
// Minimaler Express-Server: OAuth, Billing (Pro 2,99 €/Monat, 14 Tage Trial),
// Plan-Sync als App-Metafield (im Theme lesbar), Pflicht-Webhooks, embedded Admin-UI.
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const { shopifyApp } = require('@shopify/shopify-app-express');
const {
  LATEST_API_VERSION,
  DeliveryMethod,
  BillingInterval,
} = require('@shopify/shopify-api');
const {
  TursoSessionStorage,
  MemorySessionStorage,
} = require('./turso-session-storage');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = (process.env.HOST || 'http://localhost:3000').replace(/\/$/, '');
const PRO_PLAN = 'Pro';
// Testmodus ist Standard – erst beim Launch BILLING_TEST=false setzen!
const BILLING_TEST = process.env.BILLING_TEST !== 'false';

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
    apiVersion: LATEST_API_VERSION,
    scopes: (process.env.SCOPES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    hostName: HOST.replace(/^https?:\/\//, ''),
    billing: {
      [PRO_PLAN]: {
        amount: 2.99,
        currencyCode: 'EUR',
        interval: BillingInterval.Every30Days,
        trialDays: 14,
      },
    },
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
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);

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

// Aktuellen Plan abfragen (und Metafield synchron halten)
app.get('/api/plan', async (_req, res) => {
  try {
    const session = res.locals.shopify.session;
    const hasPro = await shopify.api.billing.check({
      session,
      plans: [PRO_PLAN],
      isTest: BILLING_TEST,
    });
    const plan = hasPro ? 'pro' : 'free';
    await syncPlanMetafield(session, plan);
    res.json({ plan, shop: session.shop, billingTest: BILLING_TEST });
  } catch (e) {
    console.error('[ShipGoal] /api/plan:', e);
    res.status(500).json({ error: e.message });
  }
});

// Upgrade auf Pro -> liefert confirmationUrl, Redirect macht das Frontend
app.post('/api/upgrade', async (_req, res) => {
  try {
    const session = res.locals.shopify.session;
    const confirmationUrl = await shopify.api.billing.request({
      session,
      plan: PRO_PLAN,
      isTest: BILLING_TEST,
      returnUrl: `${HOST}/?shop=${encodeURIComponent(session.shop)}`,
    });
    res.json({ confirmationUrl });
  } catch (e) {
    console.error('[ShipGoal] /api/upgrade:', e);
    res.status(500).json({ error: e.message });
  }
});

// Downgrade: alle aktiven Subscriptions kündigen, Plan-Metafield auf free
app.post('/api/downgrade', async (_req, res) => {
  try {
    const session = res.locals.shopify.session;
    const client = new shopify.api.clients.Graphql({ session });
    const r = await client.request(
      `{ currentAppInstallation { activeSubscriptions { id name } } }`
    );
    const subs = r.data?.currentAppInstallation?.activeSubscriptions || [];
    for (const sub of subs) {
      await client.request(
        `mutation Cancel($id: ID!) {
           appSubscriptionCancel(id: $id) {
             userErrors { field message }
           }
         }`,
        { variables: { id: sub.id } }
      );
    }
    await syncPlanMetafield(session, 'free');
    res.json({ plan: 'free' });
  } catch (e) {
    console.error('[ShipGoal] /api/downgrade:', e);
    res.status(500).json({ error: e.message });
  }
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

app.listen(PORT, () => {
  console.log(`[ShipGoal] läuft auf Port ${PORT} (${HOST})`);
  console.log(`[ShipGoal] Billing-Testmodus: ${BILLING_TEST}`);
});
