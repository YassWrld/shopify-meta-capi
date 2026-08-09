// config/clients.js
//
// Client registry, built from environment variables at startup.
//
// Clients are auto-discovered from numbered env groups: define CLIENT_1_*,
// CLIENT_2_*, CLIENT_3_*, ... and every group that has a _SLUG becomes a
// client. There is no hard-coded limit — add another numbered block to .env
// and it is picked up on the next restart. A group with no _SLUG is skipped,
// so a half-configured client never registers (and never crashes startup).
//
// Backward compatibility: the original variable names are still honored, so
// existing deployments keep working without renaming anything:
//   - CLIENT_SLUG + unprefixed SHOPIFY_*/META_*/STORE_URL  (the first client)
//   - CLIENT_TWO_* / CLIENT_THREE_*                         (word-prefixed)

// Which CAPI events a client emits. Independent toggles:
//   purchase  → standard Purchase event
//   new       → NewCustomerPurchase (fires when the order is from a new customer)
//   returning → ReturningCustomerPurchase (fires when the customer is returning)
const VALID_EVENTS = ['purchase', 'new', 'returning']

// Parse the per-client CLIENT_n_EVENTS list. Unset/empty → all three (backward
// compatible). Unknown tokens are dropped and returned separately so startup
// validation can warn about them.
function parseEvents(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { events: [...VALID_EVENTS], invalid: [] }
  }
  const events = []
  const invalid = []
  for (const token of String(raw).split(',')) {
    const t = token.trim().toLowerCase()
    if (!t) continue
    if (VALID_EVENTS.includes(t)) {
      if (!events.includes(t)) events.push(t)
    } else if (!invalid.includes(t)) {
      invalid.push(t)
    }
  }
  return { events, invalid }
}

function buildConfig(prefix) {
  const { events, invalid } = parseEvents(process.env[`${prefix}EVENTS`])
  return {
    shopifySecret:      process.env[`${prefix}SHOPIFY_WEBHOOK_SECRET`],
    metaPixelId:        process.env[`${prefix}META_PIXEL_ID`],
    metaCapiToken:      process.env[`${prefix}META_CAPI_TOKEN`],
    testEventCode:      process.env[`${prefix}META_TEST_EVENT_CODE`] || '',
    storeUrl:           process.env[`${prefix}STORE_URL`],
    shopifyAdminToken:  process.env[`${prefix}SHOPIFY_ADMIN_TOKEN`],
    shopifyStoreDomain: process.env[`${prefix}SHOPIFY_STORE_DOMAIN`],
    events,                       // e.g. ['purchase','new','returning']
    invalidEventTokens: invalid,  // unknown tokens, for startup warnings
  }
}

const clients = {}

// 1. Numbered clients (preferred): CLIENT_1_*, CLIENT_2_*, ... — auto-discovered.
const indices = Object.keys(process.env)
  .map((key) => key.match(/^CLIENT_(\d+)_SLUG$/))
  .filter(Boolean)
  .map((match) => Number(match[1]))
  .sort((a, b) => a - b)

for (const i of indices) {
  const prefix = `CLIENT_${i}_`
  const slug = process.env[`${prefix}SLUG`]
  if (slug) clients[slug] = buildConfig(prefix)
}

// 2. Legacy clients (back-compat) — only registered if the slug isn't already
//    taken by a numbered entry, so numbered definitions win.
const legacyClients = [
  { prefix: '',              slugKey: 'CLIENT_SLUG' },
  { prefix: 'CLIENT_TWO_',   slugKey: 'CLIENT_TWO_SLUG' },
  { prefix: 'CLIENT_THREE_', slugKey: 'CLIENT_THREE_SLUG' },
]

for (const { prefix, slugKey } of legacyClients) {
  const slug = process.env[slugKey]
  if (slug && !clients[slug]) clients[slug] = buildConfig(prefix)
}

module.exports = {
  getClient: (slug) => clients[slug] || null,
  clients,
  VALID_EVENTS,
}
