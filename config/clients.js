const clients = {
  [process.env.CLIENT_SLUG]: {
    shopifySecret:      process.env.SHOPIFY_WEBHOOK_SECRET,
    metaPixelId:        process.env.META_PIXEL_ID,
    metaCapiToken:      process.env.META_CAPI_TOKEN,
    testEventCode:      process.env.META_TEST_EVENT_CODE || '',
    storeUrl:           process.env.STORE_URL,
    shopifyAdminToken:  process.env.SHOPIFY_ADMIN_TOKEN,
    shopifyStoreDomain: process.env.SHOPIFY_STORE_DOMAIN,
  },
  [process.env.CLIENT_TWO_SLUG]: {
    shopifySecret:      process.env.CLIENT_TWO_SHOPIFY_WEBHOOK_SECRET,
    metaPixelId:        process.env.CLIENT_TWO_META_PIXEL_ID,
    metaCapiToken:      process.env.CLIENT_TWO_META_CAPI_TOKEN,
    testEventCode:      process.env.CLIENT_TWO_META_TEST_EVENT_CODE || '',
    storeUrl:           process.env.CLIENT_TWO_STORE_URL,
    shopifyAdminToken:  process.env.CLIENT_TWO_SHOPIFY_ADMIN_TOKEN,
    shopifyStoreDomain: process.env.CLIENT_TWO_SHOPIFY_STORE_DOMAIN,
  },
  [process.env.CLIENT_THREE_SLUG]: {
    shopifySecret:      process.env.CLIENT_THREE_SHOPIFY_WEBHOOK_SECRET,
    metaPixelId:        process.env.CLIENT_THREE_META_PIXEL_ID,
    metaCapiToken:      process.env.CLIENT_THREE_META_CAPI_TOKEN,
    testEventCode:      process.env.CLIENT_THREE_META_TEST_EVENT_CODE || '',
    storeUrl:           process.env.CLIENT_THREE_STORE_URL,
    shopifyAdminToken:  process.env.CLIENT_THREE_SHOPIFY_ADMIN_TOKEN,
    shopifyStoreDomain: process.env.CLIENT_THREE_SHOPIFY_STORE_DOMAIN,
  },
}

module.exports = {
  getClient: (slug) => clients[slug] || null,
  clients
}
