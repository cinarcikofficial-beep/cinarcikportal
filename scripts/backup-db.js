// Turso DB snapshot'ını indirip R2 bucket'ına backups/ altına yazar.
// GitHub Action (workflows/db-backup.yml) her Pazartesi 03:00'te çalıştırır.
// Gerekli env: TURSO_URL, TURSO_TOKEN, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
//              R2_SECRET_ACCESS_KEY, R2_BUCKET
require('dotenv').config();
const { createClient } = require('@libsql/client');
const { AwsClient } = require('aws4fetch');

const RETAIN_DAYS = 30; // backups/ altındaki bu süreden eski yedekler silinir

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { console.error('Eksik env: ' + name); process.exit(1); }
  return v;
}

(async () => {
  const TURSO_URL = requireEnv('TURSO_URL');
  const TURSO_TOKEN = requireEnv('TURSO_TOKEN');
  const account = requireEnv('R2_ACCOUNT_ID');
  const bucket = requireEnv('R2_BUCKET');
  requireEnv('R2_ACCESS_KEY_ID');
  requireEnv('R2_SECRET_ACCESS_KEY');

  // 1) Snapshot indir
  const cloud = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  await cloud.execute('CREATE TABLE IF NOT EXISTS app_db (id INTEGER PRIMARY KEY CHECK (id = 1), data BLOB NOT NULL, updated_at TEXT)');
  const rs = await cloud.execute('SELECT data, updated_at FROM app_db WHERE id = 1');
  if (!rs.rows.length) { console.error('Turso boş — yedek alınmadı.'); process.exit(1); }
  const raw = rs.rows[0].data;
  const buf = Buffer.from(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  console.log('Turso snapshot: ' + (buf.length / 1024).toFixed(0) + ' KB (updated_at: ' + rs.rows[0].updated_at + ')');

  // 2) R2'e yükle (gzip sıkıştır; SQLite zaten sıkışır ama yine de ~%20 kazanç)
  const zlib = require('zlib');
  const gz = zlib.gzipSync(buf, { level: 9 });
  const date = new Date().toISOString().slice(0, 10);
  const key = 'backups/cinarcik-' + date + '.db.gz';

  const client = new AwsClient({
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    service: 's3'
  });
  const base = 'https://' + account + '.r2.cloudflarestorage.com/' + bucket;
  const put = await client.fetch(base + '/' + key, { method: 'PUT', body: gz, headers: { 'Content-Type': 'application/gzip' } });
  if (!put.ok && put.status !== 204) {
    console.error('R2 PUT hatası: ' + put.status + ' — ' + await put.text());
    process.exit(1);
  }
  console.log('[r2] yedek yüklendi: ' + key + ' (' + (gz.length / 1024).toFixed(0) + ' KB gzip)');

  // 3) Eski yedekleri temizle (30 günden eski)
  let token = '';
  const keys = [];
  do {
    const url = base + '?list-type=2&prefix=backups/&max-keys=1000' + (token ? '&continuation-token=' + encodeURIComponent(token) : '');
    const res = await client.fetch(url, { method: 'GET' });
    if (!res.ok) { console.warn('Liste okunamadı: ' + res.status); break; }
    const xml = await res.text();
    for (const c of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
      const k = (c.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1];
      const last = (c.match(/<LastModified>([\s\S]*?)<\/LastModified>/) || [])[1];
      if (k) keys.push({ k, last });
    }
    token = (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] || '';
  } while (token);

  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const o of keys) {
    if (o.k === key) continue;
    if (new Date(o.last).getTime() >= cutoff) continue;
    const res = await client.fetch(base + '/' + o.k.split('/').map(encodeURIComponent).join('/'), { method: 'DELETE' });
    if (res.ok || res.status === 204) { deleted++; console.log('[r2] eski yedek silindi: ' + o.k); }
    else console.warn('[r2] silme yanıtı ' + res.status + ': ' + o.k);
  }
  console.log('Tamam. Toplam yedek: ' + (keys.length - deleted + 1) + ', silinen: ' + deleted);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
