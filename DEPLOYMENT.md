# Deployment & Configuration Guide

## Step 1 — Collect credentials before touching the server

You need these in hand before starting.

**From Meta:**
1. Go to [business.facebook.com](https://business.facebook.com) → Events Manager
2. Select the client's pixel → **Settings** tab
3. Scroll to **Conversions API** → click **Generate access token** → copy it
4. Note the **Pixel ID** from the top of the page (numeric, e.g. `1234567890`)
5. Go to the **Test Events** tab → note the **Test event code** (e.g. `TEST12345`) — you'll use this during testing only

**From Shopify:**
- The store URL (e.g. `https://client-store.myshopify.com`)
- The webhook signing secret comes **after** you create the webhook in Step 6 — leave it blank for now

---

## Step 2 — Upload the project to the server

```bash
# SSH into your VPS
ssh user@your-server

# Go to wherever your other services live
cd /var/www

# Clone or upload the project
git clone <your-repo> shopify-meta-capi
cd shopify-meta-capi

# Install dependencies
npm install
```

---

## Step 3 — Create and fill the `.env` file

```bash
cp .env.example .env
nano .env
```

Fill it in:

```bash
NODE_ENV=production
PORT=3003

CLIENT_SLUG=studio-hogo-client1
SHOPIFY_WEBHOOK_SECRET=        # leave empty for now
META_PIXEL_ID=1234567890       # your pixel ID
META_CAPI_TOKEN=EAAxxxxx...    # the token from Step 1
META_TEST_EVENT_CODE=TEST12345 # from Meta Test Events tab
STORE_URL=https://client-store.myshopify.com
```

Save and exit (`Ctrl+X`, `Y`, `Enter`).

---

## Step 4 — Start the service with PM2

```bash
pm2 start ecosystem.config.js --env production
pm2 save   # persist across server reboots
```

Confirm it started correctly:

```bash
pm2 logs shopify-meta-capi --lines 20
```

You should see:

```json
{"port":"3003","nodeEnv":"production","clients":["studio-hogo-client1"],"msg":"Server started"}
```

If you see `Missing required field` instead, a value in `.env` is empty — fix it and run `pm2 restart shopify-meta-capi`.

---

## Step 5 — Configure Nginx

Create the Nginx config:

```bash
sudo nano /etc/nginx/sites-available/shopify-capi
```

Paste:

```nginx
server {
    listen 443 ssl;
    server_name capi.studio-hogo.com;

    ssl_certificate     /etc/letsencrypt/live/capi.studio-hogo.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/capi.studio-hogo.com/privkey.pem;

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

server {
    listen 80;
    server_name capi.studio-hogo.com;
    return 301 https://$host$request_uri;
}
```

Enable it and get an SSL certificate:

```bash
sudo ln -s /etc/nginx/sites-available/shopify-capi /etc/nginx/sites-enabled/

# If capi.your-domain.com is a new subdomain, issue a cert
sudo certbot --nginx -d capi.your-domain.com

# Test and reload
sudo nginx -t && sudo systemctl reload nginx
```

---

## Step 6 — Register the Shopify webhook

1. Go to **Shopify Admin → Settings → Notifications → Webhooks**
2. Click **Create webhook**
3. Set:
   - **Event:** `Order payment`
   - **Format:** `JSON`
   - **URL:** `https://capi.your-domain.com/webhooks/studio-hogo-client1/order-paid`
   - **API version:** latest stable
4. Click **Save**
5. Click **Show signing key** → copy the value
6. Back on the server, add it to `.env`:

```bash
nano /var/www/shopify-meta-capi/.env
# Set: SHOPIFY_WEBHOOK_SECRET=the_key_you_just_copied
```

```bash
pm2 restart shopify-meta-capi
```

7. Back in Shopify, click **Send test notification** on the webhook — it should return `200`

---

## Step 7 — Smoke test the endpoint

```bash
# 404 — unknown slug
curl -I https://capi.your-domain.com/webhooks/unknown-slug/order-paid

# 401 — correct slug, no signature
curl -X POST https://capi.your-domain.com/webhooks/studio-hogo-client1/order-paid \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

Both should behave as expected before continuing.

---

## Step 8 — Place a test order and verify in Meta

1. In Shopify Admin → **Settings → Payments** → enable **Bogus Gateway**
2. Open Meta Events Manager → **Test Events** tab — leave it open
3. Place a test order on the store using card number `1` (payment success)
4. Watch logs: `pm2 logs shopify-meta-capi`

You should see two log lines:

```
"msg":"Order received"            → signature verified, 200 sent to Shopify
"msg":"Meta CAPI call succeeded"  → metaStatus: ok, metaEventsReceived: 1
```

In the Meta Test Events tab, a `Purchase` event should appear within seconds with the correct value, currency, and `event_id`.

---

## Step 9 — Update the browser pixel for deduplication

In **Shopify Admin → Settings → Checkout → Order status page → Additional scripts**, update the pixel call:

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

Place another test order and confirm Meta Test Events shows **1** Purchase event, not 2.

---

## Step 10 — Go live

```bash
nano /var/www/shopify-meta-capi/.env
# Set: META_TEST_EVENT_CODE=   (empty)

pm2 restart shopify-meta-capi
```

Disable Bogus Gateway in Shopify Admin → Settings → Payments.

Monitor logs for 48 hours:

```bash
pm2 logs shopify-meta-capi
```

After 48 hours, compare Shopify order count to Meta Events Manager → CAPI Purchase count — they should be within 5%.

---

## Troubleshooting — orders missing from the logs

Work down this list in order. It is arranged so each step rules out one layer.

### 1. Is more than one backend answering the hostname?

The single most common cause of a *steady fraction* of orders going missing — especially a clean every-other-order pattern — is round-robin across two backends, where only one of them is the process you are reading logs from. The other answers `200`, so Shopify considers delivery successful and never retries.

```bash
# Each process reports its own bootId. If these alternate between two values,
# two different processes are serving this hostname.
for i in $(seq 1 10); do curl -s https://capi.studio-hogo.com/webhooks/health | jq -r .bootId; done

# Multiple A records = DNS round-robin
dig +short capi.studio-hogo.com

# More than one process bound to the port, or a stale deploy still running
pm2 list
sudo ss -lptn 'sport = :3003'
```

Expected: one bootId repeated ten times, one A record, one process.

### 2. Did the request reach Nginx at all?

```bash
# Count deliveries Nginx saw today, and their status codes
sudo grep "webhooks/jylor" /var/log/nginx/access.log | wc -l
sudo grep "webhooks/jylor" /var/log/nginx/access.log | awk '{print $9}' | sort | uniq -c
```

- **Nginx count matches Shopify's order count, app logs are lower** → the loss is between Nginx and Node.
- **Nginx count is also low** → the request never arrived; the problem is upstream (DNS, Shopify, or a firewall).

### 3. Did it reach the app?

Every request that reaches Express now logs `Webhook request arrived` *before* the body is parsed, carrying Shopify's `X-Shopify-Webhook-Id`. Every rejection after that also logs. So for any given order there are only two possibilities:

| Logs show | Meaning |
|---|---|
| `Webhook request arrived` and nothing else | body-parse failure — look for `Request rejected before handler` |
| `Unknown client slug` | wrong slug in the Shopify webhook URL |
| `Invalid webhook signature` | `SHOPIFY_WEBHOOK_SECRET` doesn't match the store's signing key |
| `No route matched` | wrong path in the Shopify webhook URL |
| nothing at all | the request never reached this process — go back to steps 1 and 2 |

```bash
# Counters since last restart
curl -s https://capi.studio-hogo.com/webhooks/health | jq '.counters, .byClient'

# Last 50 deliveries, for reconciling against the Shopify order list
curl -s https://capi.studio-hogo.com/webhooks/health | jq -r '.recent[] | "\(.at) \(.orderName)"'
```

### 4. Is Shopify sending them?

```bash
# Duplicate or stale subscriptions — there should be exactly one orders/paid
curl -s -X POST "https://16059b.myshopify.com/admin/api/2026-04/graphql.json" \
  -H "X-Shopify-Access-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ webhookSubscriptions(first:25){ edges{ node{ id topic createdAt endpoint{ __typename ... on WebhookHttpEndpoint { callbackUrl } } } } } }"}' | jq
```

Also check **Shopify Admin → Settings → Notifications → Webhooks** for a delivery-failure warning. Shopify retries a failing endpoint 19 times over 48 hours and then deletes the subscription outright.

Note that `orders/paid` fires on **payment capture**, not order creation. If the store uses manual capture, an order shows as Paid in the admin only once captured — and the webhook fires then, not at checkout.
