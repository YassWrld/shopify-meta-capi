module.exports = {
  apps: [{
    name: 'shopify-meta-capi',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    env_production: {
      NODE_ENV: 'production'
    }
  }]
}
