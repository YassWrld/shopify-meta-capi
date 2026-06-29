const express = require('express')
const { getClient } = require('../../config/clients')
const { verifyWebhookSignature, getCustomerOrdersCount } = require('../services/shopify')
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
  const orderId = order.admin_graphql_api_id
    ? order.admin_graphql_api_id.split('/').pop()
    : String(order.id)
  const eventId = 'shopify_' + orderId

  const logger = req.log.child({
    client: clientSlug,
    orderId,
  })

  ;(async () => {
    try {
      const customerType = await getCustomerOrdersCount(order.email, clientConfig)

      logger.info({
        orderTotal:    order.total_price,
        currency:      order.currency,
        customerIp:    order.browser_ip,
        userAgent:     order.client_details?.user_agent,
        eventId,
        customerType,
      }, 'Order received')

      await sendPurchaseEvent(order, clientConfig, customerType, logger)
    } catch (err) {
      logger.error({ err }, 'Unexpected error in Meta CAPI call')
    }
  })()
})

module.exports = router
