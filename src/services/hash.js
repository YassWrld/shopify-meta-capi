const crypto = require('crypto')

function hashField(value) {
  if (value === null || value === undefined || value === '') return null
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function normalizeEmail(value) {
  if (value === null || value === undefined || value === '') return null
  return value.toLowerCase().trim()
}

function normalizePhone(value) {
  if (value === null || value === undefined || value === '') return null
  return value.replace(/\D/g, '')
}

function normalizeName(value) {
  if (value === null || value === undefined || value === '') return null
  return value.toLowerCase().trim()
}

function normalizeCity(value) {
  if (value === null || value === undefined || value === '') return null
  return value.toLowerCase().trim()
}

function normalizeZip(value) {
  if (value === null || value === undefined || value === '') return null
  return value.toLowerCase().trim().replace(/\s/g, '')
}

function normalizeCountry(value) {
  if (value === null || value === undefined || value === '') return null
  return value.toLowerCase().trim()
}

module.exports = {
  hashEmail:   (v) => { const n = normalizeEmail(v);   return n ? hashField(n) : null },
  hashPhone:   (v) => { const n = normalizePhone(v);   return n ? hashField(n) : null },
  hashName:    (v) => { const n = normalizeName(v);    return n ? hashField(n) : null },
  hashCity:    (v) => { const n = normalizeCity(v);    return n ? hashField(n) : null },
  hashZip:     (v) => { const n = normalizeZip(v);     return n ? hashField(n) : null },
  hashCountry: (v) => { const n = normalizeCountry(v); return n ? hashField(n) : null },
}
