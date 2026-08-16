require('dotenv').config()

const express = require('express')
const pino = require('pino')
const { clients, getClient } = require('../config/clients')
const webhookRouter = require('./routes/webhook')
const stats = require('./services/stats')

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Readable structured output: level as a label ("info"), ISO timestamps.
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
})

const REQUIRED_FIELDS = ['shopifySecret', 'metaPixelId', 'metaCapiToken', 'storeUrl']

function validateClients() {
  let valid = true
  for (const [slug, config] of Object.entries(clients)) {
    if (!slug) {
      logger.error('CLIENT_SLUG is not set in environment')
      valid = false
      continue
    }
    for (const field of REQUIRED_FIELDS) {
      if (!config[field]) {
        logger.error({ client: slug, field }, `Missing required field "${field}" for client "${slug}"`)
        valid = false
      }
    }

    // Event-config checks — warnings only (never fatal).
    const events = config.events || []
    if (config.invalidEventTokens && config.invalidEventTokens.length) {
      logger.warn({ client: slug, invalid: config.invalidEventTokens }, `Ignoring unknown event(s) in ${slug} EVENTS — valid values are: purchase, new, returning`)
    }
    if (events.length === 0) {
      logger.warn({ client: slug }, `Client "${slug}" has no events enabled — it will receive webhooks but send nothing to Meta`)
    } else if (!events.includes('purchase')) {
      logger.warn({ client: slug, events }, `Client "${slug}" has "purchase" DISABLED — Meta's optimization relies on the standard Purchase event; only the custom event(s) will be sent`)
    }
  }
  return valid
}

if (!validateClients()) {
  process.exit(1)
}

const app = express()

app.use((req, res, next) => {
  req.log = logger
  next()
})

// Liveness + reconciliation endpoint. Mounted under /webhooks so it is reachable
// through the existing Nginx config, which only proxies that prefix.
//
// Call it repeatedly from outside the box: if bootId/pid alternate between two
// values, more than one backend is answering this hostname and half the webhooks
// are being consumed by the other one.
app.get('/webhooks/health', (req, res) => {
  res.json(stats.snapshot())
})

// Log arrival BEFORE the body is parsed. Anything logged only after express.json()
// is invisible when parsing itself is what failed, which is precisely the case that
// looks like "Shopify never sent it".
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path.startsWith('/webhooks/')) {
    stats.bump('inbound')
    req.log.info({
      path:        req.path,
      webhookId:   req.headers['x-shopify-webhook-id'],
      topic:       req.headers['x-shopify-topic'],
      shopDomain:  req.headers['x-shopify-shop-domain'],
      apiVersion:  req.headers['x-shopify-api-version'],
      triggeredAt: req.headers['x-shopify-triggered-at'],
      contentLength: req.headers['content-length'],
      bootId:      stats.BOOT_ID,
    }, 'Webhook request arrived')
  }
  next()
})

app.use(express.json({
  // Shopify order payloads grow with line items, discounts and metafields. The
  // Express default of 100kb silently 413s a large order before any of our code
  // runs — no log line, and Shopify sees a failed delivery. Match Nginx's
  // client_max_body_size instead.
  limit: '2mb',
  verify: (req, res, buf) => {
    req.rawBody = buf
  }
}))

app.use('/webhooks', webhookRouter)

// Reached the app but matched no route — a wrong path in the Shopify webhook
// config looks identical to "nothing arrived" without this.
app.use((req, res) => {
  stats.bump('notFound')
  req.log.warn({ method: req.method, path: req.path }, 'No route matched')
  res.status(404).end()
})

// Body-parser and other pre-router failures land here. Without an explicit
// handler, Express answers with its default error page and logs nothing at all.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  stats.bump('parseErrors')
  req.log.error({
    path:          req.path,
    webhookId:     req.headers['x-shopify-webhook-id'],
    contentLength: req.headers['content-length'],
    status:        err.status,
    type:          err.type,
    err:           err.message,
  }, 'Request rejected before handler')
  res.status(err.status || 400).end()
})

const port = process.env.PORT || 3003

app.listen(port, () => {
  logger.info({
    port,
    nodeEnv: process.env.NODE_ENV,
    bootId: stats.BOOT_ID,
    clients: Object.keys(clients).filter(Boolean),
    events: Object.fromEntries(
      Object.entries(clients).map(([slug, cfg]) => [slug, cfg.events]),
    ),
  }, 'Server started')
})
