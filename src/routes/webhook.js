const express = require('express')
const { getClient } = require('../../config/clients')
const { verifyWebhookSignature, getCustomerOrdersCount } = require('../services/shopify')
const { sendPurchaseEvent } = require('../services/meta')
const stats = require('../services/stats')

const router = express.Router()

router.post('/:clientSlug/order-paid', (req, res) => {
  const { clientSlug } = req.params
  const webhookId = req.headers['x-shopify-webhook-id']

  const clientConfig = getClient(clientSlug)
  if (!clientConfig) {
    stats.bump('rejectedSlug')
    req.log.warn({ clientSlug, webhookId }, 'Unknown client slug')
    return res.status(404).end()
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256']
  try {
    verifyWebhookSignature(req.rawBody, hmacHeader || '', clientConfig.shopifySecret)
  } catch {
    stats.bump('rejectedHmac', clientSlug)
    req.log.warn({ client: clientSlug, webhookId, hasHmac: Boolean(hmacHeader) }, 'Invalid webhook signature')
    return res.status(401).end()
  }

  res.status(200).end()

  const order = req.body
  const orderId = order.admin_graphql_api_id
    ? order.admin_graphql_api_id.split('/').pop()
    : String(order.id)
  const eventId = 'shopify_' + orderId

  stats.bump('accepted', clientSlug)
  stats.remember({
    at: new Date().toISOString(),
    client: clientSlug,
    webhookId,
    orderId,
    orderName: order.name,
  })

  const logger = req.log.child({
    client: clientSlug,
    orderId,
    webhookId,
  })

  ;(async () => {
    try {
      logger.info({
        orderTotal: order.total_price,
        currency:   order.currency,
        customerIp: order.browser_ip,
        userAgent:  order.client_details?.user_agent,
        eventId,
        isTest:     order.test,
        orderName:  order.name,
        sourceName: order.source_name,
        hasEmail:   Boolean(order.email || order.contact_email),
      }, 'Order received')

      // Only classify (and hit the Shopify Admin API) if a customer-type event
      // is actually enabled for this client. Otherwise it's wasted work.
      const events = clientConfig.events || []
      const needsCustomerType = events.includes('new') || events.includes('returning')
      const customerType = needsCustomerType
        ? await getCustomerOrdersCount(order.email || order.contact_email, clientConfig, logger)
        : null

      const outcome = await sendPurchaseEvent(order, clientConfig, customerType, logger)
      // 'skipped' is a configuration choice, not a delivery failure — don't count it as either.
      if (outcome === 'ok') stats.bump('metaOk', clientSlug)
      else if (outcome !== 'skipped') stats.bump('metaFailed', clientSlug)
    } catch (err) {
      stats.bump('metaFailed', clientSlug)
      logger.error({ err }, 'Unexpected error processing order')
    }
  })()
})

module.exports = router
