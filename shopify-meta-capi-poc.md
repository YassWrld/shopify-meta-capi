# Shopify → Meta CAPI — POC Engineering Brief

## 1. What This POC Proves

This document covers the minimal implementation required to prove that a Shopify store's paid orders can be reliably forwarded to Meta's Conversions API server-side, bypassing all the browser-level loss (iOS 14, ad blockers, cookie consent, page abandonment) that causes the ~50% discrepancy between Shopify order counts and Meta-reported conversions.

**This is not an MVP.** There is no database, no dashboard, no multi-platform support, no customer storage. It is a single Node.js service that receives a Shopify webhook, verifies it, and forwards two CAPI events to Meta per order. Its sole purpose is to validate the pipeline end-to-end with a real store and a real Meta pixel before any architectural decisions are locked in for the full product.

**What success looks like:** A paid Shopify order triggers two events in Meta Events Manager within seconds:
- A standard `Purchase` event — deduplicated against the browser pixel, used by Meta's algorithm for optimization
- A `NewCustomerPurchase` or `ReturningCustomerPurchase` custom event — used for segmented reporting and audience building

Both events carry correct value, currency, and hashed user data.

---

## 2. Context

Studio Hogo's marketing team is tracking a consistent ~50% gap between Shopify order counts and Meta-reported conversions for a client store. The suspected and confirmed causes are:

- iOS 14+ ATT — users denying tracking makes the browser pixel completely blind to their purchases
- Ad blockers (uBlock, Brave, Firefox ETP) stripping the pixel script
- Safari ITP degrading cookie lifetime and cross-site attribution
- Cookie consent banners — users declining prevent the pixel from loading

The solution is to run Meta's Conversions API in parallel with the existing browser pixel. The browser pixel continues to fire as-is. The server-side CAPI call provides a reliable redundant path. Meta deduplicates both using a shared `event_id`.

This POC targets a single client. A section at the end of this document covers what changes when deploying for additional clients using the same service.

---

## 3. Tech Stack

| Layer           | Choice                      | Notes                                             |
| --------------- | --------------------------- | ------------------------------------------------- |
| Runtime         | **Node.js**                 | Consistent with existing VPS deployments          |
| Framework       | **Express.js**              | No overhead — this is a single webhook endpoint   |
| Config          | **dotenv**                  | All secrets via `.env`, never hardcoded           |
| Logging         | **Pino**                    | Structured JSON logs, fast, easy to grep by field |
| HTTP client     | **Native fetch** (Node 18+) | No dependency needed for one API call             |
| Process manager | **PM2**                     | Consistent with existing deployments              |
| Reverse proxy   | **Nginx**                   | Consistent with existing deployments              |

No database. No ORM. No queue. No authentication layer. Those belong in the full product, not this POC.

---

## 4. Project Structure

```
shopify-meta-capi/
├── src/
│   ├── index.js                     # Express app entry, registers middleware and routes
│   ├── routes/
│   │   └── webhook.js               # POST /webhooks/:clientSlug/order-paid
│   ├── services/
│   │   ├── shopify.js               # HMAC-SHA256 signature verification
│   │   ├── meta.js                  # CAPI payload construction + HTTP calls (two events)
│   │   └── hash.js                  # SHA-256 normalization and hashing of PII fields
│   └── middleware/
│       └── rawBody.js               # Captures raw body buffer before JSON parsing
│
├── config/
│   └── clients.js                   # Client credentials loaded from environment
│
├── .env                             # Secrets — never committed to git
├── .env.example                     # Template — committed to git
├── .gitignore
├── package.json
└── ecosystem.config.js              # PM2 process config
```

The structure is deliberately flat. There are no unnecessary abstractions. Every file has one clear responsibility. The `config/clients.js` file is the only thing that changes when adding a second or third client.

---

## 5. Environment Variables

