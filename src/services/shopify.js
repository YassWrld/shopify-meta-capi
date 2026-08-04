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
const LOOKUP_MAX_RETRIES = 2      // extra attempts when Shopify throttles the lookup
const LOOKUP_RETRY_BASE_MS = 500  // exponential backoff base between retries

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Fallback so the function still logs sensibly when called outside the request
// pipeline (e.g. standalone diagnostic scripts) without a Pino logger.
const consoleFallbackLogger = {
  info:  (obj, msg) => console.log(msg, JSON.stringify(obj)),
  warn:  (obj, msg) => console.warn(msg, JSON.stringify(obj)),
  error: (obj, msg) => console.error(msg, JSON.stringify(obj)),
}

async function getCustomerOrdersCount(email, clientConfig, logger) {
  const log = logger || consoleFallbackLogger
  const store = clientConfig?.shopifyStoreDomain || 'unknown'
  try {
    if (!email) {
      log.warn({ store, reason: 'missing_email', customerType: 'new' }, 'Customer classified "new" — no email to look up')
      return 'new'
    }

    const url = `https://${clientConfig.shopifyStoreDomain}/admin/api/2026-04/graphql.json`

    const body = {
      query: 'query($q:String!){ customers(first:10, query:$q){ edges{ node{ id numberOfOrders } } } }',
      variables: { q: `email:"${email}"` },
    }

    let response
    let json
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
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

      json = await response.json()

      // Retry only on throttling (HTTP 429 or a THROTTLED GraphQL error), with
      // exponential backoff, so rate-limiting doesn't masquerade as a new customer.
      const throttled =
        response.status === 429 ||
        (Array.isArray(json?.errors) && json.errors.some((e) => e?.extensions?.code === 'THROTTLED'))

      if (throttled && attempt < LOOKUP_MAX_RETRIES) {
        const backoffMs = LOOKUP_RETRY_BASE_MS * Math.pow(2, attempt)
        log.warn({ store, attempt: attempt + 1, maxRetries: LOOKUP_MAX_RETRIES, backoffMs }, 'Shopify customer lookup throttled — retrying')
        await sleep(backoffMs)
        continue
      }
      break
    }

    // Failure: HTTP error from Shopify. Not a real "new" customer — the lookup failed.
    if (!response.ok) {
      log.warn({ store, reason: 'http_error', httpStatus: response.status, customerType: 'new' }, 'Customer lookup failed — defaulting to "new"')
      return 'new'
    }

    // Failure: GraphQL-level errors (e.g. throttling, bad query). Lookup failed.
    if (json?.errors) {
      const throttled = json.errors.some((e) => e?.extensions?.code === 'THROTTLED')
      log.warn({ store, reason: throttled ? 'throttled' : 'graphql_error', errors: json.errors, customerType: 'new' }, 'Customer lookup failed — defaulting to "new"')
      return 'new'
    }

    const edges = json?.data?.customers?.edges

    // Failure: response shape wasn't what we expected. Lookup failed.
    if (!Array.isArray(edges)) {
      log.warn({ store, reason: 'malformed_response', customerType: 'new' }, 'Customer lookup failed — defaulting to "new"')
      return 'new'
    }

    // Genuine: no customer matched this email → a true new customer.
    if (edges.length === 0) {
      log.info({ store, reason: 'not_found', records: 0, customerType: 'new' }, 'Customer classified')
      return 'new'
    }

    // Sum orders across ALL customer records for this email. Guest checkouts can
    // create multiple records for the same person (each with numberOfOrders=1),
    // so reading a single record would under-count and misread a returning buyer
    // as new. Summing stays correct in the normal case too (one record → its count).
    let totalOrders = 0
    let sawValidCount = false
    for (const edge of edges) {
      const n = Number(edge?.node?.numberOfOrders)
      if (Number.isFinite(n)) {
        totalOrders += n
        sawValidCount = true
      }
    }

    // Failure: found records but none had a numeric count. Lookup unreliable.
    if (!sawValidCount) {
      log.warn({ store, reason: 'non_numeric_count', records: edges.length, customerType: 'new' }, 'Customer lookup failed — defaulting to "new"')
      return 'new'
    }

    const customerType = totalOrders > 1 ? 'returning' : 'new'
    log.info({ store, reason: 'ok', records: edges.length, totalOrders, customerType }, 'Customer classified')
    return customerType
  } catch (err) {
    if (err.name === 'AbortError') {
      log.warn({ store, reason: 'timeout', timeoutMs: LOOKUP_TIMEOUT_MS, customerType: 'new' }, 'Customer lookup timed out — defaulting to "new"')
    } else {
      log.error({ store, reason: 'error', err: err.message, customerType: 'new' }, 'Customer lookup failed — defaulting to "new"')
    }
    return 'new'
  }
}

module.exports = { verifyWebhookSignature, getCustomerOrdersCount }
