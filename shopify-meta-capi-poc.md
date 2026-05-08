# Shopify → Meta CAPI — POC Engineering Brief

## 1. What This POC Proves

This document covers the minimal implementation required to prove that a Shopify store's paid orders can be reliably forwarded to Meta's Conversions API server-side, bypassing all the browser-level loss (iOS 14, ad blockers, cookie consent, page abandonment) that causes the ~50% discrepancy between Shopify order counts and Meta-reported conversions.

**This is not an MVP.** There is no database, no dashboard, no multi-platform support, no customer storage. It is a single Node.js service that receives a Shopify webhook, verifies it, and forwards a `Purchase` event to Meta CAPI. Its sole purpose is to validate the pipeline end-to-end with a real store and a real Meta pixel before any architectural decisions are locked in for the full product.

**What success looks like:** A paid Shopify order appears as a `Purchase` event in Meta Events Manager within seconds, with correct value, currency, and hashed user data, deduplicated against the browser pixel so Meta counts it once.

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

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Node.js** | Consistent with existing VPS deployments |
| Framework | **Express.js** | No overhead — this is a single webhook endpoint |
| Config | **dotenv** | All secrets via `.env`, never hardcoded |
| Logging | **Pino** | Structured JSON logs, fast, easy to grep by field |
| HTTP client | **Native fetch** (Node 18+) | No dependency needed for one API call |
| Process manager | **PM2** | Consistent with existing deployments |
| Reverse proxy | **Nginx** | Consistent with existing deployments |

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
│   │   ├── meta.js                  # CAPI payload construction + HTTP call
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

# --- Client: studio-hogo-client1 ---
CLIENT_SLUG=studio-hogo-client1
SHOPIFY_WEBHOOK_SECRET=your_shopify_signing_secret_here
META_PIXEL_ID=your_pixel_id_here
META_CAPI_TOKEN=your_capi_access_token_here
META_TEST_EVENT_CODE=TEST12345        # Leave empty in production
STORE_URL=https://client-store.myshopify.com
```

For the POC, a single client's credentials live directly in `.env`. When scaling to multiple clients, `config/clients.js` is extended — covered in Section 10.

---

## 6. Module Specifications

### 6.1 `src/middleware/rawBody.js`

**Purpose:** Express automatically parses the JSON request body and discards the raw bytes. Shopify computes the webhook signature against the exact raw bytes of the body — not the parsed object. Without the raw body, signature verification is impossible.

**Behavior:**
- Intercepts the request stream before any body parsing
- Collects all chunks into a buffer
- Attaches the buffer to `req.rawBody`
- Calls `next()` — Express JSON parsing proceeds normally afterward

**Applied to:** All routes globally on app startup. Must be registered before `express.json()`.

**Critical note:** This middleware must use `verify` option of `express.json()` rather than being a separate middleware, to guarantee the raw body is captured on the same pass as parsing. Both patterns work — the `verify` callback approach is slightly cleaner.

---

### 6.2 `src/services/shopify.js`

**Purpose:** Verify that an incoming webhook request genuinely originates from Shopify and has not been tampered with.

**Exported function:** `verifyWebhookSignature(rawBody, hmacHeader, secret)`

**How it works:**
- Computes `HMAC-SHA256(secret, rawBody)` using Node's built-in `crypto` module
- Base64-encodes the result
- Compares against the `X-Shopify-Hmac-SHA256` header value using `crypto.timingSafeEqual` — not `===`, to prevent timing attacks
- Throws an error if the comparison fails

**What the route does with it:** Wraps the call in a try/catch. On throw, responds `401` immediately and logs the attempt. No further processing occurs.

> `crypto.timingSafeEqual` requires both buffers to be the same length. Convert both strings to `Buffer.from(str)` before comparing — if lengths differ, reject immediately without calling `timingSafeEqual`.

---

### 6.3 `src/services/hash.js`

**Purpose:** Meta requires all PII fields in `user_data` to be SHA-256 hashed before transmission. Raw PII must never leave your server.

**Exported function:** `hashField(value)` — normalizes then hashes a single string value.

**Normalization rules applied before hashing (Meta's spec):**

| Field | Normalization |
|---|---|
| Email | Lowercase, trim whitespace |
| Phone | Strip all non-digit characters, prepend country code without `+` (e.g. `+33 6 12 34 56 78` → `33612345678`) |
| First / last name | Lowercase, trim whitespace |
| City | Lowercase, trim whitespace |
| Zip code | Lowercase, trim whitespace, remove spaces |
| Country | 2-letter ISO code, lowercase (e.g. `fr`, `us`, `dz`) |

**Hash algorithm:** SHA-256, hex digest (not base64).

**Null safety:** If a field is null, undefined, or empty string, return `null`. Never hash an empty string — Meta will flag it as an invalid hash.

---

### 6.4 `src/services/meta.js`

**Purpose:** Construct the CAPI event payload from a Shopify order object and the client config, then send it to Meta's Graph API.

**Exported function:** `sendPurchaseEvent(order, clientConfig)`

**Payload construction:**

```
{
  data: [{
    event_name:       "Purchase"
    event_time:       Unix timestamp — Math.floor(new Date(order.created_at) / 1000)
    event_id:         "shopify_" + order.id           ← deduplication key
    action_source:    "website"
    event_source_url: clientConfig.storeUrl

    user_data: {
      em:                   hash(order.email)
      ph:                   hash(order.billing_address.phone || order.phone)
      fn:                   hash(order.billing_address.first_name)
      ln:                   hash(order.billing_address.last_name)
      ct:                   hash(order.billing_address.city)
      zp:                   hash(order.billing_address.zip)
      country:              hash(order.billing_address.country_code.toLowerCase())
      client_ip_address:    order.browser_ip                ← not hashed
      client_user_agent:    order.client_details?.user_agent ← not hashed
    }

    custom_data: {
      currency:  order.currency
      value:     parseFloat(order.total_price)
      order_id:  String(order.id)
    }
  }]

  test_event_code: clientConfig.testEventCode   ← only if non-empty string
}
```

**Endpoint:** `POST https://graph.facebook.com/v19.0/{pixelId}/events`