```bash
# .env.example

NODE_ENV=production
PORT=3003

# --- Client 1 (numbered convention: CLIENT_1_*, CLIENT_2_*, ...) ---
CLIENT_1_SLUG=studio-hogo-client1
CLIENT_1_SHOPIFY_WEBHOOK_SECRET=your_shopify_signing_secret_here
CLIENT_1_META_PIXEL_ID=your_pixel_id_here
CLIENT_1_META_CAPI_TOKEN=your_capi_access_token_here
CLIENT_1_META_TEST_EVENT_CODE=TEST12345        # Leave empty in production
CLIENT_1_STORE_URL=https://client-store.myshopify.com
CLIENT_1_SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CLIENT_1_SHOPIFY_STORE_DOMAIN=client-store.myshopify.com
```

Each client is one numbered group. `SHOPIFY_ADMIN_TOKEN` (a merchant-installed custom app token, scope `read_customers`) and `SHOPIFY_STORE_DOMAIN` power the new-vs-returning lookup (Section 7.2). Add a second client by appending a `CLIENT_2_*` block and restarting — `config/clients.js` auto-discovers it, no code change. Legacy unprefixed / `CLIENT_TWO_*` names still work. See Section 12.

---

## 6. Dual Event Strategy

For every paid Shopify order, the service fires **two separate CAPI events** to Meta:

### Event 1 — Standard `Purchase`
The standard Meta event used by Meta's algorithm for campaign optimization, value-based bidding, and ROAS reporting. This is what Meta's ad delivery algorithm reads to optimize campaigns. Deduplicated against the browser pixel via `event_id`.

### Event 2 — `NewCustomerPurchase` or `ReturningCustomerPurchase`
A custom event used purely for segmentation and reporting. The customer type is determined by a **Shopify Admin GraphQL lookup** (`getCustomerOrdersCount`), not by the webhook payload — the `orders/paid` payload does not carry a usable order count for the customer (see 7.2). The lookup searches customers by the order's email and sums `numberOfOrders` across all matching records:
- total orders `> 1` → `ReturningCustomerPurchase`
- total orders `0` or `1`, customer not found, or any lookup failure → `NewCustomerPurchase` (safe default)

> **Why an API call instead of the payload:** the modern `orders/paid` webhook payload has no `customer.orders_count` field, so classification requires the Admin API. The store-level webhook can't read it, but a merchant-installed custom app (scope `read_customers`) can. Its Admin token and store domain live in `config/clients.js` per client.

### Why both and not just the custom event

Meta's optimization algorithm is trained on the standard `Purchase` event. Replacing it with a custom event name degrades campaign performance — Meta loses years of optimization signal. The custom event runs alongside `Purchase`, never instead of it.

### What this enables for marketers

| Capability                                             | How                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Separate reporting per customer type                   | Custom Conversions based on `NewCustomerPurchase` / `ReturningCustomerPurchase` |
| Exclude returning customers from acquisition campaigns | Audience from `ReturningCustomerPurchase` → exclusion list                      |
| Retarget returning customers separately                | Audience from `ReturningCustomerPurchase` → dedicated retargeting campaign      |
| New customer ROAS vs returning customer ROAS           | Two custom conversion columns in Ads Manager                                    |

---

## 7. Module Specifications

### 7.1 `src/middleware/rawBody.js`

**Purpose:** Express automatically parses the JSON request body and discards the raw bytes. Shopify computes the webhook signature against the exact raw bytes of the body — not the parsed object. Without the raw body, signature verification is impossible.

**Behavior:**
- Intercepts the request stream before any body parsing
- Collects all chunks into a buffer
- Attaches the buffer to `req.rawBody`
- Calls `next()` — Express JSON parsing proceeds normally afterward

**Applied to:** All routes globally on app startup. Must be registered before `express.json()`.

**Critical note:** This middleware must use the `verify` option of `express.json()` rather than being a separate middleware, to guarantee the raw body is captured on the same pass as parsing.

---

### 7.2 `src/services/shopify.js`

**Purpose:** Verify that an incoming webhook request genuinely originates from Shopify and has not been tampered with.

**Exported function:** `verifyWebhookSignature(rawBody, hmacHeader, secret)`

**How it works:**
- Computes `HMAC-SHA256(secret, rawBody)` using Node's built-in `crypto` module
- Base64-encodes the result
- Compares against the `X-Shopify-Hmac-SHA256` header value using `crypto.timingSafeEqual` — not `===`, to prevent timing attacks
- Throws an error if the comparison fails

