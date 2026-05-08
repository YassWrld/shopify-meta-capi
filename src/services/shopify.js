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

module.exports = { verifyWebhookSignature }