**Authentication:** Access token passed as query parameter `access_token={capiToken}` (Meta's CAPI does not use Authorization header — it uses query param or body field).

**Response handling:**
- Log the full response body regardless of status
- On HTTP 4xx/5xx, log the error detail from Meta's response (`error.message`, `error.code`)
- Do not throw — a failed CAPI call should not crash the service or affect the 200 already sent to Shopify

**test_event_code behavior:** Include the field in the payload only when `clientConfig.testEventCode` is a non-empty string. In production this field must be absent entirely — not `null`, not `""`, fully absent.

---

### 6.5 `src/routes/webhook.js`

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
6. Log: order received — slug, order ID, order total, currency, customer IP
7. Call meta.sendPurchaseEvent(order, clientConfig) — do not await inline
   → Wrap in async IIFE, catch and log any unexpected errors
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
  "userAgent": "Mozilla/5.0 ...",
  "eventId": "shopify_12345678",
  "metaStatus": "ok",
  "metaEventsReceived": 1,
  "time": "2026-04-28T14:32:00.000Z"
}
```

**What never appears in logs:** Email, phone, name, address, or any raw PII. Only order ID, total, currency, IP, and Meta response metadata.

---

### 6.6 `config/clients.js`

**Purpose:** Single source of truth for client credentials. Reads from environment variables and exports a lookup function.

**For the POC (one client):**

```js
const clients = {
  [process.env.CLIENT_SLUG]: {
    shopifySecret:   process.env.SHOPIFY_WEBHOOK_SECRET,
    metaPixelId:     process.env.META_PIXEL_ID,
    metaCapiToken:   process.env.META_CAPI_TOKEN,
    testEventCode:   process.env.META_TEST_EVENT_CODE || '',
    storeUrl:        process.env.STORE_URL,
  }
}

