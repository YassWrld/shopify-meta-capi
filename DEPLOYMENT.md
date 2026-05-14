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
