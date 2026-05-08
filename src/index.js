require('dotenv').config()

const express = require('express')
const pino = require('pino')
const { clients, getClient } = require('../config/clients')
const webhookRouter = require('./routes/webhook')

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

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

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf
  }
}))

app.use('/webhooks', webhookRouter)

const port = process.env.PORT || 3003

app.listen(port, () => {
  logger.info({
    port,
    nodeEnv: process.env.NODE_ENV,
    clients: Object.keys(clients).filter(Boolean),
  }, 'Server started')
})
