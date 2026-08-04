const crypto = require('crypto')

function verifyWebhookSignature(rawBody, hmacHeader, secret) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64')

  const digestBuf = Buffer.from(digest)
  const headerBuf = Buffer.from(hmacHeader)

  if (digestBuf.length !== headerBuf.length) {
    throw new Error('Signature mismatch')
  }

  if (!crypto.timingSafeEqual(digestBuf, headerBuf)) {
    throw new Error('Signature mismatch')
  }
}

const LOOKUP_TIMEOUT_MS = 3000

async function getCustomerOrdersCount(email, clientConfig) {
  const slug = clientConfig?.shopifyStoreDomain || 'unknown'
  try {
    if (!email) {
      console.error(`[shopify:${slug}] getCustomerOrdersCount: missing email, defaulting to "new"`)
      return 'new'
    }

    const url = `https://${clientConfig.shopifyStoreDomain}/admin/api/2026-04/graphql.json`

    const body = {
      query: 'query($q:String!){ customers(first:1, query:$q){ edges{ node{ id numberOfOrders } } } }',
      variables: { q: `email:"${email}"` },
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': clientConfig.shopifyAdminToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    const json = await response.json()

    // Failure: HTTP error from Shopify. Not a real "new" customer — the lookup failed.
    if (!response.ok) {
      console.error(`[shopify:${slug}] getCustomerOrdersCount lookup failed: HTTP ${response.status}, defaulting to "new"`)
      return 'new'
    }

    // Failure: GraphQL-level errors (e.g. throttling, bad query). Lookup failed.
    if (json?.errors) {
      const throttled = json.errors.some((e) => e?.extensions?.code === 'THROTTLED')
      console.error(`[shopify:${slug}] getCustomerOrdersCount lookup failed: GraphQL error${throttled ? ' (THROTTLED)' : ''}, defaulting to "new": ${JSON.stringify(json.errors)}`)
      return 'new'
    }

    const edges = json?.data?.customers?.edges

    // Failure: response shape wasn't what we expected. Lookup failed.
    if (!Array.isArray(edges)) {
      console.error(`[shopify:${slug}] getCustomerOrdersCount lookup failed: malformed response, defaulting to "new"`)
      return 'new'
    }

    // Genuine: no customer matched this email → a true new customer.
    if (edges.length === 0) {
      console.log(`[shopify:${slug}] customer not found → "new"`)
      return 'new'
    }

    const numberOfOrders = Number(edges[0]?.node?.numberOfOrders)

    // Failure: found a customer but the count wasn't a number. Lookup unreliable.
    if (!Number.isFinite(numberOfOrders)) {
      console.error(`[shopify:${slug}] getCustomerOrdersCount lookup failed: numberOfOrders not numeric, defaulting to "new"`)
      return 'new'
    }

    const customerType = numberOfOrders > 1 ? 'returning' : 'new'
    console.log(`[shopify:${slug}] numberOfOrders=${numberOfOrders} customerType=${customerType}`)
    return customerType
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[shopify:${slug}] getCustomerOrdersCount timed out after ${LOOKUP_TIMEOUT_MS}ms, defaulting to "new"`)
    } else {
      console.error(`[shopify:${slug}] getCustomerOrdersCount failed:`, err)
    }
    return 'new'
  }
}

module.exports = { verifyWebhookSignature, getCustomerOrdersCount }