module.exports = {
  getClient: (slug) => clients[slug] || null
}
```

No dynamic loading, no file watching, no database. When a new client is added, their credentials go into `.env` and `clients.js` is extended. Restart required — acceptable for POC scale.

---

### 6.7 `src/index.js`

**Purpose:** Application entry point. Wires everything together and starts the server.

**Responsibilities:**
- Register raw body middleware (before `express.json()`)
- Register `express.json()` for body parsing
- Mount webhook router at `/webhooks`
- Start listening on `process.env.PORT`
- Log startup info: port, Node environment, registered client slugs

**Startup validation:** On boot, iterate over all entries in `config/clients.js` and verify no required field is empty. If any credential is missing, log a clear error and exit with code 1. Better to fail fast on startup than to silently skip CAPI calls at runtime.

---

## 7. Shopify Webhook Setup

Do this after the service is deployed and reachable over HTTPS.

1. Log into the client's **Shopify Admin → Settings → Notifications**
2. Scroll to the **Webhooks** section at the bottom of the page
3. Click **Create webhook**
4. **Event:** `Order payment` — fires only when payment is confirmed. Do not use `orders/created` which fires for unpaid orders too
5. **Format:** `JSON`
6. **URL:** `https://capi.your-domain.com/webhooks/studio-hogo-client1/order-paid`
7. **Webhook API version:** Latest stable (e.g. `2024-04`)
8. Click **Save**

Shopify sends an automatic test ping on save. Expected responses:

| Response | Meaning |
|---|---|
| `200` | Service running, slug found, all good |
| `404` | Slug not found in `config/clients.js` |
| `401` | Signing secret is wrong or not yet set |
| Connection refused | Nginx not running or wrong port |

**Get the signing secret:**
After saving, click **Show signing key** on the webhook entry. Copy the value into `.env` as `SHOPIFY_WEBHOOK_SECRET`. Restart the service. Send another test ping — should return `200`.

---

## 8. Meta Setup

### 8.1 Collect credentials

| Item | Where | Goes into |
|---|---|---|
| Pixel ID | Events Manager → Data Sources → your pixel | `META_PIXEL_ID` in `.env` |
| CAPI Access Token | Events Manager → Settings → Conversions API → Generate token | `META_CAPI_TOKEN` in `.env` |
| Test Event Code | Events Manager → Test Events tab | `META_TEST_EVENT_CODE` in `.env` |

### 8.2 Generate the CAPI Access Token

