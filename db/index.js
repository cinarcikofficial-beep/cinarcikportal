const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'cinarcik.db');
const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_TOKEN = process.env.TURSO_TOKEN || '';

let db = null;
let cloud = null;
let syncTimer = null;

function getCloud() {
  if (!TURSO_URL) return null;
  if (!cloud) cloud = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined });
  return cloud;
}

async function downloadSnapshot() {
  const c = getCloud();
  if (!c) return null;
  await c.execute('CREATE TABLE IF NOT EXISTS app_db (id INTEGER PRIMARY KEY CHECK (id = 1), data BLOB NOT NULL, updated_at TEXT)');
  const rs = await c.execute('SELECT data FROM app_db WHERE id = 1');
  if (!rs.rows.length) return null;
  const raw = rs.rows[0].data;
  return Buffer.from(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
}

async function uploadSnapshot() {
  const c = getCloud();
  if (!c || !db) return;
  const buffer = Buffer.from(db.export());
  await c.execute('CREATE TABLE IF NOT EXISTS app_db (id INTEGER PRIMARY KEY CHECK (id = 1), data BLOB NOT NULL, updated_at TEXT)');
  await c.execute({
    sql: 'INSERT INTO app_db (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    args: [buffer, new Date().toISOString()]
  });
}

function scheduleSnapshot() {
  if (!TURSO_URL || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    uploadSnapshot().then(
      () => console.log('[db] Turso snapshot güncellendi'),
      (e) => console.error('[db] Turso yazma hatası:', e.message)
    );
  }, 1500);
}

async function getDb() {
  // Internal function to obtain or create the database instance

  if (db) return db;
  const SQL = await initSqlJs();
  let buffer = null;
  if (TURSO_URL) {
    try {
      buffer = await downloadSnapshot();
      console.log('[db] Turso snapshot:', buffer ? (buffer.length / 1024).toFixed(0) + ' KB yüklendi' : 'yok (ilk kurulum)');
    } catch (e) {
      console.error('[db] Turso okuma hatası:', e.message);
    }
  }
  if (!buffer && fs.existsSync(DB_PATH)) buffer = fs.readFileSync(DB_PATH);
  db = buffer ? new SQL.Database(buffer) : new SQL.Database();
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');
  createTables();
  saveDb();
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  scheduleSnapshot();
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
  db.run(sql, params);
  saveDb();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = {};
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Exported initializer for external usage
async function initDb() {
  await getDb();
  sweepExpired();
  setInterval(sweepExpired, 60 * 1000);
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

module.exports = { initDb, saveDb, run, get, all, slugify, parseGallery, ensureUniqueSlug, sweepExpired };