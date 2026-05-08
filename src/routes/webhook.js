const express = require('express')
const { getClient } = require('../../config/clients')
const { verifyWebhookSignature } = require('../services/shopify')
const { sendPurchaseEvent } = require('../services/meta')

const router = express.Router()

router.post('/:clientSlug/order-paid', (req, res) => {
  const { clientSlug } = req.params

  const clientConfig = getClient(clientSlug)
  if (!clientConfig) {
    req.log.warn({ clientSlug }, 'Unknown client slug')
    return res.status(404).end()
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256']
  try {
    verifyWebhookSignature(req.rawBody, hmacHeader || '', clientConfig.shopifySecret)
  } catch {
    req.log.warn({ client: clientSlug }, 'Invalid webhook signature')
    return res.status(401).end()
  }

  res.status(200).end()

  const order = req.body
  const orderId = String(order.id)
  const eventId = 'shopify_' + order.id

  const logger = req.log.child({
    client: clientSlug,
    orderId,
  })

  logger.info({
    orderTotal: order.total_price,
    currency:   order.currency,
    customerIp: order.browser_ip,
    userAgent:  order.client_details?.user_agent,
    eventId,
  }, 'Order received')

  ;(async () => {
    try {
      await sendPurchaseEvent(order, clientConfig, logger)
    } catch (err) {
      logger.error({ err }, 'Unexpected error in Meta CAPI call')
    }
  })()
})

module.exports = router