1. Go to [business.facebook.com](https://business.facebook.com) → **Events Manager**
2. Select the client's Pixel from the Data Sources list
3. Click **Settings** tab
4. Scroll to **Conversions API** → click **Generate access token**
5. Copy it into `.env`

> ⚠️ This token has write access to the client's pixel. It lives only in `.env` on your server — never in code, never in git.

### 8.3 Verify the browser pixel is already active

Before CAPI is relevant, the browser pixel needs to be working:
1. Install **Meta Pixel Helper** Chrome extension
2. Visit the store, complete a test purchase
3. The extension should show a `Purchase` event firing on the Thank You page
4. If it doesn't, the pixel setup itself needs fixing first — separate from this POC

---

## 9. Browser Pixel Deduplication Update

The browser pixel fires a `Purchase` event on the Thank You page. Your CAPI service sends the same event server-side. Without a shared identifier, Meta counts it twice.

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

The `{{ checkout.order_id }}` Liquid variable outputs the Shopify numeric order ID. Your CAPI service constructs `event_id` as `"shopify_" + order.id` — they match exactly. Meta sees the same `event_id` from both paths and counts one conversion.

> This change must be coordinated with whoever manages the Shopify theme. Without it, every purchase will be counted twice in Meta reporting — worse than having no CAPI at all.

---

## 10. Deployment

### 10.1 Prerequisites

- Your VPS is already running two Node.js services on ports 3001 and 3002
- Nginx is installed and managing those services
- PM2 is installed globally
- Node.js 18+ is installed (required for native `fetch`)

### 10.2 Server Setup (one time)

```bash
# Upload or clone the project
cd /var/www   # or wherever your other services live
git clone <repo> shopify-meta-capi
cd shopify-meta-capi

# Install dependencies
npm install

# Create .env from template and fill in all values
cp .env.example .env
nano .env
```

### 10.3 PM2

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
pm2 save   # persist across reboots
pm2 logs shopify-meta-capi   # confirm startup logs look correct
```

### 10.4 Nginx

Add a new server block (or a location block on an existing domain). A dedicated subdomain is cleaner and gives you a professional URL to hand to clients:

```nginx
# /etc/nginx/sites-available/shopify-capi

server {
    listen 443 ssl;
    server_name capi.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location /webhooks/ {
        proxy_pass           http://localhost:3003;
        proxy_set_header     Host $host;
        proxy_set_header     X-Real-IP $remote_addr;
        proxy_set_header     X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 2M;
        proxy_buffering      off;   # Shopify needs a fast response, don't buffer
    }

    location / {
        return 404;   # This server does nothing except receive webhooks
    }
}

server {
    listen 80;
    server_name capi.your-domain.com;
    return 301 https://$host$request_uri;  # Shopify requires HTTPS
}
```

```bash
# Enable the config
ln -s /etc/nginx/sites-available/shopify-capi /etc/nginx/sites-enabled/

# Issue SSL cert if subdomain is new
certbot --nginx -d capi.your-domain.com

# Test and reload
nginx -t && systemctl reload nginx
```

### 10.5 Smoke Test

```bash
# Should return 404 (slug not found) — not a network error
curl -I https://capi.your-domain.com/webhooks/unknown-slug/order-paid

# Should return 401 (slug found, no HMAC header)
curl -X POST https://capi.your-domain.com/webhooks/studio-hogo-client1/order-paid \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

If both behave as expected, the service is live and correctly routing.

---

## 11. Testing

### 11.1 Full End-to-End Test

1. Set `META_TEST_EVENT_CODE` in `.env` to the value from Meta Events Manager → Test Events tab
2. Restart the service: `pm2 restart shopify-meta-capi`
3. Enable **Bogus Gateway** in Shopify Admin → Settings → Payments
4. Place a test order using card number `1` (payment success)
5. Watch logs in real time: `pm2 logs shopify-meta-capi`
6. Confirm the log shows: signature verified → CAPI call sent → Meta responded ok
7. Open Meta Events Manager → **Test Events** tab
8. The `Purchase` event should appear within a few seconds

**What to verify in Meta Test Events:**

| Field | Expected value |
|---|---|
| Event name | `Purchase` |
| Value | Order total matching Shopify |
| Currency | Correct currency code |
| `event_id` | `shopify_` + the Shopify order ID |
| `user_data.em` | Present, long hex string (hashed email) |
| `client_ip_address` | Present, matches customer IP |

### 11.2 Signature Verification Test

```bash
# Test with a tampered body — should return 401
curl -X POST https://capi.your-domain.com/webhooks/studio-hogo-client1/order-paid \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Hmac-SHA256: invalidsignature==" \
  -d '{"id": 99999, "total_price": "999.00"}'
```

If you get `401`, signature rejection is working. If you get `200`, the raw body middleware or the verification logic has a bug.

### 11.3 Deduplication Test

After the first real test order, check Meta Events Manager → Overview. The same order should show as **1** Purchase event, not 2. If it shows 2, the browser pixel `eventID` was not added (Section 9) or the `event_id` format doesn't match between pixel and CAPI.

### 11.4 Go Live

1. Set `META_TEST_EVENT_CODE=` (empty) in `.env`
2. `pm2 restart shopify-meta-capi`
3. Disable Bogus Gateway in Shopify Admin
4. Monitor for 24–48 hours: `pm2 logs shopify-meta-capi`
5. After 48 hours, compare Shopify order count to Meta Events Manager CAPI Purchase count — they should be within 5%

---

## 12. Scaling to Additional Clients

The POC is built so that adding a second or third client requires no code changes and no redeployment of the service — only config and a restart.

### What changes per new client

**1. Add their credentials to `.env`:**

```bash
# --- Client: client-two ---
CLIENT_TWO_SLUG=client-two
CLIENT_TWO_SHOPIFY_SECRET=...
CLIENT_TWO_META_PIXEL_ID=...
CLIENT_TWO_META_CAPI_TOKEN=...
CLIENT_TWO_TEST_EVENT_CODE=
CLIENT_TWO_STORE_URL=https://client-two.myshopify.com
```

**2. Extend `config/clients.js`:**

```js
const clients = {
  [process.env.CLIENT_SLUG]: {
    shopifySecret: process.env.SHOPIFY_WEBHOOK_SECRET,
    metaPixelId:   process.env.META_PIXEL_ID,
    metaCapiToken: process.env.META_CAPI_TOKEN,
    testEventCode: process.env.META_TEST_EVENT_CODE || '',
    storeUrl:      process.env.STORE_URL,
  },
  [process.env.CLIENT_TWO_SLUG]: {
    shopifySecret: process.env.CLIENT_TWO_SHOPIFY_SECRET,
    metaPixelId:   process.env.CLIENT_TWO_META_PIXEL_ID,
    metaCapiToken: process.env.CLIENT_TWO_META_CAPI_TOKEN,
    testEventCode: process.env.CLIENT_TWO_TEST_EVENT_CODE || '',
    storeUrl:      process.env.CLIENT_TWO_STORE_URL,
  }
}
```

**3. Restart the service:**
```bash
pm2 restart shopify-meta-capi
```

**4. Create the Shopify webhook for client two** pointing to their slug URL:
```
https://capi.your-domain.com/webhooks/client-two/order-paid
```

**5. Copy their signing secret into `.env`, restart again**

**6. Run the same end-to-end test from Section 11 for this client**

### Isolation guarantee

Because `getClient(slug)` looks up credentials by the URL slug, client A's webhook hitting `/webhooks/client-one/order-paid` will always load client one's Shopify secret for verification and client one's Pixel ID and CAPI token for the Meta call. There is no way for a request to accidentally use another client's credentials as long as the slug-to-config mapping is correct.

### The natural limit of this approach

This flat `.env` + `clients.js` pattern works cleanly up to roughly 5–6 clients. Beyond that, the env file becomes unwieldy and a database-backed config becomes the right move. That is precisely the transition point where the POC becomes an MVP and the full NestJS + Prisma + PostgreSQL architecture (with a management dashboard) takes over.

---

## 13. Known Limitations of This POC

These are deliberate omissions, not oversights. Each one is the right decision for a POC and the wrong decision for a production product.

| Limitation | Impact | Resolution in full product |
|---|---|---|
| No database | Customer data is not retained — orders are processed and discarded | PostgreSQL + Prisma in the full product |
| No dashboard | Adding clients requires SSH access | NestJS admin dashboard |
| Flat config | Does not scale beyond ~5 clients | Client table in the database |
| Meta only | TikTok and Snapchat CAPI not supported | Per-platform service modules |
| No retry logic | If the Meta CAPI call fails, the event is lost | Job queue (BullMQ) with retry in the full product |
| No attribution tracking | Referring site, UTM params, new vs returning not stored | Captured and stored in the customer/order DB tables |
| Single platform routing | One webhook, one destination per client | Multi-platform fan-out in the full product |

---

## 14. Out of Scope for This POC

- Customer data storage of any kind
- TikTok Conversions API
- Snapchat Conversions API
- Attribution and UTM tracking
- New vs returning customer detection
- Admin dashboard or any UI
- Retry logic for failed CAPI calls
- Multi-platform event fan-out
- Any form of authentication or access control
- Audience export or segmentation
