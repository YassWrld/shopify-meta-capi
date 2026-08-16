const { hashEmail, hashPhone, hashName, hashCity, hashZip, hashCountry, hashState } = require('./hash')

async function sendPurchaseEvent(order, clientConfig, customerType, logger) {
  const billing = order.billing_address || {}
  const orderId = order.admin_graphql_api_id
    ? order.admin_graphql_api_id.split('/').pop()
    : String(order.id)

  const enabledEvents = clientConfig.events || ['purchase', 'new', 'returning']

  const customEventName = customerType === 'returning'
    ? 'ReturningCustomerPurchase'
    : 'NewCustomerPurchase'

  const userData = {
    em:                hashEmail(order.email || order.contact_email),
    ph:                hashPhone(billing.phone || order.phone),
    fn:                hashName(billing.first_name),
    ln:                hashName(billing.last_name),
    ct:                hashCity(billing.city),
    zp:                hashZip(billing.zip),
    country:           hashCountry(billing.country_code),
    st:                hashState(billing.province_code),
    client_ip_address: order.browser_ip || undefined,
    client_user_agent: order.client_details?.user_agent || undefined,
  }

  Object.keys(userData).forEach(k => {
    if (userData[k] === null || userData[k] === undefined) delete userData[k]
  })

  const eventTime = Math.floor(new Date(order.created_at) / 1000)
  const customData = {
    currency: order.currency,
    value:    parseFloat(order.total_price),
    order_id: orderId,
  }

  const purchaseEvent = {
    event_name:       'Purchase',
    event_time:       eventTime,
    event_id:         'shopify_' + orderId,
    action_source:    'website',
    event_source_url: clientConfig.storeUrl,
    user_data:        userData,
    custom_data: {
      ...customData,
      // Only attach the classification when it was actually performed
      // (customerType is null when no customer-type event is enabled).
      ...(customerType ? { new_vs_returning: customerType } : {}),
    },
  }

  const customEvent = {
    event_name:       customEventName,
    event_time:       eventTime,
    event_id:         'shopify_custom_' + orderId,
    action_source:    'website',
    event_source_url: clientConfig.storeUrl,
    user_data:        userData,
    custom_data:      customData,
  }

  // Build the event list from this client's enabled events. The custom event is
  // included only when this order's outcome (new/returning) is itself enabled.
  const data = []
  if (enabledEvents.includes('purchase')) data.push(purchaseEvent)
  const wantCustom =
    (customerType === 'returning' && enabledEvents.includes('returning')) ||
    (customerType === 'new' && enabledEvents.includes('new'))
  if (wantCustom) data.push(customEvent)

  const sentEventNames = data.map((e) => e.event_name)

  if (data.length === 0) {
    logger.info({ metaStatus: 'skipped', customerType, enabledEvents }, 'No enabled events for this order — skipping Meta call')
    return 'skipped'
  }

  const payload = { data }

  if (clientConfig.testEventCode && clientConfig.testEventCode !== '') {
    payload.test_event_code = clientConfig.testEventCode
  }

  const url = `https://graph.facebook.com/v21.0/${clientConfig.metaPixelId}/events?access_token=${clientConfig.metaCapiToken}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const responseBody = await response.json()

  if (!response.ok) {
    const err = responseBody?.error || {}
    logger.error({
      metaStatus:         'error',
      metaHttpStatus:     response.status,
      events:             sentEventNames,
      customerType,
      value:              customData.value,
      currency:           order.currency,
      metaErrorMessage:   err.message,
      metaErrorCode:      err.code,
      metaErrorSubcode:   err.error_subcode,
      metaErrorType:      err.type,
      metaErrorUserTitle: err.error_user_title,
      metaErrorUserMsg:   err.error_user_msg,
      metaFbtraceId:      err.fbtrace_id,
    }, 'Meta CAPI call failed')
    return 'failed'
  }

  logger.info({
    metaStatus:         'ok',
    metaEventsReceived: responseBody.events_received,
    events:             sentEventNames,
    customerType,
    value:              customData.value,
    currency:           order.currency,
  }, 'Meta CAPI call succeeded')

  return 'ok'
}

module.exports = { sendPurchaseEvent }