**What the route does with it:** Wraps the call in a try/catch. On throw, responds `401` immediately and logs the attempt. No further processing occurs.

> `crypto.timingSafeEqual` requires both buffers to be the same length. Convert both strings to `Buffer.from(str)` before comparing — if lengths differ, reject immediately without calling `timingSafeEqual`.

**Exported function:** `getCustomerOrdersCount(email, clientConfig)` — determines whether the buyer is `"new"` or `"returning"` via the Shopify Admin GraphQL API. Returns the string `"new"` or `"returning"` directly (never the raw count), and **never throws** — every failure path falls back to `"new"`.

**How it works:**
- POSTs to `https://{shopifyStoreDomain}/admin/api/2026-04/graphql.json` with header `X-Shopify-Access-Token: {shopifyAdminToken}`.
- Query: `customers(first:10, query:"email:\"<email>\""){ edges{ node{ id numberOfOrders } } }`.
- **Sums `numberOfOrders` across all matching customer records.** Guest checkouts can create multiple records for the same person (each with `numberOfOrders = 1`); summing prevents a returning guest from being misread as new. Total `> 1` → `"returning"`, otherwise `"new"`.
- **Timeout:** the `fetch` runs under an `AbortController` with a 3s timeout so a stalled lookup can never block the Meta send.
- **Throttle handling:** on HTTP 429 or a `THROTTLED` GraphQL error it retries up to 2× with exponential backoff (500ms, 1000ms) before defaulting.
- **Distinct outcomes, each logged:** HTTP error, GraphQL/throttle error, malformed response, non-numeric count (all → failure fallback `"new"`); empty result set → genuine `"new"` (customer not found); success → `records=N totalOrders=M customerType=…`.

> `numberOfOrders` is returned by Shopify as a **string** (e.g. `"3"`); it is coerced with `Number(...)` before summing.
> The caller passes `order.email || order.contact_email` — guest checkouts leave `order.email` empty and put the address in `contact_email`; using only `order.email` would default every guest order to `"new"`.

---

### 7.3 `src/services/hash.js`

**Purpose:** Meta requires all PII fields in `user_data` to be SHA-256 hashed before transmission. Raw PII must never leave your server.

**Exported function:** `hashField(value)` — normalizes then hashes a single string value.

