// In-memory delivery counters for this process.
//
// Purpose is reconciliation. When Shopify's order list shows more orders than the
// logs show events, these answer two questions that logs alone can't:
//
//   1. Did the request reach this process at all? (inbound vs. accepted vs. rejected)
//   2. Is more than one process answering this hostname? The health endpoint reports
//      bootId/pid alongside these counters, so a second backend — an extra DNS A
//      record, an nginx upstream, a stale deploy — shows up as the values flipping
//      between two bootIds on repeated calls.
//
// Deliberately in-memory and unbounded-free: resets on restart, costs nothing, and
// never becomes a storage dependency.

const crypto = require('crypto')

const BOOT_ID = crypto.randomUUID()
const STARTED_AT = new Date().toISOString()

const RECENT_LIMIT = 50

const counters = {
  inbound: 0,      // requests that reached Express on a /webhooks path
  accepted: 0,     // signature verified, handed off for processing
  rejectedSlug: 0, // unknown client slug
  rejectedHmac: 0, // signature mismatch
  parseErrors: 0,  // body never parsed (too large, malformed JSON)
  notFound: 0,     // reached the app but matched no route
}

const byClient = {}
const recent = []

function clientBucket(slug) {
  const key = slug || '(none)'
  if (!byClient[key]) {
    // No per-client "inbound": arrival is counted before the slug is known.
    byClient[key] = { accepted: 0, rejectedHmac: 0, metaOk: 0, metaFailed: 0 }
  }
  return byClient[key]
}

function bump(counter, slug) {
  counters[counter] = (counters[counter] || 0) + 1
  if (slug !== undefined) {
    const bucket = clientBucket(slug)
    if (bucket[counter] !== undefined) bucket[counter] += 1
  }
}

// Ring buffer of the last N deliveries. Reconcile against Shopify's own delivery
// list by webhookId, and spot gaps or redeliveries at a glance.
function remember(entry) {
  recent.push(entry)
  if (recent.length > RECENT_LIMIT) recent.shift()
}

function snapshot() {
  return {
    bootId: BOOT_ID,
    pid: process.pid,
    startedAt: STARTED_AT,
    uptimeSec: Math.round(process.uptime()),
    counters: { ...counters },
    byClient: JSON.parse(JSON.stringify(byClient)),
    recent: [...recent],
  }
}

module.exports = { BOOT_ID, STARTED_AT, bump, remember, snapshot }
