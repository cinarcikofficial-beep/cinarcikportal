const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'cinarcik.db');
const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_TOKEN = process.env.TURSO_TOKEN || '';

const SYNC_DEBOUNCE_MS = 500;
const SYNC_RETRY_MS = 15 * 1000;
const SYNC_HEARTBEAT_MS = 5 * 60 * 1000;
const SYNC_MAX_ATTEMPTS = 3;
const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

// Sayaç niteliğindeki kolonlar: güncellenmeleri satırın sürümünü tazelemez,
// birleşimde iki taraftan da en büyüğü alınır (ör. sayfa görüntülenme sayısı).
const VOLATILE_COLS = {
  news: ['views_count'],
  places: ['rating', 'review_count', 'google_rating', 'google_review_count']
};

// Satırın "kimliği": iki kopyada kimlik farklıysa bu, aynı satırın iki sürümü
// değil, aynı id ile çakışan **iki ayrı kayıttır** → biri yeni id'ye taşınır.
const IDENTITY_COLS = {
  news: ['title', 'slug'],
  places: ['name', 'slug'],
  companies: ['name', 'slug'],
  announcements: ['title'],
  sightseeing: ['title'],
  comments: ['user_email', 'user_name', 'content'],
  contact_messages: ['email', 'subject', 'message'],
  users: ['username'],
  pharmacies: ['name', 'phone'],
  ferry_schedules: ['origin', 'destination'],
  place_reviews: ['place_id', 'user_name', 'comment'],
  content_translations: ['lang', 'src_hash'],
  about_page: []
};

// İçeriği tek kaynaktan gelen tablolar (nöbetçi eczane, sefer saatleri):
// bu tablolarda birleşim tüm liste tarafında yenisi olandan yapılır.
const SET_TABLES = ['pharmacies', 'ferry_schedules'];

// ON DELETE CASCADE ile birlikte silinen alt tablolar (silme kaydına eklenir).
const CASCADE_CHILDREN = {
  news: [['comments', 'news_id']],
  places: [['place_reviews', 'place_id']]
};

let db = null;
let SQL = null;
let cloud = null;
let syncTimer = null;
let retryTimer = null;
let syncing = false;
let syncQueued = false;
let dirty = true;
let lastSyncedHash = '';

function nowIso() {
  return new Date().toISOString();
}

function getCloud() {
  if (!TURSO_URL) return null;
  if (!cloud) cloud = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined });
  return cloud;
}

// ==================== BULUT KATMANI ====================

async function downloadSnapshot() {
  const c = getCloud();
  if (!c) return null;
  await c.execute('CREATE TABLE IF NOT EXISTS app_db (id INTEGER PRIMARY KEY CHECK (id = 1), data BLOB NOT NULL, updated_at TEXT)');
  const rs = await c.execute('SELECT data, updated_at FROM app_db WHERE id = 1');
  if (!rs.rows.length) return null;
  const raw = rs.rows[0].data;
  return {
    buffer: Buffer.from(raw instanceof Uint8Array ? raw : new Uint8Array(raw)),
    updatedAt: rs.rows[0].updated_at || ''
  };
}

// CAS: bulut, indirdiğimiz sürümden hiç yenilenmemişse yaz. Böylece iki
// sunucu aynı anda yazar birbirinin verisini silmez; çakışırsa yeniden birleşir.
async function uploadSnapshot(exported, baseUpdatedAt) {
  const c = getCloud();
  if (!c || !exported) return false;
  const now = nowIso();
  await c.execute('CREATE TABLE IF NOT EXISTS app_db (id INTEGER PRIMARY KEY CHECK (id = 1), data BLOB NOT NULL, updated_at TEXT)');
  const res = await c.execute({
    sql: `INSERT INTO app_db (id, data, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
          WHERE app_db.updated_at IS ?`,
    args: [exported, now, baseUpdatedAt || null]
  });
  return res.rowsAffected > 0;
}

function scheduleSnapshot() {
  if (!TURSO_URL) return;
  if (syncing) { syncQueued = true; return; }
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncNow('yazma');
  }, SYNC_DEBOUNCE_MS);
}

function scheduleRetry() {
  if (!TURSO_URL || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    syncNow('yeniden deneme');
  }, SYNC_RETRY_MS);
}

// Bulut ile yereli **her zaman birleştirerek** eşitle. Buluttaki veri de,
// yereldeki veri de asla yok sayılmaz; yazma ancak birleştirme sonrası yapılır.
async function syncNow(reason) {
  if (!TURSO_URL || !db) return false;
  if (syncing) return false;
  syncing = true;
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  try {
    for (let attempt = 1; attempt <= SYNC_MAX_ATTEMPTS; attempt++) {
      const cloudState = await downloadSnapshot();
      if (cloudState && cloudState.buffer) {
        try { mergeCloudBuffer(cloudState.buffer, cloudState.updatedAt); }
        catch (e) { console.error('[db] birleştirme hatası:', e.message); }
      }
      pruneTombstones();
      const exported = exportDb();
      writeLocalFile(exported);
      const hash = crypto.createHash('sha256').update(exported).digest('hex');
      if (!dirty && hash === lastSyncedHash) return true;
      const ok = await uploadSnapshot(exported, cloudState ? cloudState.updatedAt : undefined);
      if (ok) {
        lastSyncedHash = hash;
        dirty = false;
        console.log('[db] senkron tamam (' + reason + ')');
        return true;
      }
      // CAS çakışması: birisi bizden önce yazdı → başa dönüp yeniden birleştir.
    }
    console.warn('[db] senkron çakışması: ' + SYNC_MAX_ATTEMPTS + ' denemede buluta yazılamadı (' + reason + ')');
    scheduleRetry();
    return false;
  } catch (e) {
    console.error('[db] senkron hatası (' + reason + '):', e.message);
    scheduleRetry();
    return false;
  } finally {
    syncing = false;
    if (syncQueued) { syncQueued = false; scheduleSnapshot(); }
  }
}