**Normalization rules applied before hashing (Meta's spec):**

| Field             | Normalization                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Email             | Lowercase, trim whitespace                                                                                  |
| Phone             | Strip all non-digit characters, prepend country code without `+` (e.g. `+33 6 12 34 56 78` → `33612345678`) |
| First / last name | Lowercase, trim whitespace                                                                                  |
| City              | Lowercase, trim whitespace                                                                                  |
| Zip code          | Lowercase, trim whitespace, remove spaces                                                                   |
| Country           | 2-letter ISO code, lowercase (e.g. `fr`, `us`, `dz`)                                                        |

**Hash algorithm:** SHA-256, hex digest (not base64).

**Null safety:** If a field is null, undefined, or empty string, return `null`. Never hash an empty string — Meta will flag it as an invalid hash.

---

### 7.4 `src/services/meta.js`

**Purpose:** Construct and send two CAPI events to Meta's Graph API for every Shopify order — one standard `Purchase` and one customer-type custom event.

**Exported function:** `sendPurchaseEvent(order, clientConfig, customerType, logger)`

**Customer type:** passed in as the `customerType` argument — the `"new"` / `"returning"` string produced by `getCustomerOrdersCount` (see 7.2) and resolved in the route before this is called. `meta.js` no longer computes it from the payload.
```
customerType === "returning"  →  customEventName = "ReturningCustomerPurchase"
customerType === "new" (or anything else)  →  customEventName = "NewCustomerPurchase" (safe default)
```

**Order ID extraction:** Shopify order IDs can exceed JavaScript's `Number.MAX_SAFE_INTEGER`. Parsing the JSON body as a number loses precision, which breaks the `event_id` deduplication match with the browser pixel. Always extract the order ID as a string from `order.admin_graphql_api_id`:
```
orderId = order.admin_graphql_api_id.split('/').pop()
// "gid://shopify/Order/820982911946154508" → "820982911946154508"
// Fallback: String(order.id) if admin_graphql_api_id is absent
```

**Shared user_data block** — built once, used in both events:
```
user_data: {
  em:                   hash(order.email || order.contact_email)  ← contact_email fallback for guest checkouts
  ph:                   hash(order.billing_address.phone || order.phone)
  fn:                   hash(order.billing_address.first_name)
  ln:                   hash(order.billing_address.last_name)
  ct:                   hash(order.billing_address.city)
  st:                   hash(order.billing_address.province_code)  ← state/province, lowercase
  zp:                   hash(order.billing_address.zip)
  country:              hash(order.billing_address.country_code.toLowerCase())
  client_ip_address:    order.browser_ip                 ← not hashed
  client_user_agent:    order.client_details?.user_agent ← not hashed
}
```

**Event 1 payload — standard Purchase:**
```
{
  event_name:       "Purchase"
  event_time:       Math.floor(new Date(order.created_at) / 1000)
  event_id:         "shopify_" + orderId        ← deduplication key with browser pixel
  action_source:    "website"
  event_source_url: clientConfig.storeUrl
  user_data:        <shared block above>
  custom_data: {
    currency:          order.currency
    value:             parseFloat(order.total_price)
    order_id:          orderId
    new_vs_returning:  customerType   ← "new" or "returning" string (replaces the old new_customer boolean)
  }
}
```

**Event 2 payload — custom customer type event:**
```
{
  event_name:       "NewCustomerPurchase" | "ReturningCustomerPurchase"
  event_time:       Math.floor(new Date(order.created_at) / 1000)
  event_id:         "shopify_custom_" + orderId   ← different event_id, not deduplicated
  action_source:    "website"
  event_source_url: clientConfig.storeUrl
  user_data:        <same shared block>
  custom_data: {
    currency:  order.currency
    value:     parseFloat(order.total_price)
    order_id:  orderId
  }
}
```

**Both events are sent in a single API call** — Meta's CAPI endpoint accepts an array of up to 1000 events per request. Send them together in the `data` array rather than two separate HTTP calls:

```
POST https://graph.facebook.com/v21.0/{pixelId}/events
body: {
  data: [ event1_Purchase, event2_CustomerType ],
  access_token: capiToken,
  test_event_code: ...   ← only if non-empty
}
```

**Authentication:** Access token passed as body field or query parameter `access_token={capiToken}`.

**Response handling:**
- Log the full response body regardless of status
- On HTTP 4xx/5xx, log the error detail from Meta's response (`error.message`, `error.code`)
- Do not throw — a failed CAPI call must not crash the service or affect the 200 already sent to Shopify

**test_event_code behavior:** Include the field only when `clientConfig.testEventCode` is a non-empty string. In production this field must be fully absent — not `null`, not `""`.

---

### 7.5 `src/routes/webhook.js`

**Purpose:** The single route handler. Orchestrates the full pipeline for an incoming Shopify order webhook.

**Route:** `POST /webhooks/:clientSlug/order-paid`

**Pipeline — strict order:**

```
1. Extract :clientSlug from req.params
2. Look up client config from config/clients.js
   → If not found: respond 404, log unknown slug, return
3. Verify HMAC signature
   → If invalid: respond 401, log the attempt with slug, return
4. Respond 200 OK immediately
   ← Shopify considers the webhook delivered at this point
5. Parse req.body (already parsed by Express, use as-is)
6. In an async IIFE (do not await inline):
   a. customerType = await getCustomerOrdersCount(order.email || order.contact_email, clientConfig)
      → email fallback is required for guest checkouts (see 7.2); the call never throws and is bounded by a 3s timeout
   b. Log: order received — slug, order ID, order total, currency, customer IP, customer type
   c. Call meta.sendPurchaseEvent(order, clientConfig, customerType, logger)
   → Wrap in try/catch, log any unexpected errors. Because the lookup is timeout-bounded and always resolves, it can never block or drop the Meta send.
```

**Why respond 200 before the Meta call:** Shopify has a 5-second response timeout. If your endpoint exceeds it, Shopify marks the delivery as failed and retries — sending the same order to Meta twice. Always acknowledge Shopify first, process Meta asynchronously.

**What to log (structured JSON via Pino):**

```json
{
  "level": "info",
  "client": "studio-hogo-client1",
  "orderId": "12345678",
  "orderTotal": "89.99",
  "currency": "EUR",
  "customerIp": "82.45.12.200",
  "customerType": "new",
  "eventId": "shopify_12345678",
  "metaStatus": "ok",
  "metaEventsReceived": 2,
  "time": "2026-04-28T14:32:00.000Z"
}
```

Note `metaEventsReceived: 2` — Meta confirms receipt of both events in the same response.

**What never appears in logs:** Email, phone, name, address, or any raw PII. Only order ID, total, currency, IP, customer type, and Meta response metadata.

---

### 7.6 `config/clients.js`

**Purpose:** Single source of truth for client credentials. Builds the client registry from environment variables at startup and exports `getClient(slug)`.

**Per-client fields** (seven): `shopifySecret`, `metaPixelId`, `metaCapiToken`, `testEventCode`, `storeUrl`, and — for the customer-type lookup — `shopifyAdminToken` and `shopifyStoreDomain`.

**Auto-discovery:** clients are discovered from **numbered env groups** `CLIENT_1_*`, `CLIENT_2_*`, `CLIENT_3_*`, … There is no fixed slot count — add another numbered block to `.env` and it is picked up on the next restart. A group with **no `_SLUG` is skipped**, so a half-configured client never registers and never crashes startup. Legacy names (`CLIENT_SLUG` + unprefixed, and `CLIENT_TWO_*` / `CLIENT_THREE_*`) remain honored for backward compatibility, with numbered entries taking precedence.

```js
function buildConfig(prefix) {
  return {
    shopifySecret:      process.env[`${prefix}SHOPIFY_WEBHOOK_SECRET`],
    metaPixelId:        process.env[`${prefix}META_PIXEL_ID`],
    metaCapiToken:      process.env[`${prefix}META_CAPI_TOKEN`],
    testEventCode:      process.env[`${prefix}META_TEST_EVENT_CODE`] || '',
    storeUrl:           process.env[`${prefix}STORE_URL`],
    shopifyAdminToken:  process.env[`${prefix}SHOPIFY_ADMIN_TOKEN`],
    shopifyStoreDomain: process.env[`${prefix}SHOPIFY_STORE_DOMAIN`],
  }
}

const clients = {}
// Numbered clients: CLIENT_1_*, CLIENT_2_*, ... discovered from env.
Object.keys(process.env)
  .map((k) => k.match(/^CLIENT_(\d+)_SLUG$/))
  .filter(Boolean)
  .map((m) => Number(m[1]))
  .sort((a, b) => a - b)
  .forEach((i) => {
    const slug = process.env[`CLIENT_${i}_SLUG`]
    if (slug) clients[slug] = buildConfig(`CLIENT_${i}_`)
  })
// (legacy CLIENT_SLUG / CLIENT_TWO_ / CLIENT_THREE_ also honored — see source)

module.exports = { getClient: (slug) => clients[slug] || null, clients }
```

No file watching, no database. Adding a client is `.env`-only; **restart required** to pick it up — acceptable for POC scale. This flat pattern holds to ~5–6 clients before credentials should move to a database.

---

### 7.7 `src/index.js`

**Purpose:** Application entry point. Wires everything together and starts the server.

**Responsibilities:**
- Register raw body middleware (before `express.json()`)
- Register `express.json()` for body parsing
- Mount webhook router at `/webhooks`
- Start listening on `process.env.PORT`
- Log startup info: port, Node environment, registered client slugs

**Startup validation:** On boot, iterate over all entries in `config/clients.js` and verify no required field is empty. If any credential is missing, log a clear error and exit with code 1. Better to fail fast on startup than to silently skip CAPI calls at runtime.

---

## 8. Shopify Webhook Setup

Do this after the service is deployed and reachable over HTTPS.

1. Log into the client's **Shopify Admin → Settings → Notifications**
2. Scroll to the **Webhooks** section at the bottom of the page
3. Click **Create webhook**
4. **Event:** `Order payment` — fires only when payment is confirmed. Do not use `orders/created` which fires for unpaid orders too
5. **Format:** `JSON`
6. **URL:** `https://capi.studio-hogo.com/webhooks/{client-slug}/order-paid`
7. **Webhook API version:** Latest stable (e.g. `2024-04`)
8. Click **Save**

Shopify sends an automatic test ping on save. Expected responses:

| Response           | Meaning                                |
| ------------------ | -------------------------------------- |
| `200`              | Service running, slug found, all good  |
| `404`              | Slug not found in `config/clients.js`  |
| `401`              | Signing secret is wrong or not yet set |
| Connection refused | Nginx not running or wrong port        |

**Get the signing secret:**
After saving, click **Show signing key** on the webhook entry. Copy the value into `.env` as `SHOPIFY_WEBHOOK_SECRET`. Restart the service.

---

## 9. Meta Setup

### 9.1 Collect credentials

| Item              | Where                                                        | Goes into                        |
| ----------------- | ------------------------------------------------------------ | -------------------------------- |
| Pixel ID          | Events Manager → Data Sources → your pixel                   | `META_PIXEL_ID` in `.env`        |
| CAPI Access Token | Events Manager → Settings → Conversions API → Generate token | `META_CAPI_TOKEN` in `.env`      |
| Test Event Code   | Events Manager → Test Events tab                             | `META_TEST_EVENT_CODE` in `.env` |

### 9.2 Generate the CAPI Access Token

1. Go to [business.facebook.com](https://business.facebook.com) → **Events Manager**
2. Select the client's Pixel from the Data Sources list
3. Click **Settings** tab
4. Scroll to **Conversions API** → click **Generate access token**
5. Copy it into `.env`

> ⚠️ This token has write access to the client's pixel. It lives only in `.env` on your server — never in code, never in git.

### 9.3 Setting up Custom Conversions for the new events

After the first real orders come through, set up Custom Conversions in Meta so marketers can use `NewCustomerPurchase` and `ReturningCustomerPurchase` in their reporting:

1. Events Manager → **Custom Conversions** → Create
2. Set event to `NewCustomerPurchase` → name it "New Customer Purchase" → Save
3. Repeat for `ReturningCustomerPurchase` → name it "Returning Customer Purchase"

These custom conversions then become available as columns in Ads Manager reporting and as objectives for campaigns.

### 9.4 Verify the browser pixel is already active

Before CAPI is relevant, the browser pixel needs to be working:
1. Install **Meta Pixel Helper** Chrome extension
2. Visit the store, complete a test purchase
3. The extension should show a `Purchase` event firing on the Thank You page
4. If it doesn't, the pixel setup itself needs fixing first — separate from this POC

---

## 10. Browser Pixel Deduplication Update

The browser pixel fires a `Purchase` event on the Thank You page. Your CAPI service sends the same `Purchase` event server-side. Without a shared identifier, Meta counts it twice.

The fix is a one-line change in the Shopify theme's order status page — either in `order-status.liquid` or in the **Additional Scripts** field at Admin → Settings → Checkout → Order status page.

**Before:**
```js
fbq('track', 'Purchase', {
  value: {{ checkout.total_price | money_without_currency }},
  currency: '{{ shop.currency }}'
});
```

**After:**
```js
fbq('track', 'Purchase', {
  value: {{ checkout.total_price | money_without_currency }},
  currency: '{{ shop.currency }}'
}, {
  eventID: 'shopify_{{ checkout.order_id }}'
});
```

The `{{ checkout.order_id }}` Liquid variable outputs the Shopify numeric order ID. Your CAPI service constructs `event_id` as `"shopify_" + order.id` — they match exactly. Meta deduplicates and counts one `Purchase`.

The custom events (`NewCustomerPurchase` / `ReturningCustomerPurchase`) use a different `event_id` format (`shopify_custom_` + order.id) and are server-side only — no browser pixel equivalent, no deduplication needed.

> This change must be coordinated with whoever manages the Shopify theme. Without it, every purchase will be counted twice in Meta reporting.

---

## 11. Deployment

### 11.1 Prerequisites

- VPS running with `hogo` user created and SSH access configured
- Nginx installed
- PM2 installed under `hogo` user
- Node.js 18+ installed
- `capi.studio-hogo.com` DNS A record pointing to `109.228.48.216`

### 11.2 Server Setup

```bash
ssh hogo@109.228.48.216
cd /home/hogo

git clone <repo> shopify-meta-capi
cd shopify-meta-capi

npm install
cp .env.example .env
nano .env
```

### 11.3 PM2

```js
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'shopify-meta-capi',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    env_production: {
      NODE_ENV: 'production'
    }
  }]
}
```

```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 logs shopify-meta-capi --lines 20
```

Expected startup log:
```json
{"port":"3003","nodeEnv":"production","clients":["jylor"],"msg":"Server started"}
```

### 11.4 Nginx

```bash
sudo nano /etc/nginx/sites-available/shopify-capi
```

Paste (HTTP only — Certbot adds SSL automatically):

```nginx
server {
    listen 80;
    server_name capi.studio-hogo.com;

    location /webhooks/ {
        proxy_pass           http://localhost:3003;
        proxy_set_header     Host $host;
        proxy_set_header     X-Real-IP $remote_addr;
        proxy_set_header     X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 2M;
        proxy_buffering      off;
    }

    location / {
        return 404;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/shopify-capi /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d capi.studio-hogo.com
```

### 11.5 Smoke Tests

```bash
# 404 — unknown slug
curl -I https://capi.studio-hogo.com/webhooks/unknown-slug/order-paid

# 401 — slug found, no signature
curl -X POST https://capi.studio-hogo.com/webhooks/jylor/order-paid \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

---

## 12. Testing

### 12.1 What to verify in Meta Test Events

With `META_TEST_EVENT_CODE` set, place a test order. In Meta Events Manager → Test Events tab, you should see **two events** appear for the same order:

| Event                                                | event_id format           | Expected                                                |
| ---------------------------------------------------- | ------------------------- | ------------------------------------------------------- |
| `Purchase`                                           | `shopify_12345678`        | value, currency, hashed user_data, new_customer boolean |
| `NewCustomerPurchase` or `ReturningCustomerPurchase` | `shopify_custom_12345678` | value, currency, hashed user_data                       |

### 12.2 What to verify in logs

```json
{"msg":"Order received", "client":"jylor", "orderId":"...", "customerType":"new", ...}
{"msg":"Meta CAPI call succeeded", "metaEventsReceived": 2, ...}
```

`metaEventsReceived: 2` confirms Meta received both events in the same call.

### 12.3 Deduplication check

After adding the `eventID` to the browser pixel, place a test order and confirm Meta Test Events shows:
- `Purchase` → **1 event** (not 2 — deduplicated with browser pixel)
- `NewCustomerPurchase` or `ReturningCustomerPurchase` → **1 event** (server-side only, no dedup needed)

### 12.4 Go live

```bash
nano .env
# META_TEST_EVENT_CODE=   ← empty

pm2 restart shopify-meta-capi
```

Monitor for 48 hours. After 48 hours compare Shopify order count to Meta CAPI `Purchase` event count — should be within 5%.

---

## 13. Scaling to Additional Clients

**1. Add credentials to `.env`:**

```bash
CLIENT_TWO_SLUG=client-two
CLIENT_TWO_SHOPIFY_SECRET=...
CLIENT_TWO_META_PIXEL_ID=...
CLIENT_TWO_META_CAPI_TOKEN=...
CLIENT_TWO_TEST_EVENT_CODE=
CLIENT_TWO_STORE_URL=https://client-two.com
```

**2. Extend `config/clients.js`** with a new entry block.

**3. Restart:** `pm2 restart shopify-meta-capi`

**4. Create Shopify webhook** pointing to:
```
https://capi.studio-hogo.com/webhooks/client-two/order-paid
```

**5. Copy signing secret into `.env`, restart, run test flow.**

The dual event logic (`Purchase` + customer type custom event) applies automatically to all clients — no per-client configuration needed.

### Natural limit of this approach

The flat `.env` + `clients.js` pattern works cleanly up to ~5–6 clients. Beyond that, credentials move into a database. That is the transition point where this POC becomes an MVP with the full NestJS + Prisma + PostgreSQL architecture.

---

## 14. Known Limitations of This POC

| Limitation              | Impact                                | Resolution in full product     |
| ----------------------- | ------------------------------------- | ------------------------------ |
| No database             | Customer data not retained            | PostgreSQL + Prisma            |
| No dashboard            | Adding clients requires SSH           | NestJS admin dashboard         |
| Flat config             | Doesn't scale beyond ~5 clients       | Client table in DB             |
| Meta only               | No TikTok or Snapchat CAPI            | Per-platform service modules   |
| No retry logic          | Failed CAPI call = lost event         | BullMQ job queue with retry    |
| No attribution tracking | UTM params, referring site not stored | Captured in DB in full product |
| Single platform routing | One webhook, one destination          | Multi-platform fan-out         |

---

## 15. Out of Scope for This POC

- Customer data storage of any kind
- TikTok Conversions API
- Snapchat Conversions API
- Attribution and UTM tracking
- Admin dashboard or any UI
- Retry logic for failed CAPI calls
- Multi-platform event fan-out
- Any form of authentication or access control
- Audience export or segmentation

---

## 16. Changelog — new-vs-returning reliability fixes

Post-launch, Meta showed missing/incorrect new-vs-returning events. Root cause: the customer type had been switched from the webhook payload to a Shopify Admin GraphQL lookup, and that lookup had several failure modes that all silently defaulted to `"new"`. The following fixes were applied (all in `src/services/shopify.js` unless noted):

| # | Fix | What it addresses |
| - | --- | ----------------- |
| **B1** | Look up by `order.email \|\| order.contact_email` (`src/routes/webhook.js`) | Guest checkouts leave `order.email` empty; the lookup was skipped and defaulted to `"new"`, so returning customers were never detected. **Highest-impact fix.** |
| **2** | 3s `AbortController` timeout on the lookup `fetch` | A stalled Shopify call could hang the `await` and cause an order to send **no events at all**. The lookup is now timeout-bounded and always resolves, so it can never block or drop the Meta send. |
| **3** | Distinct, logged outcomes | "Customer genuinely not found" (legit `"new"`) is now separated from real failures (HTTP error, GraphQL/throttle error, malformed response, non-numeric count). Failures still default to `"new"` but log *why*, making misclassification measurable. |
| **B4** | Sum `numberOfOrders` across all email-matched records (`first:10`) | Guest checkouts can create multiple 1-order customer records for the same person; reading a single record misread returning guests as new. Summing catches the duplicate case and stays correct when records are consolidated. |
| **5** | Retry on throttle (2× exponential backoff) | Shopify GraphQL is cost-rate-limited; a `THROTTLED` / HTTP 429 response previously fell through to `"new"`. It now retries (500ms, 1000ms) before defaulting. |
| **6** | Meta Graph API `v19.0` → `v21.0` (`src/services/meta.js`) | Version hygiene / avoid deprecation. |

**Also changed earlier (not defects):**
- `sendPurchaseEvent(order, clientConfig, customerType, logger)` — customer type is now passed in as a `"new"`/`"returning"` string; `custom_data.new_customer` (boolean) replaced by `custom_data.new_vs_returning` (string).
- `config/clients.js` — numbered auto-discovery of clients (Section 7.6); added per-client `shopifyAdminToken` and `shopifyStoreDomain`.

**Known non-issues (deliberately not "fixed"):**
- A young store with genuinely few repeat buyers will correctly emit few/no `ReturningCustomerPurchase` events — that is accurate, not a bug.
- `numberOfOrders` arriving as a string is handled by `Number(...)`.
- Reverting to `order.customer.orders_count` is not viable — that field is not present in the modern `orders/paid` payload.

### Separate issue: Meta `Purchase` count exceeds Shopify orders (over-counting)
This is **not** a service-code defect — our `event_id` (`shopify_<orderId>`) is correct. It is caused by duplicate event *sources* on the pixel: (a) the browser pixel not carrying the shared `eventID` (`shopify_{{ checkout.order_id }}`) so it doesn't deduplicate against CAPI, and/or (b) a second integration (e.g. the "Facebook & Instagram" sales channel or a pixel app) also sending `Purchase`. Resolve in Meta Events Manager / the theme — one server source (this service) plus one deduplicated browser source per pixel.