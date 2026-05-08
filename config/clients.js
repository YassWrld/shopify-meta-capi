const clients = {
  [process.env.CLIENT_SLUG]: {
    shopifySecret: process.env.SHOPIFY_WEBHOOK_SECRET,
    metaPixelId:   process.env.META_PIXEL_ID,
    metaCapiToken: process.env.META_CAPI_TOKEN,
    testEventCode: process.env.META_TEST_EVENT_CODE || '',
    storeUrl:      process.env.STORE_URL,
  }
}

module.exports = {
  getClient: (slug) => clients[slug] || null,
  clients
}