// ==================== ŞEMA YARDIMCILARI ====================

function quoteId(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function tablesOf(d) {
  const r = d.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return r[0] ? r[0].values.map(v => v[0]) : [];
}

function infoOf(d, table) {
  const r = d.exec('PRAGMA table_info(' + quoteId(table) + ')');
  if (!r[0]) return [];
  return r[0].values.map(v => ({ name: v[1], type: v[2], notnull: v[3], dflt: v[4], pk: v[5] }));
}

function pkColsOf(d, table) {
  return infoOf(d, table).filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
}

function dumpRows(d, table) {
  const cols = infoOf(d, table).map(c => c.name);
  if (!cols.length) return [];
  const stmt = d.prepare('SELECT ' + cols.map(quoteId).join(', ') + ' FROM ' + quoteId(table));
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function allOn(d, sql, params = []) {
  const args = params.map(v => (v === undefined ? null : v));
  const stmt = d.prepare(sql);
  stmt.bind(args);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function oneOn(d, sql, params = []) {
  return allOn(d, sql, params)[0] || null;
}

// ==================== SENKRON ŞEMASI (kolon + tetikleyici + tombstone) ====================

// Her satırın "yazılma anını" tutar: birleşimde hangi sürümün kazanacağını
// belirler. sync_guid ise satırın instance'lar arası kalıcı kimliğidir; id'ler
// instance'lara özgü olduğu için birleşimde eşleştirme sync_guid ile yapılır.
function ensureSyncSchema() {
  for (const t of tablesOf(db)) {
    if (t === 'sync_tombstones') continue;
    const info = infoOf(db, t);
    if (!info.length) continue;
    for (const [col, type] of [['sync_updated_at', 'TEXT'], ['sync_guid', 'TEXT']]) {
      if (info.some(c => c.name === col)) continue;
      try { db.run('ALTER TABLE ' + quoteId(t) + ' ADD COLUMN ' + col + ' ' + type); }
      catch (e) { console.error('[db] ' + col + ' eklenemedi (' + t + '):', e.message); }
    }
    const fresh = infoOf(db, t);
    const pk = fresh.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
    if (!pk.length) continue;
    const volatile = VOLATILE_COLS[t] || [];
    const stampCols = fresh.map(c => c.name).filter(n => n !== 'sync_updated_at' && !volatile.includes(n));
    if (!stampCols.length) continue;
    const whereNew = pk.map(p => quoteId(p) + ' = NEW.' + quoteId(p)).join(' AND ');
    const whereOld = pk.map(p => quoteId(p) + ' = OLD.' + quoteId(p)).join(' AND ');
    const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    db.run('CREATE TRIGGER IF NOT EXISTS trg_' + t + '_sync_ai AFTER INSERT ON ' + quoteId(t) +
      ' BEGIN UPDATE ' + quoteId(t) + ' SET sync_updated_at = ' + stamp +
      ', sync_guid = COALESCE(sync_guid, lower(hex(randomblob(12)))) WHERE ' + whereNew + '; END');
    db.run('CREATE TRIGGER IF NOT EXISTS trg_' + t + '_sync_au AFTER UPDATE OF ' + stampCols.map(quoteId).join(', ') +
      ' ON ' + quoteId(t) +
      ' BEGIN UPDATE ' + quoteId(t) + ' SET sync_updated_at = ' + stamp + ' WHERE ' + whereOld + '; END');
  }
  db.run(`CREATE TABLE IF NOT EXISTS sync_tombstones (
    table_name TEXT NOT NULL,
    row_pk TEXT NOT NULL,
    row_fp TEXT DEFAULT '',
    deleted_at TEXT NOT NULL,
    PRIMARY KEY (table_name, row_pk)
  )`);
}

// Eski (guid'siz) kayıtlar id ile eşleşir; guid'li kayıtlar kendi kimliğiyle.
const GUID_RE = /^[0-9a-f]{16,64}$/;

function pkKeyOf(values) {
  return JSON.stringify(values.map(v => String(v)));
}

function mergeKeyOf(row, pk) {
  const g = row && row.sync_guid;
  if (g && GUID_RE.test(String(g))) return 'g:' + String(g);
  return 'p:' + pkKeyOf(pk.map(p => row[p]));
}

function identityColsOf(table, row) {
  const cols = IDENTITY_COLS[table];
  if (cols && cols.length) return cols;
  const volatile = VOLATILE_COLS[table] || [];
  return infoOf(db, table).map(c => c.name).filter(n => n !== 'sync_updated_at' && !volatile.includes(n));
}

// Silinen satırın izi: id'ler instance'lar arasında çakışabildiği için,
// silme kaydı başka bir kopyada yanlış satıra uygulanmasın diye tutulur.
function identityFp(table, row) {
  if (!row) return '';
  const parts = identityColsOf(table, row).map(c => (row[c] === undefined || row[c] === null) ? '' : String(row[c]));
  if (!parts.length) return '';
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function addTombstone(table, rowPk, deletedAt, fp) {
  db.run(`INSERT INTO sync_tombstones (table_name, row_pk, row_fp, deleted_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(table_name, row_pk) DO UPDATE SET
            deleted_at = MAX(deleted_at, excluded.deleted_at),
            row_fp = CASE WHEN excluded.deleted_at >= deleted_at THEN excluded.row_fp ELSE row_fp END`,
    [table, String(rowPk), fp || '', deletedAt]);
}

function tombstonesOf(table) {
  const map = new Map();
  try {
    allOn(db, "SELECT row_pk, row_fp, deleted_at FROM sync_tombstones WHERE table_name = ?", [table])
      .forEach(r => map.set(String(r.row_pk), { at: r.deleted_at, fp: r.row_fp || '' }));
  } catch (e) {}
  return map;
}

// Tombstone, izi tutulan satırla eşleşmiyorsa uygulanmaz (yanlış satır silinmesin).
function tombApplies(tombEntry, row, table) {
  if (!tombEntry) return false;
  if (!tombEntry.fp) return true;
  return tombEntry.fp === identityFp(table, row);
}

function pruneTombstones() {
  try {
    db.run('DELETE FROM sync_tombstones WHERE deleted_at < ?', [new Date(Date.now() - TOMBSTONE_TTL_MS).toISOString()]);
  } catch (e) {}
}

// Silinmeyi birleştirilmiş kopyalara da taşır (yoksa silinen satırlar geri gelir).
function recordDelete(table, tail, params) {
  try {
    const now = nowIso();
    const whereEq = /WHERE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=\s*\?/i.exec(tail);
    const children = CASCADE_CHILDREN[table] || [];
    const pk = pkColsOf(db, table);
    if (whereEq && whereEq[1].toLowerCase() === 'id' && pk.length === 1 && pk[0] === 'id') {
      const ids = params.filter(p => p !== undefined && p !== null).map(String);
      if (!ids.length) return;
      for (const id of ids) {
        const row = oneOn(db, 'SELECT * FROM ' + quoteId(table) + ' WHERE id = ?', [id]);
        addTombstone(table, row ? mergeKeyOf(row, pk) : pkKeyOf([id]), now, identityFp(table, row));
        for (const [child, fkCol] of children) {
          const childPk = pkColsOf(db, child);
          if (childPk.length !== 1) continue;
          allOn(db, 'SELECT * FROM ' + quoteId(child) + ' WHERE ' + quoteId(fkCol) + ' = ?', [id])
            .forEach(r => addTombstone(child, mergeKeyOf(r, childPk), now, identityFp(child, r)));
        }
      }
    } else if (!whereEq && pk.length) {
      // WHERE'siz tam silme (ör. nöbetçi eczane listesinin yenilenmesi)
      dumpRows(db, table).forEach(r => addTombstone(table, mergeKeyOf(r, pk), now, identityFp(table, r)));
      for (const [child, fkCol] of children) {
        const childPk = pkColsOf(db, child);
        if (childPk.length !== 1) continue;
        dumpRows(db, child).forEach(r => addTombstone(child, mergeKeyOf(r, childPk), now, identityFp(child, r)));
      }
    } else {
      console.warn('[db] silme kaydı tanınamadı, tombstone eklenemedi:', table, String(tail).trim().slice(0, 60));
    }
  } catch (e) {
    console.error('[db] silme kaydı hatası:', e.message);
  }
}

// ==================== BİRLEŞTİRME (merge) ====================

function tsMs(v) {
  if (v === undefined || v === null || v === '') return 0;
  const s = String(v).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

function tsOf(row) {
  return row.sync_updated_at || row.updated_at || row.created_at || '';
}

function sameVal(a, b) {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  if (x === y) return true;
  if (x === null || y === null) return false;
  if (typeof x === 'number' || typeof y === 'number') return Number(x) === Number(y);
  return String(x) === String(y);
}

function numVal(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function localFileTime() {
  try { return new Date(fs.statSync(DB_PATH).mtimeMs).toISOString(); }
  catch (e) { return ''; }
}

// Bulut kopyasında olup bizde olmayan tablo/kolonları şemaya al (sürüm farkı).
function adoptCloudSchema(cdb) {
  const localTables = tablesOf(db);
  for (const t of tablesOf(cdb)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) continue;
    if (!localTables.includes(t)) {
      const create = oneOn(cdb, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [t]);
      if (create && create.sql) {
        try { db.run(create.sql); }
        catch (e) { console.error('[db] bulut tablosu alınamadı (' + t + '):', e.message); }
      }
      continue;
    }
    const have = infoOf(db, t).map(c => c.name);
    for (const c of infoOf(cdb, t)) {
      if (have.includes(c.name)) continue;
      let def = (c.type || 'TEXT');
      if (c.dflt !== null && c.dflt !== undefined) def += ' DEFAULT ' + c.dflt;
      try { db.run('ALTER TABLE ' + quoteId(t) + ' ADD COLUMN ' + quoteId(c.name) + ' ' + def); }
      catch (e) {}
    }
  }
}

// guid'li bir bulut satırı yerelde taze bir id'ye oturtulur (id'ler instance'a
// özgüdür); sync_updated_at da kaynaktaki değeriyle korunur.
function insertCloudRow(table, cols, row, opts) {
  const options = opts || {};
  const outCols = cols.filter(c => c !== 'sync_updated_at');
  const sql = 'INSERT INTO ' + quoteId(table) + ' (' + outCols.map(quoteId).join(', ') + ') VALUES (' +
    outCols.map(() => '?').join(', ') + ')';
  const buildArgs = () => outCols.map(c => {
    if (c === 'id' && options.newId !== undefined) return options.newId;
    return (row[c] === undefined ? null : row[c]);
  });
  const finish = (args) => {
    db.run(sql, args);
    if (row.sync_updated_at && options.pk && options.pk.length) {
      const keys = options.pk.map(p => (p === 'id' && options.newId !== undefined) ? options.newId : row[p]);
      db.run('UPDATE ' + quoteId(table) + ' SET sync_updated_at = ? WHERE ' +
        options.pk.map(p => quoteId(p) + ' = ?').join(' AND '),
        [row.sync_updated_at].concat(keys));
    }
    return true;
  };
  try {
    return finish(buildArgs());
  } catch (e) {
    if (outCols.includes('slug') && row.slug) {
      try {
        const args = buildArgs();
        args[outCols.indexOf('slug')] = ensureUniqueSlug(String(row.slug), options.newId, table);
        return finish(args);
      } catch (e2) {}
    }
    console.error('[db] satır kopyalanamadı (' + table + '):', e.message);
    return false;
  }
}

// Alt tablo satırlarında FK, ebeveynin yerel idsine çevrilir.
function applyFkMap(table, cols, row, idMaps) {
  const patch = {};
  for (const parent of Object.keys(CASCADE_CHILDREN)) {
    for (const [child, fkCol] of CASCADE_CHILDREN[parent]) {
      if (child !== table || !idMaps[parent] || !cols.includes(fkCol)) continue;
      const mapped = idMaps[parent].get(String(row[fkCol]));
      if (mapped !== undefined) patch[fkCol] = mapped;
    }
  }
  return patch;
}

function updateRow(table, pk, row, values) {
  const cols = Object.keys(values);
  if (!cols.length) return;
  const sql = 'UPDATE ' + quoteId(table) + ' SET ' + cols.map(c => quoteId(c) + ' = ?').join(', ') +
    ' WHERE ' + pk.map(c => quoteId(c) + ' = ?').join(' AND ');
  db.run(sql, cols.map(c => values[c]).concat(pk.map(c => row[c])));
}

function deleteRow(table, pk, row) {
  const sql = 'DELETE FROM ' + quoteId(table) + ' WHERE ' + pk.map(c => quoteId(c) + ' = ?').join(' AND ');
  db.run(sql, pk.map(c => row[c]));
}

function pickWinner(localRow, cloudRow, cloudNewer) {
  const a = tsMs(tsOf(localRow));
  const b = tsMs(tsOf(cloudRow));
  if (a !== b) return b > a ? cloudRow : localRow;
  return cloudNewer ? cloudRow : localRow;
}

function fkParentOf(table, col) {
  for (const [parent, fkCol] of CASCADE_CHILDREN[table] || []) {
    if (fkCol === col) return parent;
  }
  return null;
}

function mergeRows(table, cdb, cloudNewer, idMaps) {
  if (!tablesOf(cdb).includes(table)) return;
  const localInfo = infoOf(db, table);
  const cloudInfo = infoOf(cdb, table);
  const pk = localInfo.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
  const cloudPk = cloudInfo.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
  if (!pk.length || pk.join(',') !== cloudPk.join(',')) return;

  const cloudNames = cloudInfo.map(c => c.name);
  const cols = localInfo.map(c => c.name).filter(n => cloudNames.includes(n));
  const volatile = VOLATILE_COLS[table] || [];
  const tomb = tombstonesOf(table);
  const localRows = dumpRows(db, table);
  const localMap = new Map(localRows.map(r => [mergeKeyOf(r, pk), r]));
  const cloudRows = dumpRows(cdb, table);
  const cloudKeys = new Set();

  let nextId = 0;
  const singleIdPk = pk.length === 1 && pk[0] === 'id';
  if (singleIdPk) {
    nextId = localRows.reduce((m, r) => Math.max(m, numVal(r.id)), 0);
    for (const r of cloudRows) nextId = Math.max(nextId, numVal(r.id));
    nextId += 1;
  }

  for (const cr of cloudRows) {
    const k = mergeKeyOf(cr, pk);
    cloudKeys.add(k);
    const lr = localMap.get(k);
    if (!lr) {
      // Yalnız bulutta var: yerelde silinmediyse ekle
      const deadAt = tomb.get(k);
      if (deadAt && (!tsMs(tsOf(cr)) || tsMs(deadAt.at) >= tsMs(tsOf(cr))) && tombApplies(deadAt, cr, table)) continue;
      const hasGuid = cr.sync_guid && GUID_RE.test(String(cr.sync_guid));
      const newId = (hasGuid && singleIdPk) ? nextId++ : undefined;
      insertCloudRow(table, cols, Object.assign({}, cr, applyFkMap(table, cols, cr, idMaps)),
        { newId: newId, pk: pk });
      if (newId !== undefined) {
        if (!idMaps[table]) idMaps[table] = new Map();
        idMaps[table].set(String(cr.id), newId);
      }
      continue;
    }

    // Eşleşen satır silinmişse (tombstone) silme kazanır; içerik yeniden gelmesin
    const matchTomb = tomb.get(k);
    if (matchTomb && tombApplies(matchTomb, lr, table) && tsMs(matchTomb.at) >= tsMs(tsOf(lr))) {
      deleteRow(table, pk, lr);
      continue;
    }

    // Ebeveyn id'leri instance'a özgüdür: bulutun id'si yerel karşılığına çevrilir
    if (singleIdPk) {
      if (!idMaps[table]) idMaps[table] = new Map();
      idMaps[table].set(String(cr.id), lr.id);
    }

    const diffCols = cols.filter(c => c !== 'sync_updated_at' && !sameVal(lr[c], cr[c]));
    if (!diffCols.length) continue;
    const winner = pickWinner(lr, cr, cloudNewer);
    const loser = winner === lr ? cr : lr;
    const values = {};
    for (const c of diffCols) {
      if (pk.includes(c)) continue;                        // kimlik kolonları asla değişmez
      if (c === 'sync_guid' && lr.sync_guid) continue;      // guid bir kez atanır
      let v;
      if (volatile.includes(c)) {
        // sayaç kolonları: en büyüğü al, satır sürümünü tazeleme
        v = numVal(loser[c]) > numVal(winner[c]) ? loser[c] : winner[c];
      } else if (winner !== lr) {
        // FK değeri bulutun id uzayında olabilir; yerel karşılığına çevir
        const parent = fkParentOf(table, c);
        const idm = parent && idMaps[parent];
        const mapped = idm ? idm.get(String(cr[c])) : undefined;
        v = mapped !== undefined ? mapped : lr[c];
      } else {
        v = winner[c];
      }
      if (!sameVal(lr[c], v)) values[c] = v;
    }
    if (Object.keys(values).length) updateRow(table, pk, lr, values);
  }

  // Yalnız yerelde kalan satırlar: bulut silmişse yerelde de sil
  for (const [k, lr] of localMap) {
    if (cloudKeys.has(k)) continue;
    const deadAt = tomb.get(k);
    if (!deadAt) continue;
    if (tsMs(deadAt.at) >= tsMs(tsOf(lr)) && tombApplies(deadAt, lr, table)) deleteRow(table, pk, lr);
  }
}

// Liste tabloları: iki taraf da sıfırlayıp yeniden dolduruyor, birleşimde
// tüm liste "daha yenisi" olan taraftan alınır (kopya birikimi olmasın).
function mergeSetTable(table, cdb, cloudNewer) {
  if (!tablesOf(cdb).includes(table)) return;
  const pk = pkColsOf(db, table);
  if (!pk.length) return;
  const localRows = dumpRows(db, table);
  const cloudRows = dumpRows(cdb, table);
  if (!cloudRows.length) return;
  const maxLocal = localRows.reduce((m, r) => Math.max(m, tsMs(tsOf(r))), 0);
  const maxCloud = cloudRows.reduce((m, r) => Math.max(m, tsMs(tsOf(r))), 0);
  const takeCloud = !localRows.length || maxCloud > maxLocal || (maxCloud === maxLocal && cloudNewer && cloudRows.length !== localRows.length);
  if (!takeCloud) return;

  // Liste tablolarında satır kimliği id'dir (liste sık sık sıfırlanıp yeniden
  // doldurulur, guid değil); eşleştirme de id ile yapılır.
  const keyOf = r => pkKeyOf(pk.map(p => r[p]));
  const cloudKeys = new Set(cloudRows.map(keyOf));
  const cloudNames = infoOf(cdb, table).map(c => c.name);
  const cols = infoOf(db, table).map(c => c.name).filter(n => cloudNames.includes(n));
  const localMap = new Map(localRows.map(r => [keyOf(r), r]));
  for (const cr of cloudRows) {
    const k = keyOf(cr);
    const lr = localMap.get(k);
    if (!lr) { insertCloudRow(table, cols, cr, { pk: pk }); continue; }
    const diff = cols.filter(c => c !== 'sync_updated_at' && !sameVal(lr[c], cr[c]));
    if (diff.length) {
      const values = {};
      for (const c of diff) values[c] = cr[c];
      updateRow(table, pk, lr, values);
    }
  }
  for (const [k, lr] of localMap) if (!cloudKeys.has(k)) deleteRow(table, pk, lr);
}

function mergeTombstones(cdb) {
  if (!tablesOf(cdb).includes('sync_tombstones')) return;
  const hasFp = infoOf(cdb, 'sync_tombstones').some(c => c.name === 'row_fp');
  for (const r of dumpRows(cdb, 'sync_tombstones')) {
    addTombstone(r.table_name, r.row_pk, r.deleted_at, hasFp ? r.row_fp : '');
  }
}

// Birleştirmeden sonra id'lerin yerel otomatik artırımı en büyük id'nin üstüne
// çekilir; yoksa sonradan eklenen bir satır çakışan id'yi yeniden kullanabilir.
function bumpSequences() {
  try {
    for (const t of tablesOf(db)) {
      const pk = pkColsOf(db, t);
      if (pk.length !== 1 || pk[0] !== 'id') continue;
      const max = oneOn(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM ' + quoteId(t));
      if (!max || !max.m) continue;
      const seq = oneOn(db, 'SELECT name FROM sqlite_sequence WHERE name = ?', [t]);
      if (seq) db.run('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?', [max.m, t]);
      else db.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [t, max.m]);
    }
  } catch (e) {}
}

// Bulut snapshot'ını yerel kopyaya satır bazında uygular.
function mergeCloudBuffer(cloudBuffer, cloudUpdatedAt) {
  if (!db || !SQL || !cloudBuffer) return;
  const cdb = new SQL.Database(Buffer.from(cloudBuffer));
  try {
    const localMtime = localFileTime();
    const cloudNewer = !!(cloudUpdatedAt && localMtime && cloudUpdatedAt > localMtime);
    adoptCloudSchema(cdb);
    ensureSyncSchema();
    db.run('PRAGMA foreign_keys=OFF');
    try {
      const idMaps = {};
      mergeTombstones(cdb);
      // Ebeveyn tablolar önce: alt tablo satırları FK'lerini yerel id'ye çevirebilsin.
      const parents = Object.keys(CASCADE_CHILDREN);
      const order = parents.concat(tablesOf(db).filter(t => !parents.includes(t)));
      for (const t of order) {
        if (t === 'sync_tombstones') continue;
        if (SET_TABLES.includes(t)) mergeSetTable(t, cdb, cloudNewer);
        else mergeRows(t, cdb, cloudNewer, idMaps);
      }
      bumpSequences();
    } finally {
      db.run('PRAGMA foreign_keys=ON');
    }
  } finally {
    cdb.close();
  }
}

// ==================== YEREL DOSYA ====================

// sql.js export() bağlantıyı yeniden kurar ve pragma'ları sıfırlar;
// dışa aktarımdan sonra FK denetimini mutlaka geri aç.
function exportDb() {
  const buf = Buffer.from(db.export());
  try { db.run('PRAGMA foreign_keys=ON'); } catch (e) {}
  return buf;
}

function writeLocalFile(buffer) {
  if (!db) return;
  const buf = buffer || exportDb();
  fs.writeFileSync(DB_PATH, buf);
}

function saveDb() {
  if (!db) return;
  dirty = true;
  writeLocalFile();
  scheduleSnapshot();
}

async function getDb() {
  if (db) return db;
  SQL = await initSqlJs();

  let localBuf = null;
  try {
    if (fs.existsSync(DB_PATH)) localBuf = fs.readFileSync(DB_PATH);
  } catch (e) {
    console.error('[db] yerel dosya okunamadı:', e.message);
  }

  let cloudState = null;
  if (TURSO_URL) {
    try {
      cloudState = await downloadSnapshot();
      console.log('[db] Turso snapshot:', cloudState ? (cloudState.buffer.length / 1024).toFixed(0) + ' KB yüklendi' : 'yok (ilk kurulum)');
    } catch (e) {
      console.error('[db] Turso okuma hatası:', e.message);
    }
  }

  try {
    db = localBuf ? new SQL.Database(localBuf) : null;
  } catch (e) {
    console.error('[db] yerel veritabanı açılamadı:', e.message);
    db = null;
  }
  // Eski davranış: bulut snapshot'ı varsa yerel dosya yok sayılırdı →
  // yereldeki değişiklikler sessizce siliniyordu. Şimdi ikisi de birleştiriliyor.
  if (!db && cloudState) db = new SQL.Database(cloudState.buffer);
  if (!db) db = new SQL.Database();

  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');
  createTables();
  ensureSyncSchema();

  if (localBuf && cloudState && cloudState.buffer) {
    try { mergeCloudBuffer(cloudState.buffer, cloudState.updatedAt); }
    catch (e) { console.error('[db] başlangıç birleştirmesi hatası:', e.message); }
  }

  writeLocalFile();
  scheduleSnapshot();
  return db;
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT UNIQUE,
      badge_text TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      content TEXT NOT NULL,
      main_image_url TEXT DEFAULT '',
      gallery_images TEXT DEFAULT '[]',
      is_headline INTEGER DEFAULT 1,
      headline_order INTEGER DEFAULT 999,
      status TEXT DEFAULT 'active',
      expires_at TEXT DEFAULT NULL,
      views_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const newsCols = db.exec("PRAGMA table_info(news)");
  if (newsCols[0]) {
    const cols = newsCols[0].values.map(r => r[1]);
    if (!cols.includes('slug')) db.run("ALTER TABLE news ADD COLUMN slug TEXT");
    if (!cols.includes('badge_text')) db.run("ALTER TABLE news ADD COLUMN badge_text TEXT DEFAULT ''");
    if (!cols.includes('summary')) db.run("ALTER TABLE news ADD COLUMN summary TEXT DEFAULT ''");
    if (!cols.includes('main_image_url')) db.run("ALTER TABLE news ADD COLUMN main_image_url TEXT DEFAULT ''");
    if (!cols.includes('gallery_images')) db.run("ALTER TABLE news ADD COLUMN gallery_images TEXT DEFAULT '[]'");
    if (!cols.includes('is_headline')) db.run("ALTER TABLE news ADD COLUMN is_headline INTEGER DEFAULT 1");
    if (!cols.includes('headline_order')) db.run("ALTER TABLE news ADD COLUMN headline_order INTEGER DEFAULT 999");
    if (!cols.includes('status')) db.run("ALTER TABLE news ADD COLUMN status TEXT DEFAULT 'active'");
    if (!cols.includes('expires_at')) db.run("ALTER TABLE news ADD COLUMN expires_at TEXT");
    if (!cols.includes('views_count')) db.run("ALTER TABLE news ADD COLUMN views_count INTEGER DEFAULT 0");
    if (!cols.includes('updated_at')) db.run("ALTER TABLE news ADD COLUMN updated_at DATETIME DEFAULT NULL");
    if (!cols.includes('category')) db.run("ALTER TABLE news ADD COLUMN category TEXT DEFAULT 'Gündem'");
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'duyuru',
      image TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const annCols = db.exec("PRAGMA table_info(announcements)");
  if (annCols[0]) {
    const cols = annCols[0].values.map(r => r[1]);
    if (!cols.includes('image')) db.run("ALTER TABLE announcements ADD COLUMN image TEXT DEFAULT ''");
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS pharmacies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      duty_start TEXT DEFAULT NULL,
      duty_end TEXT DEFAULT NULL,
      duty_note TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const pharmCols = db.exec("PRAGMA table_info(pharmacies)");
  if (pharmCols[0]) {
    const cols = pharmCols[0].values.map(r => r[1]);
    if (!cols.includes('duty_note')) db.run("ALTER TABLE pharmacies ADD COLUMN duty_note TEXT DEFAULT ''");
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS ferry_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin TEXT NOT NULL DEFAULT 'Çınarcık İskele',
      destination TEXT NOT NULL,
      data_json TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const ferryCols = db.exec("PRAGMA table_info(ferry_schedules)");
  if (ferryCols[0]) {
    const cols = ferryCols[0].values.map(r => r[1]);
    if (!cols.includes('origin')) db.run("ALTER TABLE ferry_schedules ADD COLUMN origin TEXT NOT NULL DEFAULT 'Çınarcık İskele'");
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT DEFAULT '',
      message TEXT NOT NULL,
      status TEXT DEFAULT 'new',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sightseeing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      description TEXT DEFAULT '',
      image TEXT DEFAULT '',
      gallery_images TEXT DEFAULT '[]',
      category TEXT DEFAULT 'Genel',
      location TEXT DEFAULT '',
      map_link TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 999,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const sightCols = db.exec("PRAGMA table_info(sightseeing)");
  if (sightCols[0]) {
    const cols = sightCols[0].values.map(r => r[1]);
    if (!cols.includes('gallery_images')) db.run("ALTER TABLE sightseeing ADD COLUMN gallery_images TEXT DEFAULT '[]'");
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      category TEXT DEFAULT 'Restoran',
      cuisine_type TEXT DEFAULT '',
      establishment_type TEXT DEFAULT '',
      meal_type TEXT DEFAULT '',
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      working_hours TEXT DEFAULT '',
      map_link TEXT DEFAULT '',
      features TEXT DEFAULT '[]',
      main_image_url TEXT DEFAULT '',
      gallery_images TEXT DEFAULT '[]',
      description TEXT DEFAULT '',
      is_featured INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        type TEXT DEFAULT 'Restoran',
        display_until TEXT DEFAULT NULL,
        sort_order INTEGER DEFAULT 0,
        google_reviews_url TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      category TEXT DEFAULT 'Genel',
      sector TEXT DEFAULT '',
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      website TEXT DEFAULT '',
      email TEXT DEFAULT '',
      working_hours TEXT DEFAULT '',
      map_link TEXT DEFAULT '',
      description TEXT DEFAULT '',
      logo_url TEXT DEFAULT '',
      gallery_images TEXT DEFAULT '[]',
      features TEXT DEFAULT '[]',
      is_featured INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS about_page (
      id INTEGER PRIMARY KEY,
      banner_subtitle TEXT DEFAULT '',
      content TEXT DEFAULT '',
      cta_title TEXT DEFAULT '',
      cta_text TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const aboutRow = db.exec('SELECT COUNT(*) as c FROM about_page');
  if (aboutRow[0] && aboutRow[0].values[0][0] === 0) {
    db.run(`INSERT INTO about_page (id, banner_subtitle, content, cta_title, cta_text) VALUES (1, ?, ?, ?, ?)`, [
      "Marmara'nın huzurlu kıyı kasabası",
      "<h2>🌳 Çınarcık'a Hoş Geldiniz</h2><p>Çınarcık, Yalova iline bağlı, Marmara Denizi kıyısında yer alan şirin bir sahil kasabasıdır. Adını, ilçede bolca bulunan yüzlerce yıllık çınar ağaçlarından almıştır. Doğal güzellikleri, tertemiz sahilleri ve huzurlu atmosferiyle özellikle yaz aylarında İstanbul ve çevre illerden gelen ziyaretçilerin gözde mekanlarındandır.</p><h3>🏖️ Doğal Güzellikler</h3><p>Uzun sahil şeridi, altın kumlu plajları ve tertemiz Marmara suyu ile ünlüdür. Çınarcık sahili, yürüyüş yolları, parkları ve çay bahçeleriyle her yaştan ziyaretçiye hitap eder. Delmece Yaylası ve Dedeler Köyü gibi doğal alanlar doğa severler için harika rotalardan bazılarıdır.</p><h3>🏛️ Tarih ve Kültür</h3><p>Antik dönemde bu bölgede Pythia Termal olarak bilinen termal kaynaklar bulunur. Bugün bile Çınarcık ve çevresinde şifalı termal sular mevcuttur. Osmanlı döneminde sayfiye olarak kullanılan bölge, Cumhuriyet döneminde de önemli bir sahil destinasyonu haline gelmiştir.</p><h3>🍴 Yöresel Lezzetler</h3><p>Taze deniz ürünleri başta olmak üzere, Yalova'ya özgü süt ürünleri ve yöresel tatlılar Çınarcık'ın mutfak kültürünü oluşturur. Sahil boyunca sıralanan balık restoranlarında enfes ziyafetler sizi bekler.</p>",
      "🍳 Çınarcık'ı Keşfet",
      "Mekanları inceleyin, haberleri takip edin, Çınarcık'ın bir parçası olun."
    ]);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_avatar TEXT DEFAULT '',
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (news_id) REFERENCES news(id) ON DELETE CASCADE
    )
  `);

  const placeCols = db.exec("PRAGMA table_info(places)");
  if (placeCols[0]) {
    const cols = placeCols[0].values.map(r => r[1]);
    if (!cols.includes('slug')) db.run("ALTER TABLE places ADD COLUMN slug TEXT");
    if (!cols.includes('category')) db.run("ALTER TABLE places ADD COLUMN category TEXT DEFAULT 'Restoran'");
    if (!cols.includes('cuisine_type')) db.run("ALTER TABLE places ADD COLUMN cuisine_type TEXT DEFAULT ''");
    if (!cols.includes('establishment_type')) db.run("ALTER TABLE places ADD COLUMN establishment_type TEXT DEFAULT ''");
    if (!cols.includes('meal_type')) db.run("ALTER TABLE places ADD COLUMN meal_type TEXT DEFAULT ''");
    if (!cols.includes('working_hours')) db.run("ALTER TABLE places ADD COLUMN working_hours TEXT DEFAULT ''");
    if (!cols.includes('map_link')) db.run("ALTER TABLE places ADD COLUMN map_link TEXT DEFAULT ''");
    if (!cols.includes('features')) db.run("ALTER TABLE places ADD COLUMN features TEXT DEFAULT '[]'");
    if (!cols.includes('main_image_url')) db.run("ALTER TABLE places ADD COLUMN main_image_url TEXT DEFAULT ''");
    if (!cols.includes('gallery_images')) db.run("ALTER TABLE places ADD COLUMN gallery_images TEXT DEFAULT '[]'");
    if (!cols.includes('description')) db.run("ALTER TABLE places ADD COLUMN description TEXT DEFAULT ''");
    if (!cols.includes('is_featured')) db.run("ALTER TABLE places ADD COLUMN is_featured INTEGER DEFAULT 0");
    if (!cols.includes('status')) db.run("ALTER TABLE places ADD COLUMN status TEXT DEFAULT 'active'");
    if (!cols.includes('display_until')) db.run("ALTER TABLE places ADD COLUMN display_until TEXT DEFAULT NULL");
    if (!cols.includes('sort_order')) db.run("ALTER TABLE places ADD COLUMN sort_order INTEGER DEFAULT 0");
    if (!cols.includes('google_reviews_url')) db.run("ALTER TABLE places ADD COLUMN google_reviews_url TEXT DEFAULT ''");
  }

  const companyCols = db.exec("PRAGMA table_info(companies)");
  if (companyCols[0]) {
    const cols = companyCols[0].values.map(r => r[1]);
    if (!cols.includes('google_reviews_url')) db.run("ALTER TABLE companies ADD COLUMN google_reviews_url TEXT DEFAULT ''");
  }
}

function run(sql, params = []) {
  const m = /^\s*DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)\b([\s\S]*)$/i.exec(sql);
  if (m) recordDelete(m[1], m[2], params);
  db.run(sql, params);
  saveDb();
}

function get(sql, params = []) {
  return oneOn(db, sql, params) || {};
}

function all(sql, params = []) {
  return allOn(db, sql, params);
}

// Dışarıdan tek seferlik senkron tetiklemek için (test/kapanış).
async function flushSync(reason) {
  return syncNow(reason || 'manuel');
}

// Exported initializer for external usage
async function initDb() {
  await getDb();
  sweepExpired();
  setInterval(sweepExpired, 60 * 1000);
  setInterval(() => syncNow('periyodik'), SYNC_HEARTBEAT_MS);

  // Kapanışta buluta son bir kez yaz (deploy/Ctrl+C gibi durumlarda).
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
    process.on(sig, () => {
      console.log('[db] kapanış öncesi senkron (' + sig + ')...');
      Promise.race([
        syncNow('kapanış'),
        new Promise(resolve => setTimeout(resolve, 4000))
      ]).catch(() => {}).then(() => process.exit(0));
    });
  });

  return db;
}

function sweepExpired() {
  if (!db) return;
  const now = new Date().toISOString();
  try {
    db.run("UPDATE news SET status='passive' WHERE expires_at IS NOT NULL AND expires_at != '' AND expires_at <= ? AND status='active'", [now]);
    if (db.getRowsModified() > 0) saveDb();
  } catch (e) {}
}

function slugify(text) {
  if (!text) return '';
  return String(text).toLowerCase()
    .replace(/ı/g, 'i').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 80);
}

function parseGallery(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch (e) { return []; }
}

function ensureUniqueSlug(base, excludeId, table) {
  let slug = base || ('item-' + Date.now());
  let suffix = 0;
  const tbl = table || 'news';
  while (true) {
    const exists = get(`SELECT id FROM ${tbl} WHERE slug = ? AND id != ?`, [slug, excludeId || -1]);
    if (!exists || !exists.id) return slug;
    suffix++;
    slug = base + '-' + suffix;
  }
}

module.exports = {
  initDb, saveDb, run, get, all, slugify, parseGallery, ensureUniqueSlug, sweepExpired,
  syncNow, flushSync, mergeCloudBuffer, ensureSyncSchema, writeLocalFile
};
