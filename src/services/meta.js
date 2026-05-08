const { hashEmail, hashPhone, hashName, hashCity, hashZip, hashCountry } = require('./hash')

async function sendPurchaseEvent(order, clientConfig, logger) {
  const billing = order.billing_address || {}
  const orderId = order.admin_graphql_api_id
    ? order.admin_graphql_api_id.split('/').pop()
    : String(order.id)

  const userData = {
    em:                hashEmail(order.email || order.contact_email),
    ph:                hashPhone(billing.phone || order.phone),
    fn:                hashName(billing.first_name),
    ln:                hashName(billing.last_name),
    ct:                hashCity(billing.city),
    zp:                hashZip(billing.zip),
    country:           hashCountry(billing.country_code),
    client_ip_address: order.browser_ip || undefined,
    client_user_agent: order.client_details?.user_agent || undefined,
  }

  Object.keys(userData).forEach(k => {
    if (userData[k] === null || userData[k] === undefined) delete userData[k]
  })

  const event = {
    event_name:       'Purchase',
    event_time:       Math.floor(new Date(order.created_at) / 1000),
    event_id:         'shopify_' + orderId,
    action_source:    'website',
    event_source_url: clientConfig.storeUrl,
    user_data:        userData,
    custom_data: {
      currency: order.currency,
      value:    parseFloat(order.total_price),
      order_id: orderId,
    },
  }

  const payload = { data: [event] }

  if (clientConfig.testEventCode && clientConfig.testEventCode !== '') {
    payload.test_event_code = clientConfig.testEventCode
  }

  const url = `https://graph.facebook.com/v19.0/${clientConfig.metaPixelId}/events?access_token=${clientConfig.metaCapiToken}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const responseBody = await response.json()

  if (!response.ok) {
    logger.error({
      metaStatus: 'error',
      metaHttpStatus: response.status,
      metaErrorMessage: responseBody?.error?.message,
      metaErrorCode: responseBody?.error?.code,
    }, 'Meta CAPI call failed')
    return
  }

  logger.info({
    metaStatus: 'ok',
    metaEventsReceived: responseBody.events_received,
  }, 'Meta CAPI call succeeded')
}

module.exports = { sendPurchaseEvent }
