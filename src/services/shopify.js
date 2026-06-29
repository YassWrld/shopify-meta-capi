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

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': clientConfig.shopifyAdminToken,
      },
      body: JSON.stringify(body),
    })

    const json = await response.json()

    const edges = json?.data?.customers?.edges
    if (!Array.isArray(edges) || edges.length === 0) {
      return 'new'
    }

    const numberOfOrders = Number(edges[0]?.node?.numberOfOrders)
    if (!Number.isFinite(numberOfOrders)) {
      return 'new'
    }

    const customerType = numberOfOrders > 1 ? 'returning' : 'new'
    console.log(`[shopify:${slug}] numberOfOrders=${numberOfOrders} customerType=${customerType}`)
    return customerType
  } catch (err) {
    console.error(`[shopify:${slug}] getCustomerOrdersCount failed:`, err)
    return 'new'
  }
}

module.exports = { verifyWebhookSignature, getCustomerOrdersCount }
