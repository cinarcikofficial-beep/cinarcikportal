#!/usr/bin/env node
// R2 + DB + yerel statik gorsel isim migrate'i.
// Multer eski surumde multipart filename'i latin1 okudugu icin Turkce karakterler
// mojibake'e donustu (or. "goruntusu" -> "gÃ¶rÃ¼ntÃ¼sÃ¼") ve bosluklar kaldi.
// Bu script mojibake'i geri cozup temiz ASCII isim uretir; R2'ye temiz kopya koyar,
// DB referanslarini ve yerel statik dosyalari gunceller.
//
// Kullanim:
//   node scripts/migrate-r2-names.js --dry-run   # sadece raporla (varsayilan)
//   node scripts/migrate-r2-names.js --apply     # uygula (R2 eski anahtarlari silinmez)
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const LOCAL_DIR = path.join(ROOT, 'public', 'img', 'uploads');

const TURKISH = { 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I', 'ş': 's', 'Ş': 'S', 'ç': 'c', 'Ç': 'C', 'ö': 'o', 'Ö': 'O', 'ü': 'u', 'Ü': 'U' };

function decodeMojibake(name) {
  // Mojsibake belirtisi (Ã, Ä, Å) yoksa dokunma — sadece bosluklar sonrada temizlenir.
  if (!/[ÃÄÅ]/.test(name)) return name;
  try {
    const dec = Buffer.from(name, 'latin1').toString('utf8');
    if (!dec.includes('\uFFFD')) return dec;
  } catch (e) {}
  return name;
}

function toAsciiSlug(name) {
  const m = name.match(/(\.[A-Za-z0-9]+)$/);
  const ext = m ? m[1] : '';
  let base = m ? name.slice(0, name.length - ext.length) : name;
  base = base
    .replace(/[ğĞıİşŞçÇöÖüÜ]/g, c => TURKISH[c] || c)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
  if (!base) base = 'image';
  return base + ext.toLowerCase();
}

function cleanName(name) { return toAsciiSlug(decodeMojibake(name)); }
function isDirty(name) { return /[^ -~]/.test(name) || /\s/.test(name); }

module.exports = { cleanName, isDirty, decodeMojibake, toAsciiSlug };

if (require.main === module) {
  main().catch(e => { console.error('MIGRATE_ERR', e); process.exit(1); });
}

async function main() {
  // ---- 1) Yerel statik dosyalari tara
  let localFiles = [];
  try { localFiles = fs.readdirSync(LOCAL_DIR); } catch (e) {}
  const localRenames = [];
  for (const f of localFiles) {
    if (!isDirty(f)) continue;
    const target = cleanName(f);
    if (target === f) continue;
    localRenames.push({ from: f, to: target });
  }

  // ---- 2) DB referanslarini tara
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const dbPath = path.join(ROOT, 'db', 'cinarcik.db');
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const dbChanges = [];
  const targets = [
    ['news', 'main_image_url', false], ['news', 'gallery_images', true],
    ['places', 'main_image_url', false], ['places', 'gallery_images', true],
    ['companies', 'logo_url', false], ['companies', 'gallery_images', true],
    ['sightseeing', 'image', false], ['sightseeing', 'gallery_images', true],
    ['announcements', 'image', false]
  ];
  for (const [table, col, isJson] of targets) {
    let rows;
    try { rows = db.exec('SELECT id, ' + col + ' FROM ' + table + ' WHERE ' + col + " IS NOT NULL AND " + col + " != ''")[0].values; }
    catch (e) { continue; }
    for (const [id, val] of rows) {
      let changed = false;
      let newVal = val;
      if (isJson) {
        let arr; try { arr = JSON.parse(val); } catch (e) { continue; }
        if (!Array.isArray(arr)) continue;
        arr = arr.map(p => {
          if (typeof p !== 'string' || !p.includes('/uploads/')) return p;
          const prefix = p.slice(0, p.indexOf('/uploads/') + '/uploads/'.length);
          const name = decodeURIComponent(p.slice(prefix.length));
          if (!isDirty(name)) return p;
          changed = true;
          return prefix + encodeURIComponent(cleanName(name));
        });
        if (changed) newVal = JSON.stringify(arr);
      } else {
        if (!val.includes('/uploads/')) continue;
        const prefix = val.slice(0, val.indexOf('/uploads/') + '/uploads/'.length);
        const name = decodeURIComponent(val.slice(prefix.length));
        if (!isDirty(name)) continue;
        changed = true;
        newVal = prefix + encodeURIComponent(cleanName(name));
      }
      if (changed) dbChanges.push({ table, id, col, from: val, to: newVal });
    }
  }

  // ---- 3) R2 nesnelerini tara
  let r2Plan = [];
  const { AwsClient } = require('aws4fetch');
  const ACC = process.env.R2_ACCOUNT_ID, KEY = process.env.R2_ACCESS_KEY_ID,
        SEC = process.env.R2_SECRET_ACCESS_KEY, BUCKET = process.env.R2_BUCKET;
  if (ACC && KEY && SEC && BUCKET) {
    const client = new AwsClient({ accessKeyId: KEY, secretAccessKey: SEC, region: 'auto', service: 's3' });
    const endpoint = 'https://' + ACC + '.r2.cloudflarestorage.com/' + BUCKET;
    let keys = [], token = '';
    do {
      const url = endpoint + '?list-type=2&prefix=uploads%2F' + (token ? '&continuation-token=' + encodeURIComponent(token) : '');
      const res = await client.fetch(url, { method: 'GET' });
      const xml = await res.text();
      if (!res.ok) { console.error('R2 list HATA', res.status); break; }
      for (const mm of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const b = mm[1];
        const key = (b.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1];
        const size = Number((b.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
        if (key) keys.push({ key, size });
      }
      token = (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] || '';
    } while (token);
    for (const k of keys) {
      const name = k.key.split('/').pop();
      if (!isDirty(name)) continue;
      r2Plan.push({ key: k.key, size: k.size, newName: cleanName(name), newKey: 'uploads/' + cleanName(name) });
    }
  }

  // ---- Rapor
  console.log('=== R2/DB gorsel isim migrate (' + (APPLY ? 'APPLY' : 'DRY-RUN') + ') ===\n');
  console.log('Yerel dosya yeniden adlandirma: ' + localRenames.length);
  localRenames.forEach(r => console.log('  ' + r.from + '\n    -> ' + r.to));
  console.log('\nDB guncelleme: ' + dbChanges.length);
  dbChanges.forEach(c => console.log('  ' + c.table + ' id=' + c.id + ' ' + c.col));
  console.log('\nR2 temiz kopya (eski anahtar SİLINMEZ): ' + r2Plan.length);
  r2Plan.forEach(r => console.log('  ' + r.key + '\n    -> ' + r.newKey + ' (' + r.size + 'B)'));

  if (!APPLY) {
    console.log('\n[dry-run] Hicbir sey degistirmedi. Uygulamak icin: --apply');
    return;
  }

  // ---- Uygula
  console.log('\n--- Uygulaniyor ---');
  // 3a) R2: temiz kopya koy (eski anahtari silme — yedek olarak kalsin)
  if (r2Plan.length && ACC) {
    const { AwsClient } = require('aws4fetch');
    const client = new AwsClient({ accessKeyId: KEY, secretAccessKey: SEC, region: 'auto', service: 's3' });
    const endpoint = 'https://' + ACC + '.r2.cloudflarestorage.com/' + BUCKET;
    for (const r of r2Plan) {
      const getRes = await client.fetch(endpoint + '/' + encodeURIComponent(r.key).replace(/%2F/g, '/'), { method: 'GET' });
      if (!getRes.ok) { console.log('  R2 GET HATA ' + r.key + ' ' + getRes.status); continue; }
      const body = Buffer.from(await getRes.arrayBuffer());
      const putRes = await client.fetch(endpoint + '/' + encodeURIComponent(r.newKey).replace(/%2F/g, '/'), {
        method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' }
      });
      console.log('  R2 kopya ' + (putRes.ok ? 'OK' : 'HATA ' + putRes.status) + ': ' + r.newKey + ' (' + body.length + 'B)');
    }
  }
  // 3b) Yerel dosyalari yeniden adlandir
  for (const r of localRenames) {
    try { fs.renameSync(path.join(LOCAL_DIR, r.from), path.join(LOCAL_DIR, r.to)); console.log('  yerel OK: ' + r.from + ' -> ' + r.to); }
    catch (e) { console.log('  yerel HATA: ' + r.from + ' -> ' + e.message); }
  }
  // 3c) DB guncelle
  for (const c of dbChanges) {
    try {
      db.run('UPDATE ' + c.table + ' SET ' + c.col + ' = ? WHERE id = ?', [c.to, c.id]);
      console.log('  DB OK: ' + c.table + ' id=' + c.id + ' ' + c.col);
    } catch (e) { console.log('  DB HATA: ' + c.table + ' id=' + c.id + ' -> ' + e.message); }
  }
  if (dbChanges.length) {
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    console.log('  DB kaydedildi: ' + dbPath);
  }
  console.log('\n=== Bitti ===');
}
