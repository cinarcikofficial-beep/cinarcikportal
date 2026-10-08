const crypto = require('crypto');
const { get, run } = require('./db');

const LANGS = ['en', 'ru', 'ar'];
const mem = new Map();
let tableReady = false;
let active = 0;
const MAX_CONCURRENT = 5;
const waiters = [];

function ensureTable() {
  if (tableReady) return;
  try {
    run(`CREATE TABLE IF NOT EXISTS content_translations (
      lang TEXT NOT NULL,
      src_hash TEXT NOT NULL,
      source TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (lang, src_hash)
    )`);
    tableReady = true;
  } catch (e) {
    console.error('[tx] tablo oluşturulamadı:', e.message);
  }
}

function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise(resolve => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

function splitChunks(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    for (const sep of ['\n', '۔', '. ', '!', '?']) {
      const idx = rest.lastIndexOf(sep, limit);
      if (idx > Math.floor(limit / 2)) { cut = idx + sep.length; break; }
    }
    if (cut === -1) {
      const gt = rest.lastIndexOf('>', limit);
      cut = gt > Math.floor(limit / 2) ? gt + 1 : limit;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function googleTranslate(text, lang) {
  const parts = [];
  for (const chunk of splitChunks(text, 4000)) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
      encodeURIComponent(lang) + '&dt=t&q=' + encodeURIComponent(chunk);
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    if (!Array.isArray(json) || !Array.isArray(json[0])) throw new Error('beklenmeyen yanıt');
    parts.push(json[0].map(seg => (Array.isArray(seg) ? seg[0] : '')).join(''));
  }
  return parts.join('');
}

async function tx(lang, text) {
  if (!text || typeof text !== 'string' || !LANGS.includes(lang)) return text;
  ensureTable();
  const h = hash(text);
  const key = lang + '|' + h;
  if (mem.has(key)) return mem.get(key);
  let row = null;
  try { row = get('SELECT result FROM content_translations WHERE lang = ? AND src_hash = ?', [lang, h]); } catch (e) {}
  if (row && row.result) {
    mem.set(key, row.result);
    return row.result;
  }
  await acquire();
  let out = null;
  try {
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      try { out = await googleTranslate(text, lang); } catch (e) {
        if (attempt === 1) console.error('[tx] çeviri hatası (' + lang + '):', e.message);
        await new Promise(r => setTimeout(r, 300));
      }
    }
  } finally {
    release();
  }
  if (!out) return text;
  try {
    run('INSERT OR REPLACE INTO content_translations (lang, src_hash, source, result) VALUES (?,?,?,?)', [lang, h, text, out]);
  } catch (e) {
    console.error('[tx] cache kayıt hatası:', e.message);
  }
  mem.set(key, out);
  return out;
}

async function txFields(obj, fields, lang) {
  if (!obj || !LANGS.includes(lang)) return obj;
  await Promise.all(fields.map(async f => {
    if (typeof obj[f] === 'string' && obj[f].trim()) {
      const r = await tx(lang, obj[f]);
      if (r) obj[f] = r;
    }
  }));
  return obj;
}

async function txArray(arr, fields, lang) {
  if (!Array.isArray(arr) || !LANGS.includes(lang)) return arr;
  await Promise.all(arr.map(o => txFields(o, fields, lang)));
  return arr;
}

async function txJsonArrayField(obj, field, lang) {
  if (!obj || !Array.isArray(obj[field]) || !LANGS.includes(lang)) return obj;
  const translated = await Promise.all(obj[field].map(v => (typeof v === 'string' ? tx(lang, v) : v)));
  obj[field] = translated;
  return obj;
}

module.exports = { tx, txFields, txArray, txJsonArrayField, LANGS };
