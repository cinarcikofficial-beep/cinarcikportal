// Sunucu saati Türkiye'ye sabitlenir (Spaceship passenger UTC-4 gibi
// saat diliminde başlatılabiliyor; sefer "sıradaki" vurgusu ve "bugün"
// tabı 7 saat kaymasın). Tüm Date çağrılarından ÖNCE set edilmeli.
process.env.TZ = 'Europe/Istanbul';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const { initDb, flushSync } = require('./db');
const { tx, txFields, txArray, txJsonArrayField } = require('./translator');

const app = express();
app.set('trust proxy', 1);
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
const helmet = require('helmet');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// Yanıtları gzip ile sıkıştır (TTFB + Lighthouse). statik'ten ÖNCE:
// express.static da compression'ın geçtiği res yazmasından faydalanır.
const compression = require('compression');
app.use(compression());

// ---- SEO: tek canonical host + tek URL formu (GSC "Duplicate/Alternate canonical" fix) ----
// Google'in taramalarinda 3 kopya URL uzayi vardi:
//  1) www.marmaraninincisi.com -> 200 (redirect'siz, canonical'i apex'e yonlik)
//     => "Alternate page with proper canonical tag" uyarisi
//  2) /haberler/ (sondaki slash) -> 200 ve canonical'i KENDISI (slash'li)
//     => "Duplicate without user-selected canonical" uyarisi
//  3) Bunlarin www versiyonlari => "Duplicate, Google chose different canonical"
// Cozum: www host 301 -> apex; GET'te sondaki / 301 -> slashesiz. Lokal/hostsuz
// istemler (localhost, IP, server59...) dokunulmaz.
const CANON_HOST = (process.env.SITE_URL || 'https://marmaraninincisi.com')
  .replace(/^https?:\/\//, '').replace(/\/$/, '');
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host === 'www.' + CANON_HOST) {
    return res.redirect(301, 'https://' + CANON_HOST + req.originalUrl);
  }
  const qi = req.originalUrl.indexOf('?');
  const p = qi === -1 ? req.originalUrl : req.originalUrl.slice(0, qi);
  const q = qi === -1 ? '' : req.originalUrl.slice(qi);
  if (req.method === 'GET' && p.length > 1 && /\/+$/.test(p)) {
    return res.redirect(301, p.replace(/\/+$/, '') + q);
  }
  next();
});
const PORT = process.env.PORT || 3000;

// Admin aksiyonları sonrası köşe bildirimi (Windows tarzı toast): hedefe
// ?msg=<metin>&mtype=<success|error|info> ekler; layout.ejs bunu gösterir.
function flash(res, path, message, type) {
  const sep = path.includes('?') ? '&' : '?';
  res.redirect(path + sep + 'msg=' + encodeURIComponent(message) + '&mtype=' + (type || 'success'));
}

const engine = require('ejs-mate');
app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Statik varlıklar için optimize HTTP Cache-Control (30 gün değişmeyen medya / 7 gün CSS-JS)
function setStaticCacheHeaders(res, filePath) {
  // PWA: service worker ve manifest her zaman taze kontrol edilmeli (güncellemeler hemen yayılsın)
  if (/[\\/](sw\.js|manifest\.webmanifest|offline\.html)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'no-cache');
    if (/\.webmanifest$/i.test(filePath)) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    return;
  }
  if (/\.(webp|png|jpe?g|gif|svg|ico|woff2?|ttf|eot)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  } else if (/\.(css|js)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
  }
}
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  index: false,
  setHeaders: setStaticCacheHeaders
}));
app.use('/images', express.static(path.join(__dirname, 'images'), {
  maxAge: '30d',
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=2592000, immutable')
}));

// ---- Rate Limiting (Bot, Spam & DoS Koruması) ----
const { rateLimit } = require('express-rate-limit');
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Kısa sürede çok fazla mesaj gönderdiniz. Lütfen 15 dakika sonra tekrar deneyin.',
  standardHeaders: true,
  legacyHeaders: false
});
const commentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Kısa sürede çok fazla yorum gönderdiniz. Lütfen 15 dakika sonra tekrar deneyin.' },
  standardHeaders: true,
  legacyHeaders: false
});
const likeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, error: 'Çok hızlı işlem yapıyorsunuz.' },
  standardHeaders: true,
  legacyHeaders: false
});
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, error: 'Arama sınırı aşıldı, lütfen biraz bekleyin.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// IndexNow: yeni/güncellenen sayfaları Bing, Yandex, Naver gibi motorlara anında
// bildirir. Anahtar doszası: public/<KEY>.txt (hem doğrulama hem keyLocation).
const SITE_ORIGIN = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
const INDEXNOW_KEY = '08ce8c9e17193c10a9078706e0e017a2';
function pingIndexNow(paths) {
  const urls = (Array.isArray(paths) ? paths : [paths]).filter(Boolean).map(p => SITE_ORIGIN + p);
  if (!urls.length) return;
  fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: 'marmaraninincisi.com',
      key: INDEXNOW_KEY,
      keyLocation: SITE_ORIGIN + '/' + INDEXNOW_KEY + '.txt',
      urlList: urls
    })
  }).then(r => console.log('[indexnow] ' + r.status + ' ' + urls.join(',')))
    .catch(e => console.warn('[indexnow]', e.message));
}

// Oturumlar diskte tutulur (session-store.js) — restart/deploy'ta admin 2FA
// ve Google giris oturumlari dusmesin. Bellek store'undan fark: kalici.
const FileSessionStore = require('./session-store');
app.use(session({
  store: new FileSessionStore({ dir: path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || 'cinarcik-portal-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { maxAge: 90 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));

// Kalıcı admin "beni hatırla" token'ı — session deploy/restart'ta düşse de
// tarayıcı çerezinde kalır; Çıkış yap'a basılmadıkça yeniden OTP gerekmez.
const ADMIN_REMEMBER_COOKIE = 'admin_rt';
const ADMIN_REMEMBER_DAYS = 90;
function adminTokenSecret() {
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'cinarcik-portal-secret-key-2024').digest();
}
function signAdminToken(exp) {
  return crypto.createHmac('sha256', adminTokenSecret()).update(String(exp)).digest('base64url');
}
function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!exp || Date.now() > exp) return false;
  const expected = signAdminToken(exp);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setAdminRememberCookie(res) {
  const exp = Date.now() + ADMIN_REMEMBER_DAYS * 24 * 60 * 60 * 1000;
  res.cookie(ADMIN_REMEMBER_COOKIE, `${exp}.${signAdminToken(exp)}`, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: ADMIN_REMEMBER_DAYS * 24 * 60 * 60 * 1000
  });
}
function clearAdminRememberCookie(res) {
  res.clearCookie(ADMIN_REMEMBER_COOKIE, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
}

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const adminBasicAuth = (req, res, next) => {
  const user = process.env.ADMIN_BASIC_USER;
  const pass = process.env.ADMIN_BASIC_PASS;
  if (!user || !pass) return next();
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx > -1 && decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin", charset="UTF-8"');
  return res.status(401).send('Yetkisiz erişim.');
};

// Admin POST'larında basit CSRF koruması: Origin/Referer aynı host olmalı
app.use('/admin', (req, res, next) => {
  if (req.method !== 'POST') return next();
  const source = req.headers.origin || req.headers.referer;
  if (source) {
    try {
      if (new URL(source).host !== req.headers.host) {
        return res.status(403).send('Geçersiz istek kaynağı');
      }
    } catch (e) {
      return res.status(403).send('Geçersiz istek kaynağı');
    }
  }
  next();
});

// Admin içerik yazmaları (haber/mekan/firma/gezilecek yer...) ancak Turso'ya
// flush edildikten sonra onaylanır. Böylece yazma, yalnızca ephemeral Render
// diskinde kalıp process SIGKILL ile öldürülünce (deploy/uuyku) kaybolmaz.
// syncNow kısa devre yapar (kirli değilse), bu yüzden yazmayan POST'lar ucuzdur.
app.use('/admin', (req, res, next) => {
  if (req.method !== 'POST') return next();
  const originalRedirect = res.redirect.bind(res);
  res.redirect = function (...args) {
    Promise.race([
      flushSync('admin-post'),
      new Promise(r => setTimeout(r, 3000))
    ]).catch(() => {}).finally(() => originalRedirect(...args));
  };
  next();
});

// Login brute-force koruması (IP başına 10 dk içinde 10 deneme)
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const rec = loginAttempts.get(key) || { count: 0, reset: now + 10 * 60 * 1000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 10 * 60 * 1000; }
  if (rec.count >= 10) {
    return res.status(429).render('admin/login', { error: 'Çok fazla deneme. Lütfen 10 dakika sonra tekrar deneyin.' });
  }
  rec.count++;
  loginAttempts.set(key, rec);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now > v.reset) loginAttempts.delete(k);
}, 10 * 60 * 1000).unref();

const i18n = require('./i18n');
app.use((req, res, next) => {
  const m = req.url.match(/^\/(en|ru|ar|de|fr|nl)(?=\/|$|\?)/);
  req.lang = m ? m[1] : 'tr';
  if (m) {
    // Query string'i koru: '/en?x=1' → '/?x=1'. Yalnızca path kesiilirse
    // '?x=1' gibi geçersiz bir url kalır, req.path null olur → 500.
    const rest = req.url.slice(m[1].length + 1);
    req.url = !rest ? '/' : (rest.startsWith('/') ? rest : '/' + rest);
  }
  res.locals.isAdmin = req.session.isAdmin || false;
  res.locals.isGoogleAuth = req.session.isGoogleAuth || false;
  res.locals.googleUser = req.session.googleUser || null;
  res.locals.path = req.path;
  res.locals.lang = req.lang;
  res.locals.lp = req.lang === 'tr' ? '' : '/' + req.lang;
  res.locals.dir = 'ltr';
  res.locals.siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  // Admin sayfaları ve hata sayfaları Google'da görünmesin.
  res.locals.robotsMeta = req.path.startsWith('/admin') ? 'noindex, nofollow' : 'index, follow';
  res.locals.t = (key) => i18n.t(req.lang, key);
  res.locals.langs = i18n.LANGS;
  res.locals.recaptchaSiteKey = typeof getActiveRecaptchaSiteKey === 'function' ? getActiveRecaptchaSiteKey() : '';
  // CSS url() içinde boşluk ve Türkçe karakter geçersizdir; görsel hiç yüklenmez.
  res.locals.img = (src) => {
    if (!src) return '';
    try { return encodeURI(String(src)).replace(/"/g, '%22'); } catch (e) { return String(src); }
  };
  next();
});

// ---- Sayfa trafiği loglama (admin raporları için) ----
// Statik dosyalar express.static'te kısa yoldan döner; buraya yalnızca sayfa
// GET'leri ulaşır. /admin trafiği bilinçli olarak hariç tutulur (kendi
// girişlerimiz istatistikleri bozmasın).
// Bot/izleyici istekleri sayaçları şişirmesin: Googlebot gibi tarayıcılar,
// UptimeRobot gibi izleme servisleri, komut satırı istemcileri ve sosyal
// önizleme robotları sayılmaz.
const BOT_UA_RE = /bot|crawl|spider|slurp|uptime|pingdom|statuscake|kuma|monitor|headless|lighthouse|curl|wget|python|go-http-client|axios|node-fetch|postman|insomnia|powershell|burp|nikto|sqlmap|nmap|masscan|zgrab|censys|shodan|cf-network|okhttp|dalvik|apache-httpclient|java\/|libwww|lwp-trivial|scrapy|playwright|puppeteer|phantomjs|selenium|webdriver|facebookexternalhit|whatsapp|telegrambot|embedly|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|applebot|yandexbot|baiduspider|duckduckbot|feedfetcher|linkedin|twitterbot|slack|discordbot|pinterest|bingpreview|googleother|adsbot|mediapartners/i;
const NON_PAGE_PATH_RE = /^\/(admin|api|uploads|img|css|js|fonts|favicon|robots\.txt|sitemap\.xml|rss\.xml|captcha\.svg)|(\.(?:png|jpe?g|webp|gif|svg|ico|css|js|map|woff2?|ttf|eot|xml|txt|json|mp4|webm|pdf))$/i;
function isBotRequest(req) {
  const ua = req.headers['user-agent'] || '';
  if (!ua || ua.length < 12) return true; // UA'siz veya çok kısa istekler pratikte hep bot/script
  return BOT_UA_RE.test(ua);
}
function isTrackablePagePath(p) {
  if (!p || typeof p !== 'string') return false;
  return !NON_PAGE_PATH_RE.test(p);
}
const { logPageView } = require('./db');
app.use((req, res, next) => {
  if (req.method !== 'GET' || !isTrackablePagePath(req.path) || isBotRequest(req)) return next();
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    logPageView({
      path: req.path,
      method: req.method,
      status: res.statusCode,
      ip: req.ip,
      user_agent: req.headers['user-agent'] || '',
      referrer: req.headers.referer || req.headers.referrer || ''
    });
  });
  next();
});

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function isAuthenticated(req, res, next) {
  if (req.session.isAdmin) return next();
  // Session düşmüşse (deploy/restart) kalıcı token ile otomatik geri gel
  if (verifyAdminToken(getCookie(req, ADMIN_REMEMBER_COOKIE))) {
    req.session.regenerate((err) => {
      if (err) return res.redirect('/admin/login');
      req.session.isAdmin = true;
      setAdminRememberCookie(res);
      next();
    });
    return;
  }
  res.redirect('/admin/login');
}

// Ortak mail gönderici: Brevo/SendGrid HTTP API → SMTP fallback → konsol
async function sendPortalMail({ to, subject, text, html, replyTo, logTag }) {
  const tag = logTag || 'mail';
  const apiKey = process.env.EMAIL_API_KEY;

  // 1) HTTP e-posta API (Render free plan SMTP portlarını engelliyor — 443 açık)
  if (apiKey) {
    const from = process.env.EMAIL_FROM || 'cinarcikofficial@gmail.com';
    const provider = String(process.env.EMAIL_PROVIDER ||
      (apiKey.startsWith('xkeysib-') ? 'brevo' : 'sendgrid')).toLowerCase();
    let url, headers, payload;
    if (provider === 'brevo') {
      url = 'https://api.brevo.com/v3/smtp/email';
      headers = { 'Content-Type': 'application/json', 'api-key': apiKey };
      payload = {
        sender: { email: from, name: 'Çınarcık Portal' },
        to: [{ email: to }],
        subject,
        textContent: text
      };
      if (html) payload.htmlContent = html;
      if (replyTo) payload.replyTo = { email: replyTo };
    } else {
      url = 'https://api.sendgrid.com/v3/mail/send';
      headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
      payload = {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: 'text/plain', value: text }]
      };
      if (html) payload.content.push({ type: 'text/html', value: html });
      if (replyTo) payload.reply_to = { email: replyTo };
    }
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!resp.ok) throw new Error(provider + ' HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
    console.log('[' + tag + '] ' + provider + ' ile gönderildi →', to);
    return;
  }

  // 2) Yerel fallback: SMTP
  const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
  const smtpUser = process.env.SMTP_USER || process.env.GMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD;
  if (!smtpHost || !smtpUser || !smtpPass) {
    console.log('[' + tag + '] SMTP ayarı yok — e-posta konsola yazıldı:\n' + text);
    return;
  }
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: smtpUser, pass: smtpPass },
    connectionTimeout: 10 * 1000,
    greetingTimeout: 10 * 1000,
    socketTimeout: 20 * 1000
  });
  await transporter.sendMail({
    from: smtpUser,
    to,
    replyTo: replyTo || undefined,
    subject,
    text,
    html: html || undefined
  });
}

async function sendAdmin2FACode(code) {
  await sendPortalMail({
    to: process.env.ADMIN_2FA_EMAIL || 'kerimkaplan@yahoo.com',
    subject: 'Admin doğrulama kodu',
    text: 'Admin paneli giriş doğrulama kodunuz: ' + code + '\n\nBu kod 10 dakika geçerlidir.',
    logTag: '2fa'
  });
}

function ferryKey(text) {
  return String(text || '').toLowerCase()
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');
}

function ferryShortName(text) {
  return String(text || '').replace(/\s*Iskele$/i, '').replace(/\s*İskele$/i, '').trim();
}

function buildFerryGroups(rows) {
  const order = { eminonu: 0 };
  const itemsOf = (origin, match) => rows
    .filter(r => r.origin === origin && match(ferryKey(r.destination)))
    .map(r => ({ label: ferryShortName(r.destination), columns: r.columns, prices: r.prices || [] }))
    .sort((a, b) => (order[ferryKey(a.label)] ?? 9) - (order[ferryKey(b.label)] ?? 9));

  const groups = [];
  const gidis = itemsOf('Çınarcık İskele', d => d.includes('eminonu'));
  if (gidis.length) groups.push({ title: 'Çınarcık → Eminönü', badge: 'Gidiş', showLabel: gidis.length > 1, items: gidis });

  const donus = itemsOf('Eminönü İskele', d => d.includes('cinarcik'));
  if (donus.length) groups.push({ title: 'Eminönü → Çınarcık', badge: 'Dönüş', showLabel: donus.length > 1, items: donus });

  return groups;
}

app.get('/sitemap.xml', (req, res) => {
  const { all } = require('./db');
  const base = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const langs = ['', '/en', '/ru', '/ar', '/de', '/fr', '/nl'];
  const entries = [];

  const addEntry = (path, lastmod) => {
    entries.push({ path, lastmod: lastmod || new Date().toISOString().slice(0, 10) });
  };

  // Statik sayfalar gerçekten değiştiğinde güncelleyin — her gün "bugün"
  // yazmak Google'a sürekli değişiyormuş gibi görünürdü.
  const STATIC_LASTMOD = '2026-10-14';

  // Statik sayfalar
  ['/', '/haberler', '/duyurular', '/mekanlar', '/gezilecek-yerler', '/rehber', '/iletisim', '/cinarcik-hakkinda', '/ilan-ver', '/uygulama']
    .forEach(p => addEntry(p, STATIC_LASTMOD));
  // Yeni eklenen sayfalar (ilk indeks tarihi)
  ['/etkinlikler', '/deniz', '/gizlilik'].forEach(p => addEntry(p, '2026-10-17'));
  ['/ulasim'].forEach(p => addEntry(p, '2026-10-20'));
  ['/sizlerden-gelen'].forEach(p => addEntry(p, '2026-10-25'));

  // Haberler (son 500)
  try {
    all("SELECT slug, id, updated_at, created_at FROM news WHERE status='active' ORDER BY created_at DESC LIMIT 500")
      .forEach(n => addEntry('/haber/' + (n.slug || n.id), (n.updated_at || n.created_at || '').slice(0, 10)));
  } catch (e) { console.error('sitemap news:', e.message); }

  // Duyurular (announcements tablosunda updated_at YOK)
  try {
    all("SELECT slug, id, created_at FROM announcements WHERE status='active' ORDER BY created_at DESC LIMIT 500")
      .forEach(a => addEntry('/duyuru/' + (a.slug || a.id), (a.created_at || '').slice(0, 10)));
  } catch (e) { console.error('sitemap announcements:', e.message); }

  // Mekanlar
  try {
    all("SELECT slug, id, created_at FROM places WHERE status='active'")
      .forEach(p => addEntry('/mekan/' + (p.slug || p.id), (p.created_at || '').slice(0, 10)));
  } catch (e) { console.error('sitemap places:', e.message); }

  // Gezilecek yerler
  try {
    all("SELECT slug, id, created_at FROM sightseeing WHERE status='active'")
      .forEach(s => addEntry('/gezilecek-yer/' + (s.slug || s.id), (s.created_at || '').slice(0, 10)));
  } catch (e) { console.error('sitemap sightseeing:', e.message); }

  // Firma rehberi
  try {
    all("SELECT slug, id, created_at FROM companies WHERE status='active'")
      .forEach(c => addEntry('/rehber/' + (c.slug || c.id), (c.created_at || '').slice(0, 10)));
  } catch (e) { console.error('sitemap companies:', e.message); }

  const urls = entries.map(e => {
    const alternates = langs.map(l =>
      `    <xhtml:link rel="alternate" hreflang="${l === '' ? 'tr' : l.slice(1)}" href="${base}${l}${e.path}"/>`
    ).join('\n') +
      `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${base}${e.path}"/>`;
    return `  <url>\n    <loc>${base}${e.path}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n${alternates}\n  </url>`;
  }).join('\n');

  res.header('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>`);
});

// RSS: son haberler — Google News/okuyucu uygulamalari ve sosyal paylasim
// kartlari icin. Basliklar DB'de orijinal (TR); ceviriler content_translations'da.
app.get('/rss.xml', (req, res) => {
  const { all } = require('./db');
  const base = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const esc = s => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  let items = [];
  try {
    items = all("SELECT slug, id, title, summary, content, created_at, main_image_url FROM news WHERE status='active' ORDER BY created_at DESC LIMIT 30");
  } catch (e) { console.error('rss:', e.message); }
  const latest = items.length ? items[0].created_at : new Date().toISOString();
  const xmlItems = items.map(n => {
    const url = base + '/haber/' + (n.slug || n.id);
    const desc = stripHtml(n.summary || n.content || '').slice(0, 300);
    return [
      '    <item>',
      '      <title>' + esc(n.title) + '</title>',
      '      <link>' + esc(url) + '</link>',
      '      <guid isPermaLink="true">' + esc(url) + '</guid>',
      '      <pubDate>' + new Date(n.created_at).toUTCString() + '</pubDate>',
      '      <description>' + esc(desc) + '</description>',
      '    </item>'
    ].filter(Boolean).join('\n');
  }).join('\n');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>Marmara\'nın İncisi — Haberler</title>',
    '    <link>' + base + '/</link>',
    '    <description>Çınarcık haber, duyuru ve etkinlik akışı</description>',
    '    <language>tr</language>',
    '    <lastBuildDate>' + new Date(latest).toUTCString() + '</lastBuildDate>',
    '    <atom:link href="' + base + '/rss.xml" rel="self" type="application/rss+xml"/>',
    xmlItems,
    '  </channel>',
    '</rss>'
  ].join('\n');
  res.header('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(xml);
});

app.get('/', async (req, res) => {
  const { all, get } = require('./db');
  const announcements = all("SELECT * FROM announcements WHERE status = 'active' ORDER BY sort_order ASC, created_at DESC LIMIT 4");
  // Ana sayfa manşeti: /haberler ile birebir aynı kaynak ve sıralama,
  // böylece admin'de yapılan her değişiklik ana sayfada da aynen görünür.
  const newsWhere = `status='active'
      AND (expires_at IS NULL OR expires_at='' OR datetime(replace(expires_at, 'T', ' ')) > datetime('now'))`;
  const headlines = all(`SELECT * FROM news WHERE ${newsWhere}
      ORDER BY created_at DESC, id DESC LIMIT 5`);
  const regularNews = headlines;
  const places = all(`
    SELECT p.*, ROUND(AVG(r.rating), 1) AS avg_rating, COUNT(r.id) AS review_count
    FROM places p
    LEFT JOIN place_reviews r ON r.place_id = p.id
    WHERE p.status = 'active' AND (p.display_until IS NULL OR p.display_until >= datetime('now'))
    GROUP BY p.id
    ORDER BY p.sort_order ASC, p.is_featured DESC, p.created_at DESC LIMIT 6
  `);
  const companies = all("SELECT * FROM companies WHERE status = 'active' ORDER BY is_featured DESC, sort_order ASC, created_at DESC LIMIT 3");
  const sightseeing = all("SELECT * FROM sightseeing WHERE status = 'active' ORDER BY sort_order ASC, created_at DESC LIMIT 3");
  const photos = all("SELECT id, title, description, image, author_name, created_at FROM photo_submissions WHERE status = 'active' ORDER BY created_at DESC LIMIT 3");
  // Anasayfa anketi: aktif anket + secenekleri (oy sayisi public'te HIC gosterilmez, yalniz oy vermine sonra
  // POST /api/poll/oy donusu icerisinde doner)
  const pollRow = get("SELECT id, question FROM polls WHERE status = 'active' ORDER BY created_at DESC LIMIT 1");
  const pollOptions = (pollRow && pollRow.id) ? all('SELECT id, label FROM poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC', [pollRow.id]) : [];
  const pollData = (pollRow && pollRow.id && (pollOptions || []).length >= 2) ? { id: pollRow.id, question: pollRow.question, options: pollOptions } : null;
  // "Bu hafta Çınarcık" modulu: yaklasan tarihli etkinlikler + deniz/hava verisi
  const weekEvents = all(`SELECT * FROM announcements WHERE status='active' AND category='etkinlik'
      AND event_date IS NOT NULL AND event_date <> '' AND event_date >= ?
      ORDER BY event_date ASC LIMIT 4`, [fmtDateLocal(new Date())]);
  const sea = await getSeaData({ allowStale: true, waitMs: 1500 });
  // Aynı eczane farklı id'lerle birden fazla satırdaysa tek kart basılır
  // (telefonu dolu olan satır tercih edilir).
  const seenPharm = new Map();
  for (const p of all("SELECT * FROM pharmacies WHERE status = 'active' ORDER BY name ASC")) {
    const key = String(p.name || '').toLowerCase() + '|' + String(p.address || '').trim().toLowerCase();
    const prev = seenPharm.get(key);
    if (!prev || (!String(prev.phone || '').trim() && String(p.phone || '').trim())) seenPharm.set(key, p);
  }
  const pharmacies = Array.from(seenPharm.values()).sort((a, b) => String(a.name).localeCompare(String(b.name), 'tr'));
  const ferryRows = all('SELECT * FROM ferry_schedules ORDER BY id ASC').map(r => {
    let columns = [];
    try { columns = JSON.parse(r.data_json || '[]'); } catch (e) { columns = []; }
    let prices = [];
    try { prices = JSON.parse(r.prices_json || '[]'); } catch (e) { prices = []; }
    return { origin: r.origin || 'Çınarcık İskele', destination: r.destination, columns, prices, updated_at: r.updated_at };
  });
  const lang = req.lang;
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  await Promise.all([
    txArray(announcements, ['title', 'content'], lang),
    txArray(weekEvents, ['title'], lang),
    txArray(places, ['description', 'working_hours'], lang),
    txArray(companies, ['description', 'sector'], lang),
    txArray(sightseeing, ['title', 'summary', 'description'], lang),
    txArray(headlines, ['title', 'summary'], lang),
    txArray(regularNews, ['title', 'summary'], lang)
  ]);
  res.render('home', {
    announcements, places, companies, pharmacies, sightseeing, photos, ferryGroups: buildFerryGroups(ferryRows),
    transport: getCityTransport(),
    idoTransport: getIdoTransport(),
    powerOutages: getPowerOutages(),
    suOutages: getSuOutages(),
    headlines, regularNews, weekEvents, sea, pollData,
    // LCP: hero 1. slayt + manşet ilk görseli <head>'de preload edilir (layout.ejs)
    preloadImages: ['/images/cinar/1.webp'].concat(
      headlines[0] && headlines[0].main_image_url && String(headlines[0].main_image_url).indexOf('/uploads/') === 0
        ? [res.locals.img(headlines[0].main_image_url)] : []),
    pageTitle: 'Çınarcık Haberleri, Mekan & Gezi Rehberi',
    metaDescription: i18n.t(req.lang, 'metaDesc'),
    pageSchema: {
      "@context": "https://schema.org",
      "@type": "TouristDestination",
      "name": "Çınarcık",
      "description": "Çınarcık, Yalova — Marmara kıyısında haber, mekan, firma ve gezi rehberi.",
      "url": siteUrl + '/',
      "address": { "@type": "PostalAddress", "addressLocality": "Çınarcık", "addressRegion": "Yalova", "addressCountry": "TR" },
      "geo": { "@type": "GeoCoordinates", "latitude": 40.6667, "longitude": 29.1333 },
      "touristType": ["Yerli turist", "Yabancı turist", "Günlük ziyaretçi"]
    }
  });
});

app.get('/haberler', async (req, res) => {
  const { all } = require('./db');
  const headlines = all("SELECT * FROM news WHERE status='active' AND is_headline=1 AND (expires_at IS NULL OR expires_at='' OR datetime(replace(expires_at, 'T', ' ')) > datetime('now')) ORDER BY headline_order ASC, created_at DESC LIMIT 10");
  const regularNews = all("SELECT * FROM news WHERE status='active' AND (is_headline=0 OR is_headline IS NULL) AND (expires_at IS NULL OR expires_at='' OR datetime(replace(expires_at, 'T', ' ')) > datetime('now')) ORDER BY sort_order ASC, created_at DESC");
  await Promise.all([
    txArray(headlines, ['title', 'summary'], req.lang),
    txArray(regularNews, ['title', 'summary'], req.lang)
  ]);
  const ranked = headlines.concat(regularNews).sort((a, b) => (Number(b.views_count) || 0) - (Number(a.views_count) || 0));
  const mostRead = ranked.slice(0, 5);
  const otherNews = ranked.slice(5, 12);
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  res.render('news', {
    headlines, regularNews, mostRead, otherNews,
    pageTitle: i18n.t(req.lang, 'currentNews') + ' & Çınarcık Haberleri',
    metaDescription: 'Çınarcık son dakika haberleri, yerel gündem, asayiş, spor ve güncel gelişmeler — Marmara\'nın İncisi.',
    pageSchema: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          "name": "Çınarcık Haberleri",
          "description": "Çınarcık son dakika haberleri, yerel gündem ve güncel gelişmeler.",
          "url": siteUrl + lp + '/haberler'
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
            { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'news') }
          ]
        }
      ]
    }
  });
});

app.get('/haber/:slug', async (req, res) => {
  const { get, all, run } = require('./db');
  const article = get("SELECT * FROM news WHERE slug = ? OR id = ?", [req.params.slug, isNaN(parseInt(req.params.slug)) ? -1 : req.params.slug]);
  if (!article || !article.id) return res.redirect('/haberler');
  if (!isBotRequest(req)) run("UPDATE news SET views_count = views_count + 1 WHERE id = ?", [article.id]);
  // İlgili haberler: aynı kategori önce, sonra en yeni (aktif + süresi geçmemiş)
  // (txFields'ten ÖNCE — article.category hala ham DB değeri olur, eşleşme garantili)
  const related = all("SELECT * FROM news WHERE status='active' AND id != ? AND (expires_at IS NULL OR expires_at='' OR datetime(replace(expires_at, 'T', ' ')) > datetime('now')) ORDER BY (CASE WHEN category = ? THEN 0 ELSE 1 END), created_at DESC LIMIT 3", [article.id, article.category]);
  await Promise.all([
    txFields(article, ['title', 'summary', 'content', 'category', 'badge_text'], req.lang),
    txArray(related, ['title', 'summary'], req.lang)
  ]);
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  const absUrl = siteUrl + lp + '/haber/' + (article.slug || article.id);
  const commentCaptchaImage = svgDataUri(issueCaptcha(req));
  res.render('news-detail', {
    article, req,
    related,
    commentCaptchaImage,
    pageTitle: article.title,
    metaDescription: article.summary || i18n.t(req.lang, 'metaDescShort'),
    ogType: 'article',
    ogImage: article.main_image_url || '',
    pageSchema: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "NewsArticle",
          "headline": article.title,
          "description": article.summary || '',
          "image": article.main_image_url ? [article.main_image_url] : undefined,
          "datePublished": article.created_at,
          "dateModified": article.updated_at || article.created_at,
          "author": { "@type": "Organization", "name": "Marmara'nın İncisi", "url": siteUrl + '/' },
          "publisher": {
            "@type": "Organization",
            "name": "Marmara'nın İncisi",
            "logo": { "@type": "ImageObject", "url": siteUrl + '/img/logo-circle.png' }
          },
          "mainEntityOfPage": { "@type": "WebPage", "@id": absUrl },
          "articleSection": article.category || undefined,
          "inLanguage": req.lang
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
            { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'news'), "item": siteUrl + lp + '/haberler' },
            { "@type": "ListItem", "position": 3, "name": article.title }
          ]
        }
      ]
    }
  });
});

app.get('/api/news', (req, res) => {
  const { all } = require('./db');
  const limit = Math.min(parseInt(req.query.limit) || 25, 25);
  // Ana sayfa slider'ı yalnızca manşet olarak işaretlenen haberleri göstermeli;
  // aksi halde "sadece listede" haberler de manşete giriyordu.
  const headlineOnly = req.query.headlines === '1';
  const news = all(`SELECT id, slug, title, badge_text, summary, main_image_url, headline_order, views_count, created_at, expires_at
    FROM news
    WHERE status='active'
      ${headlineOnly ? 'AND (is_headline=1 OR is_headline IS NULL)' : ''}
      AND (expires_at IS NULL OR expires_at='' OR datetime(replace(expires_at, 'T', ' ')) > datetime('now'))
    ORDER BY headline_order ASC, created_at DESC
    LIMIT ?`, [limit]);
  res.json({ success: true, count: news.length, news });
});

app.get('/api/news/:slug', (req, res) => {
  const { get, run } = require('./db');
  const item = get("SELECT * FROM news WHERE slug = ? OR id = ?", [req.params.slug, isNaN(parseInt(req.params.slug)) ? -1 : req.params.slug]);
  if (!item || !item.id) return res.status(404).json({ success: false, error: 'Haber bulunamadı' });
  if (!isBotRequest(req)) run("UPDATE news SET views_count = views_count + 1 WHERE id = ?", [item.id]);
  res.json({ success: true, news: item });
});

app.get('/duyurular', async (req, res) => {
  const { all } = require('./db');
  const announcements = all("SELECT * FROM announcements WHERE status = 'active' ORDER BY sort_order ASC, created_at DESC");
  await txArray(announcements, ['title', 'content'], req.lang);
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  res.render('announcements', {
    announcements,
    submitted: req.query.gonderildi === '1',
    pageTitle: i18n.t(req.lang, 'annList') + ' & İlanlar',
    metaDescription: 'Çınarcık duyuru, etkinlik ve seri ilanları: satılık/kiralık ev, iş ve eleman ilanları — Marmara\'nın İncisi.',
    pageSchema: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          "name": "Çınarcık Duyuru ve İlanlar",
          "description": "Çınarcık duyuru, etkinlik ve seri ilanlar.",
          "url": siteUrl + lp + '/duyurular'
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
            { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'annList') }
          ]
        }
      ]
    }
  });
});

// ---------- Deniz durumu (Open-Meteo Marine + forecast, 20 dk cache) ----------
const seaCache = { data: null, ts: 0, fetching: null };
const SEA_TTL_MS = 20 * 60 * 1000;
const SEA_COORD = 'latitude=40.6475&longitude=29.0736'; // Çınarcık

function degToCompass(deg) {
  const dirs = ['K', 'KKD', 'KD', 'DKD', 'D', 'DGD', 'GD', 'GGD', 'G', 'GGB', 'GB', 'BGB', 'B', 'BKB', 'KB', 'KKB'];
  if (deg == null || isNaN(deg)) return '';
  return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

async function fetchSeaData() {
  const marineUrl = 'https://marine-api.open-meteo.com/v1/marine?' + SEA_COORD +
    '&current=wave_height,wave_direction,wave_period,sea_surface_temperature' +
    '&daily=wave_height_max&forecast_days=4&timezone=auto';
  const fcUrl = 'https://api.open-meteo.com/v1/forecast?' + SEA_COORD +
    '&current=temperature_2m,wind_speed_10m,uv_index' +
    '&daily=sunrise,sunset,uv_index_max,temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
    '&forecast_days=4&timezone=auto';
  const [mr, fr] = await Promise.all([
    fetch(marineUrl, { signal: AbortSignal.timeout(9000) }),
    fetch(fcUrl, { signal: AbortSignal.timeout(9000) })
  ]);
  if (!mr.ok || !fr.ok) throw new Error('deniz veri HTTP ' + mr.status + '/' + fr.status);
  const m = await mr.json();
  const f = await fr.json();
  const cur = m.current || {};
  const fcur = f.current || {};
  const fday = f.daily || {};
  const mday = m.daily || {};
  const days = (fday.time || []).map((date, i) => {
    const code = fday.weather_code ? fday.weather_code[i] : 3;
    return {
      date,
      waveMax: mday.wave_height_max && mday.wave_height_max[i] != null ? mday.wave_height_max[i] : null,
      sunrise: fday.sunrise && fday.sunrise[i] ? String(fday.sunrise[i]).slice(11, 16) : '',
      sunset: fday.sunset && fday.sunset[i] ? String(fday.sunset[i]).slice(11, 16) : '',
      uvMax: fday.uv_index_max && fday.uv_index_max[i] != null ? fday.uv_index_max[i] : null,
      tempMax: fday.temperature_2m_max && fday.temperature_2m_max[i] != null ? fday.temperature_2m_max[i] : null,
      tempMin: fday.temperature_2m_min && fday.temperature_2m_min[i] != null ? fday.temperature_2m_min[i] : null,
      rain: fday.precipitation_probability_max && fday.precipitation_probability_max[i] != null ? fday.precipitation_probability_max[i] : null,
      code,
      icon: wmoToIcon(code),
      desc: wmoToDesc(code)
    };
  });
  return {
    updated: new Date().toISOString(),
    waveHeight: cur.wave_height != null ? cur.wave_height : null,
    waveDirection: cur.wave_direction != null ? cur.wave_direction : null,
    waveDirText: cur.wave_direction != null ? degToCompass(cur.wave_direction) : '',
    wavePeriod: cur.wave_period != null ? cur.wave_period : null,
    seaTemp: cur.sea_surface_temperature != null ? cur.sea_surface_temperature : null,
    airTemp: fcur.temperature_2m != null ? fcur.temperature_2m : null,
    wind: fcur.wind_speed_10m != null ? fcur.wind_speed_10m : null,
    uv: fcur.uv_index != null ? fcur.uv_index : null,
    days
  };
}

// allowStale: zaten bayat veri varsa onu dondur (ana sayfa modulu).
// waitMs: bekleme suresini sinirla — sure dolarsa bayat veriye dus.
async function getSeaData(opts) {
  opts = opts || {};
  if (seaCache.data && (Date.now() - seaCache.ts) < SEA_TTL_MS) return seaCache.data;
  if (!seaCache.fetching) {
    seaCache.fetching = fetchSeaData()
      .then(d => { seaCache.data = d; seaCache.ts = Date.now(); return d; })
      .catch(e => { console.warn('[sea]', e.message); return seaCache.data; })
      .finally(() => { seaCache.fetching = null; });
  }
  const pending = seaCache.fetching;
  if (opts.allowStale && seaCache.data) {
    // arka planda tazelenmeye devam etsin, ana sayfa beklemesin
    return seaCache.data;
  }
  if (opts.waitMs) {
    let timer;
    const timeout = new Promise(r => { timer = setTimeout(() => r(seaCache.data), opts.waitMs); });
    try { return await Promise.race([pending, timeout]); } finally { clearTimeout(timer); }
  }
  return pending;
}

app.get('/etkinlikler', async (req, res) => {
  const { all } = require('./db');
  const today = fmtDateLocal(new Date());
  const rows = all("SELECT * FROM announcements WHERE status='active' AND category='etkinlik' ORDER BY created_at DESC");
  const upcoming = [], undated = [], past = [];
  rows.forEach(r => {
    const d = r.event_date || '';
    if (!d) undated.push(r);
    else if (d >= today) upcoming.push(r);
    else past.push(r);
  });
  upcoming.sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0));
  past.sort((a, b) => (a.event_date > b.event_date ? -1 : 1));
  const pastTop = past.slice(0, 20);
  await Promise.all([
    txArray(upcoming, ['title', 'content'], req.lang),
    txArray(undated, ['title', 'content'], req.lang),
    txArray(pastTop, ['title'], req.lang)
  ]);
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  const eventItems = upcoming.slice(0, 20).map((e, i) => ({
    "@type": "ListItem",
    position: i + 1,
    item: {
      "@type": "Event",
      "name": e.title,
      "startDate": e.event_date,
      "url": siteUrl + lp + '/duyuru/' + (e.slug || e.id),
      "image": e.image ? (e.image.indexOf('http') === 0 ? e.image : siteUrl + e.image) : undefined,
      "location": {
        "@type": "Place",
        "name": "Çınarcık",
        "address": { "@type": "PostalAddress", "addressLocality": "Çınarcık", "addressRegion": "Yalova", "addressCountry": "TR" }
      },
      "inLanguage": req.lang
    }
  }));
  res.render('events', {
    upcoming, undated, past: pastTop,
    pageTitle: i18n.t(req.lang, 'eventsTitle'),
    metaDescription: i18n.t(req.lang, 'eventsMetaDesc'),
    pageSchema: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
            { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'eventsTitle') }
          ]
        },
        { "@type": "ItemList", "name": i18n.t(req.lang, 'eventsTitle'), "itemListElement": eventItems }
      ]
    }
  });
});

app.get('/deniz', async (req, res) => {
  const sea = await getSeaData();
  res.render('sea', {
    sea,
    pageTitle: i18n.t(req.lang, 'seaTitle'),
    metaDescription: i18n.t(req.lang, 'seaMetaDesc')
  });
});

// Çınarcık içi ulaşım — belediye sayfasından otomatik çekilen sefer saatleri
app.get('/ulasim', (req, res) => {
  const { all } = require('./db');
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  const ferryRows = all('SELECT * FROM ferry_schedules ORDER BY id ASC').map(r => {
    let columns = [];
    try { columns = JSON.parse(r.data_json || '[]'); } catch (e) { columns = []; }
    let prices = [];
    try { prices = JSON.parse(r.prices_json || '[]'); } catch (e) { prices = []; }
    return { origin: r.origin || 'Çınarcık İskele', destination: r.destination, columns, prices, updated_at: r.updated_at };
  });
  res.render('ulasim', {
    ferryGroups: buildFerryGroups(ferryRows),
    idoTransport: getIdoTransport(),
    transport: getCityTransport(),
    pageTitle: i18n.t(req.lang, 'ulasimTitle') + ' & Turyol / İDO / Otobüs Sefer Saatleri',
    metaDescription: i18n.t(req.lang, 'ulasimMetaDesc'),
    pageSchema: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          "name": "Çınarcık İçi Ulaşım ve Otobüs Saatleri",
          "description": "Çınarcık içi minibüs, belediye otobüsü ve Turyol/İDO sefer saatleri.",
          "url": siteUrl + lp + '/ulasim'
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
            { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'ulasimTitle') }
          ]
        }
      ]
    }
  });
});

app.get('/uygulama', (req, res) => {
  res.render('uygulama', {
    pageTitle: 'Uygulamayı İndir — Marmaraİncisi',
    metaDescription: 'Marmaraİncisi uygulamasını ücretsiz indirin: Çınarcık seferleri, nöbetçi eczane, kesintiler ve haberler telefonunuzun ana ekranında.'
  });
});

app.get('/gizlilik', (req, res) => {
  res.render('privacy', {
    pageTitle: i18n.t(req.lang, 'privacyTitle'),
    metaDescription: i18n.t(req.lang, 'privacyMetaDesc')
  });
});

// Kaydettiklerim — liste tamamen istemci tarafinda localStorage'dan okunur
// (giris gerektirmez); sayfa indexlenmesin diye noindex.
app.get('/kaydettiklerim', (req, res) => {
  res.locals.robotsMeta = 'noindex, nofollow';
  res.render('saved', {
    pageTitle: i18n.t(req.lang, 'favList'),
    metaDescription: i18n.t(req.lang, 'favList')
  });
});

app.get('/duyuru/:id', async (req, res) => {
  const { get, run } = require('./db');
  const key = req.params.id;
  const announcement = get("SELECT * FROM announcements WHERE (slug = ? OR id = ?) AND status = 'active'", [key, isNaN(parseInt(key)) ? -1 : key]);
  if (!announcement || !announcement.id) return res.redirect('/duyurular');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  const canon = announcement.slug || String(announcement.id);
  if (key !== canon) return res.redirect(301, lp + '/duyuru/' + canon);
  if (!isBotRequest(req)) run("UPDATE announcements SET views_count = views_count + 1 WHERE id = ?", [announcement.id]);
  await txFields(announcement, ['title', 'content'], req.lang);
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const shortText = stripHtml(announcement.content).slice(0, 160);
  res.render('announcement-detail', {
    announcement,
    pageTitle: announcement.title,
    metaDescription: shortText || i18n.t(req.lang, 'metaDescShort'),
    ogType: announcement.category === 'etkinlik' ? 'website' : 'article',
    ogImage: announcement.image || '',
    pageSchema: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": announcement.category === 'etkinlik' ? 'Event' : 'Article',
          "headline": announcement.title,
          "description": shortText || undefined,
          "image": announcement.image ? [announcement.image] : undefined,
          "datePublished": announcement.created_at,
          "author": { "@type": "Organization", "name": "Marmara'nın İncisi", "url": siteUrl + '/' },
          "publisher": {
            "@type": "Organization",
            "name": "Marmara'nın İncisi",
            "logo": { "@type": "ImageObject", "url": siteUrl + '/img/logo-circle.png' }
          },
          "mainEntityOfPage": { "@type": "WebPage", "@id": siteUrl + lp + '/duyuru/' + (announcement.slug || announcement.id) },
          "inLanguage": req.lang
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
            { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'announcements'), "item": siteUrl + lp + '/duyurular' },
            { "@type": "ListItem", "position": 3, "name": announcement.title }
          ]
        }
      ]
    }
  });
});

app.get('/mekanlar', async (req, res) => {
  try {
    const { all } = require('./db');
    const type = req.query.type || 'all';
    let places;
    if (type === 'all') {
      places = all("SELECT * FROM places WHERE status = 'active' AND (display_until IS NULL OR display_until >= datetime('now')) ORDER BY sort_order ASC, is_featured DESC, created_at DESC");
    } else {
      places = all("SELECT * FROM places WHERE status = 'active' AND (display_until IS NULL OR display_until >= datetime('now')) AND (category = ? OR type = ?) ORDER BY sort_order ASC, is_featured DESC, created_at DESC", [type, type]);
    }
    const parseJSON = (data) => {
      if (!data) return [];
      if (typeof data === 'object') return data;
      try { return JSON.parse(data); } catch (e) { return []; }
    };
    places.forEach(function(p) {
      p.features = parseJSON(p.features);
      p.gallery_images = parseJSON(p.gallery_images);
      p.establishment_type = parseJSON(p.establishment_type);
      p.meal_type = parseJSON(p.meal_type);
    });
    await txArray(places, ['description', 'cuisine_type'], req.lang);
    const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
    const lp = req.lang === 'tr' ? '' : '/' + req.lang;
    res.render('places', {
      places, selectedType: type,
      pageTitle: i18n.t(req.lang, 'places') + ' & Restoran Rehberi',
      metaDescription: 'Çınarcık kafe, restoran, balık lokantaları, kahvaltı yerleri ve plaj kulüpleri rehberi — Marmara\'nın İncisi.',
      pageSchema: {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "CollectionPage",
            "name": "Çınarcık Mekanları ve Restoran Rehberi",
            "description": "Çınarcık restoran, kafe, bar ve eğlence mekanları rehberi.",
            "url": siteUrl + lp + '/mekanlar'
          },
          {
            "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
              { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'places') }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Mekanlar hatası:', error);
    res.status(500).send('Sunucu hatası oluştu.');
  }
});

app.get('/mekan/:id', async (req, res) => {
  try {
    const { get, all, run } = require('./db');
    const key = req.params.id;
    const place = get('SELECT * FROM places WHERE slug = ? OR id = ?', [key, isNaN(parseInt(key)) ? -1 : key]);
    if (!place || !place.id) {
      res.locals.robotsMeta = 'noindex, nofollow';
      return res.status(404).render('error', { title: 'Sayfa Bulunamadı', message: 'Aradığınız sayfa taşınmış veya kaldırılmış olabilir.', error: null });
    }
    const lp = req.lang === 'tr' ? '' : '/' + req.lang;
    const canon = place.slug || String(place.id);
    if (key !== canon) return res.redirect(301, lp + '/mekan/' + canon);
    if (!isBotRequest(req)) run("UPDATE places SET views_count = views_count + 1 WHERE id = ?", [place.id]);
    const parseJSON = (data) => {
      if (!data) return [];
      if (typeof data === 'object') return data;
      try { return JSON.parse(data); } catch (e) { return []; }
    };
    place.features = parseJSON(place.features);
    place.gallery_images = parseJSON(place.gallery_images);
    place.establishment_type = parseJSON(place.establishment_type);
    place.meal_type = parseJSON(place.meal_type);
    await Promise.all([
      txFields(place, ['description', 'working_hours', 'cuisine_type'], req.lang),
      txJsonArrayField(place, 'features', req.lang),
      txJsonArrayField(place, 'establishment_type', req.lang),
      txJsonArrayField(place, 'meal_type', req.lang)
    ]);
    const allPlaces = all('SELECT * FROM places WHERE status = "active"');
    let embedMapUrl = '';
    if (place.map_link) {
      embedMapUrl = await getMapEmbedUrl(place.map_link);
    }
    const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
    const schemaTypeMap = {
      'Restoran': 'Restaurant', 'Cafe': 'CafeOrCoffeeShop', 'Otel': 'Hotel',
      'Beach': 'BeachResort', 'Büfeler': 'FastFoodRestaurant', 'Gece Hayatı': 'BarOrPub',
      'Pansiyon': 'Motel', 'Aktivite': 'TouristAttraction'
    };
    const placeSchema = {
      "@context": "https://schema.org",
      "@type": schemaTypeMap[place.category || place.type] || 'LocalBusiness',
      "name": place.name,
      "description": (place.description || '').replace(/<[^>]*>/g, ' ').substring(0, 300),
      "image": place.main_image_url || undefined,
      "url": siteUrl + lp + '/mekan/' + (place.slug || place.id),
      "telephone": place.phone || undefined,
      "address": place.address ? {
        "@type": "PostalAddress",
        "streetAddress": place.address,
        "addressLocality": "Çınarcık",
        "addressRegion": "Yalova",
        "addressCountry": "TR"
      } : undefined,
      "geo": { "@type": "GeoCoordinates", "latitude": 40.6667, "longitude": 29.1333 },
      "areaServed": { "@type": "City", "name": "Çınarcık", "addressRegion": "Yalova", "addressCountry": "TR" },
      "priceRange": "$$"
    };
    if (place.working_hours) placeSchema.openingHours = place.working_hours;
    res.render('place-detail', {
      place, places: allPlaces, embedMapUrl,
      pageTitle: place.name,
      metaDescription: (place.description || '').replace(/<[^>]*>/g, ' ').substring(0, 155) || (place.name + ' — Çınarcık, Yalova. ' + (place.category || '')),
      ogImage: place.main_image_url || '',
      pageSchema: {
        "@context": "https://schema.org",
        "@graph": [
          placeSchema,
          {
            "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
              { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'places'), "item": siteUrl + lp + '/mekanlar' },
              { "@type": "ListItem", "position": 3, "name": place.name }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Mekan detay hatası:', error);
    res.status(500).render('place-detail', {
      place: null,
      places: [],
      embedMapUrl: '',
      pageTitle: 'Hata'
    });
  }
});

app.get('/cinarcik-hakkinda', async (req, res) => {
  const { get } = require('./db');
  const about = get('SELECT * FROM about_page WHERE id = 1');
  if (about && about.id) await txFields(about, ['banner_subtitle', 'content', 'cta_title', 'cta_text'], req.lang);
  res.render('about', { about: about && about.id ? about : null });
});

// ---- Gezilecek Yerler ----
app.get('/gezilecek-yerler', async (req, res) => {
  const { all } = require('./db');
  const items = all("SELECT * FROM sightseeing WHERE status = 'active' ORDER BY sort_order ASC, created_at DESC");
  await txArray(items, ['title', 'summary', 'description'], req.lang);
  const categories = [...new Set(items.map(i => i.category).filter(Boolean))];
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  res.render('sightseeing', {
    items, categories,
    pageTitle: i18n.t(req.lang, 'sightseeing') + ' & Doğa Rotaları Rehberi',
    metaDescription: 'Çınarcık gezilecek yerler: Hasanbaba, Erikli ve Çifte Şelaleler, Teşvikiye, Delmece Yaylası, plajlar ve piknik alanları — Marmara\'nın İncisi.',
    pageSchema: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          "name": "Çınarcık Gezilecek Yerler Rehberi",
          "description": "Çınarcık yaylaları, şelaleleri, plajları ve tarihi/turistik yerleri rehberi.",
          "url": siteUrl + lp + '/gezilecek-yerler'
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
            { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'sightseeing') }
          ]
        }
      ]
    }
  });
});

app.get('/gezilecek-yer/:id', async (req, res) => {
  const { get, all, run, parseGallery } = require('./db');
  const key = req.params.id;
  const item = get("SELECT * FROM sightseeing WHERE (slug = ? OR id = ?) AND status = 'active'", [key, isNaN(parseInt(key)) ? -1 : key]);
  if (!item || !item.id) return res.redirect('/gezilecek-yerler');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  const canon = item.slug || String(item.id);
  if (key !== canon) return res.redirect(301, lp + '/gezilecek-yer/' + canon);
  if (!isBotRequest(req)) run("UPDATE sightseeing SET views_count = views_count + 1 WHERE id = ?", [item.id]);
  item.gallery = parseGallery(item.gallery_images);
  const others = all("SELECT id, slug, title, summary, image, category, location FROM sightseeing WHERE id != ? AND status = 'active' ORDER BY sort_order ASC, created_at DESC", [item.id]);
  await Promise.all([
    txFields(item, ['title', 'summary', 'description', 'category'], req.lang),
    txArray(others, ['title', 'summary', 'category'], req.lang)
  ]);
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const embedMapUrl = await getMapEmbedUrl(item.map_link);
  res.render('sightseeing-detail', {
    item, others, embedMapUrl,
    pageTitle: item.title,
    metaDescription: (item.summary || item.description || '').replace(/<[^>]*>/g, ' ').substring(0, 155) || (item.title + ' — Çınarcık, Yalova'),
    ogImage: item.image || '',
    pageSchema: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TouristAttraction",
          "name": item.title,
          "description": (item.summary || item.description || '').replace(/<[^>]*>/g, ' ').substring(0, 300),
          "image": item.image || undefined,
          "url": siteUrl + lp + '/gezilecek-yer/' + (item.slug || item.id),
          "address": {
            "@type": "PostalAddress",
            "addressLocality": item.location || "Çınarcık",
            "addressRegion": "Yalova",
            "addressCountry": "TR"
          },
          "geo": { "@type": "GeoCoordinates", "latitude": 40.6667, "longitude": 29.1333 }
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
            { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'sightseeing'), "item": siteUrl + lp + '/gezilecek-yerler' },
            { "@type": "ListItem", "position": 3, "name": item.title }
          ]
        }
      ]
    }
  });
});

app.get('/admin/gezilecek-yerler', isAuthenticated, (req, res) => {
  res.redirect('/admin?tab=sightseeing');
});

app.get('/admin/gezilecek-yer-ekle', isAuthenticated, (req, res) => {
  const { get } = require('./db');
  const edit = req.query.edit ? get('SELECT * FROM sightseeing WHERE id = ?', [req.query.edit]) : null;
  res.render('admin/sightseeing-form', { edit: edit && edit.id ? edit : null, error: null });
});

app.post('/admin/gezilecek-yer-ekle', isAuthenticated, (req, res, next) => {
  withUpload(upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'gallery_files', maxCount: 12 }
  ]))(req, res, (err) => {
    if (err) {
      const edit = req.body && req.body.edit_id ? require('./db').get('SELECT * FROM sightseeing WHERE id = ?', [req.body.edit_id]) : null;
      return res.render('admin/sightseeing-form', { edit: edit && edit.id ? edit : null, error: err.message || 'Görsel yüklenemedi.' });
    }
    const { run, get, parseGallery, slugify, ensureUniqueSlug } = require('./db');
    const { title, summary, description, category, location, map_link, sort_order, status, edit_id, existing_gallery, remove_image } = req.body;
    if (!title || !String(title).trim()) {
      return res.render('admin/sightseeing-form', { edit: null, error: 'Başlık zorunludur' });
    }
    const titleVal = String(title).trim();
    let image = (req.files && req.files.image && req.files.image[0]) ? pubUrl(req.files.image[0]) : '';

    let gallery = [];
    if (existing_gallery) {
      try {
        const parsed = JSON.parse(existing_gallery);
        if (Array.isArray(parsed)) gallery = parsed;
      } catch (e) { gallery = []; }
    }
    const newUrls = (req.files && req.files.gallery_files && Array.isArray(req.files.gallery_files))
      ? req.files.gallery_files.map(f => pubUrl(f))
      : [];
    gallery = applyGalleryOrder(req, gallery, newUrls);

    const statusVal = status === 'passive' ? 'passive' : 'active';
    const order = parseInt(sort_order) || 999;
    const values = [
      titleVal,
      String(summary || '').trim().substring(0, 500),
      String(description || '').trim().substring(0, 8000),
      String(category || 'Genel').trim(),
      String(location || '').trim(),
      String(map_link || '').trim(),
      image,
      JSON.stringify(gallery),
      order,
      statusVal
    ];
    if (edit_id) {
      const existing = get('SELECT * FROM sightseeing WHERE id = ?', [edit_id]);
      const wantsRemove = remove_image === '1' || remove_image === 'true' || remove_image === 'on';
      if (!image) image = wantsRemove ? '' : (existing ? existing.image : '');
      values[6] = image;
      let slug = existing && existing.slug;
      if (existing && existing.title !== titleVal) {
        slug = ensureUniqueSlug(slugify(titleVal), parseInt(edit_id), 'sightseeing');
      }
      run(`UPDATE sightseeing SET title=?, slug=?, summary=?, description=?, category=?, location=?, map_link=?, image=?, gallery_images=?, sort_order=?, status=? WHERE id=?`,
        [titleVal, slug].concat(values.slice(1), [edit_id]));
      deleteReplacedMedia([existing.image], [values[6]].concat(gallery));
      deleteReplacedMedia(galleryJsonUrls(existing.gallery_images), gallery);
      pingIndexNow('/gezilecek-yer/' + (slug || edit_id));
    } else {
      const slug = ensureUniqueSlug(slugify(titleVal), null, 'sightseeing');
      run(`INSERT INTO sightseeing (title, slug, summary, description, category, location, map_link, image, gallery_images, sort_order, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [titleVal, slug].concat(values.slice(1)));
      pingIndexNow('/gezilecek-yer/' + slug);
    }
    flash(res, '/admin?tab=sightseeing', (edit_id ? 'Güncellendi: ' : 'Eklendi: ') + titleVal);
  });
});

app.post('/admin/gezilecek-yer-sil/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT title, image, gallery_images FROM sightseeing WHERE id = ?', [req.params.id]);
  if (item) deleteUploadedMedia([item.image].concat(galleryJsonUrls(item.gallery_images)));
  run('DELETE FROM sightseeing WHERE id = ?', [req.params.id]);
  flash(res, '/admin?tab=sightseeing', 'Silindi: ' + ((item && item.title) || '#' + req.params.id));
});

app.post('/admin/gezilecek-yer-toggle/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const row = get('SELECT title, status FROM sightseeing WHERE id = ?', [req.params.id]);
  const nextStatus = row && row.status === 'active' ? 'passive' : 'active';
  run('UPDATE sightseeing SET status = ? WHERE id = ?', [nextStatus, req.params.id]);
  flash(res, '/admin?tab=sightseeing',
    (row && row.title || '#' + req.params.id) + (nextStatus === 'active' ? ' yayına alındı' : ' pasife alındı'),
    nextStatus === 'active' ? 'success' : 'info');
});

// Gezilecek yer görüntülenme sıfırlama (toplu + satır bazlı)
app.post('/admin/gezilecek-yerler/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const total = get('SELECT COALESCE(SUM(views_count), 0) AS t FROM sightseeing').t || 0;
  run("UPDATE sightseeing SET views_count = 0, views_reset_at = datetime('now')");
  const daily = clearDailyViews('sightseeing', null);
  console.log(`[admin] Gezilecek yer görüntülenmeleri sıfırlandı (toplam ${total}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  flash(res, '/admin?tab=sightseeing', 'Görüntülenme sayaçları sıfırlandı (toplam ' + total + ', bugün ' + daily + ')', 'info');
});

app.post('/admin/gezilecek-yerler/:id/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT * FROM sightseeing WHERE id = ?', [req.params.id]);
  if (item && item.id) {
    const prev = Number(item.views_count) || 0;
    run("UPDATE sightseeing SET views_count = 0, views_reset_at = datetime('now') WHERE id = ?", [item.id]);
    const daily = clearDailyViews('sightseeing', [item.slug, item.id]);
    console.log(`[admin] Gezilecek yer görüntülenmesi sıfırlandı: "${item.title}" (${prev}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  }
  flash(res, '/admin?tab=sightseeing', 'Görüntülenme sıfırlandı: ' + ((item && item.title) || '#' + req.params.id), 'info');
});

// ---- İletişim (Bize Ulaşın) ----
const RECAPTCHA_SITE_KEY = (process.env.RECAPTCHA_SITE_KEY || '').trim();
const RECAPTCHA_SECRET_KEY = (process.env.RECAPTCHA_SECRET_KEY || '').trim();
let googleRecaptchaKeyValid = false;

function getActiveRecaptchaSiteKey() {
  return googleRecaptchaKeyValid ? RECAPTCHA_SITE_KEY : '';
}

// Sunucu açılışında Google reCAPTCHA site anahtarının gerçekten aktif/geçerli olup olmadığını kontrol et.
// Anahtar Google tarafında silinmişse ("ErrorMain" / "Invalid site key") veya test uyarısı veriyorsa,
// ziyaretçiye bozuk iframe göstermek yerine yerleşik imzalı "Ben robot değilim" reCAPTCHA bileşeni devreye girer.
(async function checkGoogleRecaptchaKey() {
  if (!RECAPTCHA_SITE_KEY || !RECAPTCHA_SECRET_KEY) return;
  try {
    const apiRes = await fetch('https://www.google.com/recaptcha/api.js');
    const apiJs = await apiRes.text();
    const m = apiJs.match(/releases\/([^\/]+)\//);
    const v = m ? m[1] : '';
    const siteOrigin = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '') + ':443';
    const co = Buffer.from(siteOrigin).toString('base64').replace(/=+$/, '.');
    const anchorUrl = 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=' + encodeURIComponent(RECAPTCHA_SITE_KEY) + '&co=' + encodeURIComponent(co) + '&hl=tr&v=' + encodeURIComponent(v) + '&size=normal';
    const anchorRes = await fetch(anchorUrl);
    const html = await anchorRes.text();
    if (!html.includes('ErrorMain') && !html.includes('rc-anchor-alert')) {
      googleRecaptchaKeyValid = true;
      console.log('[recaptcha] Google reCAPTCHA v2 anahtari dogrulandi ve aktif.');
    } else {
      googleRecaptchaKeyValid = false;
      console.log('[recaptcha] .env RECAPTCHA_SITE_KEY Google tarafinda gecersiz/test modunda; yerlesik "Ben robot degilim" dogrulamasi aktif.');
    }
  } catch (e) {
    googleRecaptchaKeyValid = false;
  }
})();

const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCaptchaCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)];
  return code;
}

function captchaSvg(code) {
  const colors = ['#34d399', '#60a5fa', '#f472b6', '#facc15', '#a78bfa', '#f87171'];
  const W = 170, H = 54;
  let glyphs = '';
  const step = (W - 40) / code.length;
  for (let i = 0; i < code.length; i++) {
    const x = 22 + step * i + (Math.random() * 8 - 4);
    const y = 26 + (Math.random() * 8 - 4);
    const rot = Math.round(Math.random() * 44 - 22);
    const size = 24 + Math.round(Math.random() * 8);
    const color = colors[Math.floor(Math.random() * colors.length)];
    glyphs += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Verdana, Geneva, sans-serif" font-size="${size}" font-weight="bold" fill="${color}" text-anchor="middle" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})">${code[i]}</text>`;
  }
  let noise = '';
  for (let i = 0; i < 5; i++) {
    const x1 = Math.random() * W, y1 = Math.random() * H;
    const x2 = Math.random() * W, y2 = Math.random() * H;
    noise += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
  }
  for (let i = 0; i < 14; i++) {
    noise += `<circle cx="${(Math.random() * W).toFixed(1)}" cy="${(Math.random() * H).toFixed(1)}" r="${(Math.random() * 1.8 + 0.6).toFixed(1)}" fill="rgba(255,255,255,0.14)"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" rx="8" fill="#09090b"/>` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="7.5" fill="none" stroke="#27272a"/>` +
    noise + glyphs + `</svg>`;
}

async function verifyRecaptcha(token) {
  if (!RECAPTCHA_SECRET_KEY) return { ok: true };
  if (!token) return { ok: false, error: '"Ben robot değilim" kutusunu onaylamanız gerekiyor.' };
  try {
    const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'secret=' + encodeURIComponent(RECAPTCHA_SECRET_KEY) + '&response=' + encodeURIComponent(token)
    });
    const data = await resp.json();
    if (!data.success) console.error('[recaptcha] başarısız:', JSON.stringify(data['error-codes'] || data));
    return data.success ? { ok: true } : { ok: false, error: 'Doğrulama başarısız oldu, lütfen tekrar deneyin.' };
  } catch (e) {
    return { ok: false, error: 'Doğrulama servisine ulaşılamadı, lütfen birazdan tekrar deneyin.' };
  }
}

function rcTokenSecret() {
  return process.env.SESSION_SECRET || 'cinarcik-portal-secret-key-2024';
}

function issueSignedRcToken(req) {
  const ts = Date.now();
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = 'rc1.' + ts + '.' + nonce;
  const sig = crypto.createHmac('sha256', rcTokenSecret()).update(payload).digest('base64url');
  if (req && req.session) {
    const list = Array.isArray(req.session.rcTokens) ? req.session.rcTokens : [];
    list.push({ nonce, at: ts });
    req.session.rcTokens = list.slice(-8);
  }
  return payload + '.' + sig;
}

function verifySignedRcToken(req, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'rc1') return false;
  const ts = Number(parts[1]);
  const nonce = parts[2];
  const sig = parts[3];
  const now = Date.now();
  if (!ts || now - ts > 15 * 60 * 1000 || ts > now + 10000) return false;
  const expected = crypto.createHmac('sha256', rcTokenSecret()).update('rc1.' + parts[1] + '.' + nonce).digest('base64url');
  if (sig !== expected) return false;
  if (req && req.session && Array.isArray(req.session.rcTokens)) {
    const idx = req.session.rcTokens.findIndex(x => x && x.nonce === nonce);
    if (idx === -1) return false;
    req.session.rcTokens.splice(idx, 1);
  }
  return true;
}

app.post('/api/recaptcha-challenge', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  if (!ua || isBotRequest(req)) {
    return res.status(403).json({ success: false, error: 'Doğrulama başarısız' });
  }
  const source = req.headers.origin || req.headers.referer || '';
  if (source) {
    try {
      const u = new URL(source);
      if (u.host !== req.get('host')) {
        return res.status(403).json({ success: false, error: 'Geçersiz kaynak' });
      }
    } catch (e) {
      return res.status(403).json({ success: false, error: 'Geçersiz kaynak' });
    }
  }
  const token = issueSignedRcToken(req);
  res.json({ success: true, token });
});

async function verifyUserCaptcha(req) {
  const body = req.body || {};
  let rawToken = body['g-recaptcha-response'] || body.recaptchaToken || '';
  if (Array.isArray(rawToken)) {
    rawToken = rawToken.filter(Boolean).pop() || '';
  }
  rawToken = String(rawToken || '').trim();
  const legacyCode = String(body.captcha || '').trim().toUpperCase();

  if (rawToken.startsWith('rc1.')) {
    if (verifySignedRcToken(req, rawToken)) return { ok: true };
    return { ok: false, error: 'Robot doğrulaması süresi doldu, lütfen kutucuğu tekrar işaretleyin.' };
  }
  if (rawToken && googleRecaptchaKeyValid) {
    return await verifyRecaptcha(rawToken);
  }
  if (legacyCode && captchaOk(req, legacyCode)) {
    if (req.session) req.session.captchaCodes = [];
    return { ok: true };
  }
  return {
    ok: false,
    error: i18n.t(req.lang || 'tr', 'notRobotHint') || 'Lütfen "Ben robot değilim" kutusunu işaretleyin.'
  };
}

async function contactView(sent, error, form) {
  return {
    sent, error, form,
    recaptchaSiteKey: getActiveRecaptchaSiteKey(),
    recaptchaInvisible: false,
    captchaTs: Date.now()
  };
}

// ---- Güvenlik kodu: son 3 kod saklanır, 10 dk içindeki herhangi biri kabul edilir ----
function svgDataUri(code) {
  return 'data:image/svg+xml;base64,' + Buffer.from(captchaSvg(code)).toString('base64');
}

function issueCaptcha(req) {
  const code = newCaptchaCode();
  const list = Array.isArray(req.session.captchaCodes) ? req.session.captchaCodes : [];
  list.push({ code: code, at: Date.now() });
  req.session.captchaCodes = list.slice(-3);
  return code;
}

function latestCaptcha(req) {
  const list = Array.isArray(req.session.captchaCodes) ? req.session.captchaCodes : [];
  return list.length ? list[list.length - 1].code : null;
}

function captchaOk(req, entered) {
  const list = Array.isArray(req.session.captchaCodes) ? req.session.captchaCodes : [];
  const now = Date.now();
  return list.some(function (x) { return x.code === entered && now - x.at <= 10 * 60 * 1000; });
}

async function renderContact(req, res, opts) {
  const o = opts || {};
  const code = issueCaptcha(req);
  const view = await contactView(!!o.sent, o.error || null, o.form || {});
  view.captchaImage = svgDataUri(code);
  if (o.status) res.status(o.status);
  return res.render('contact', view);
}

app.get('/captcha.svg', (req, res) => {
  const code = issueCaptcha(req);
  res.set('Content-Type', 'image/svg+xml; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.send(captchaSvg(code));
});

app.get('/iletisim', async (req, res) => {
  await renderContact(req, res, { sent: req.query.sent === '1' });
});

app.post('/iletisim', contactLimiter, async (req, res) => {
  const { run } = require('./db');
  const gUser = (req.session.isGoogleAuth && req.session.googleUser && req.session.googleUser.email)
    ? req.session.googleUser : null;
  const name = String(req.body.name || '').trim() || (gUser ? gUser.name : '');
  // Gmail ile giriş yapıldıysa e-posta sunucu tarafında da kilitlenir (body'deki değer yok sayılır)
  const email = gUser ? gUser.email : String(req.body.email || '').trim();
  const subject = String(req.body.subject || '').trim();
  const message = String(req.body.message || '').trim();
  const captcha = String(req.body.captcha || '').trim().toUpperCase();
  const form = { name, email, subject, message };

  if (!name || !email || !message) {
    return renderContact(req, res, { status: 400, error: 'Lütfen ad, e-posta ve mesaj alanlarını doldurun.', form: form });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return renderContact(req, res, { status: 400, error: 'Geçerli bir e-posta adresi girin.', form: form });
  }
  if (message.length > 2000) {
    return renderContact(req, res, { status: 400, error: 'Mesaj en fazla 2000 karakter olabilir.', form: form });
  }

  const rcCheck = await verifyUserCaptcha(req);
  if (!rcCheck.ok) {
    return renderContact(req, res, {
      status: 400,
      error: rcCheck.error,
      form: form
    });
  }

  run('INSERT INTO contact_messages (name, email, subject, message) VALUES (?,?,?,?)',
    [name, email, subject, message]);
  req.session.captchaCodes = [];
  // Yöneticiye anında bildirim (sayfayı bekletmeden, fire-and-forget)
  sendPortalMail({
    to: process.env.ADMIN_2FA_EMAIL || 'kerimkaplan@yahoo.com',
    subject: '📧 Yeni iletişim mesajı: ' + (subject || '(konu yok)'),
    text: 'Ad: ' + name + '\nE-posta: ' + email + '\nKonu: ' + (subject || '-') + '\n\nMesaj:\n' + message,
    replyTo: email,
    logTag: 'iletisim'
  }).catch(e => console.error('[iletisim] bildirim maili gönderilemedi:', e.message));
  res.redirect('/iletisim?sent=1');
});

app.get('/admin/login', (req, res) => {
  if (req.session.isAdmin || verifyAdminToken(getCookie(req, ADMIN_REMEMBER_COOKIE))) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', loginRateLimit, async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { get } = require('./db');
  const { username, password } = req.body;
  const user = get('SELECT * FROM users WHERE username = ?', [username]);
  if (user && user.password && await bcrypt.compare(password, user.password)) {
    // 2FA: şifre doğru, şimdi e-posta doğrulama kodu gerekir
    const code = String(Math.floor(100000 + Math.random() * 900000));
    req.session.pendingAdmin = true;
    req.session.otp = code;
    req.session.otpExpires = Date.now() + 10 * 60 * 1000;
    req.session.otpAttempts = 0;
    try {
      await sendAdmin2FACode(code);
    } catch (e) {
      console.error('[2fa] mail gönderilemedi:', e.message, '| kod:', code);
    }
    return res.render('admin/login', { error: null, otpStep: true, otpSentTo: process.env.ADMIN_2FA_EMAIL || 'kerimkaplan@yahoo.com' });
  }
  res.render('admin/login', { error: 'Kullanıcı adı veya şifre hatalı' });
});

app.post('/admin/verify-otp', async (req, res) => {
  if (!req.session.pendingAdmin || !req.session.otp) return res.redirect('/admin/login');
  if (Date.now() > (req.session.otpExpires || 0)) {
    req.session.pendingAdmin = false;
    return res.render('admin/login', { error: 'Doğrulama kodunun süresi doldu. Tekrar giriş yapın.' });
  }
  req.session.otpAttempts = (req.session.otpAttempts || 0) + 1;
  if (req.session.otpAttempts > 5) {
    req.session.pendingAdmin = false;
    req.session.otp = null;
    return res.render('admin/login', { error: 'Çok fazla hatalı deneme. Tekrar giriş yapın.' });
  }
  if (String(req.body.code || '').trim() === req.session.otp) {
    return req.session.regenerate((err) => {
      if (err) return res.redirect('/admin/login');
      req.session.isAdmin = true;
      setAdminRememberCookie(res);
      loginAttempts.delete(req.ip);
      flash(res, '/admin', 'Giriş başarılı, hoş geldiniz');
    });
  }
  res.render('admin/login', { error: 'Doğrulama kodu hatalı.', otpStep: true, otpSentTo: process.env.ADMIN_2FA_EMAIL || 'kerimkaplan@yahoo.com' });
});

app.get('/admin/logout', (req, res) => {
  clearAdminRememberCookie(res);
  req.session.destroy();
  res.redirect('/');
});

// Bugünkü içerik trafiği: page_views logundan slug bazında günlük sayı türetilir
// (ek sayaç kolonu gerekmez). Dil prefix'li (/en/haber/..) ve API yolları da kapsanır.
// "Gün" = Türkiye saati (UTC+3, yaz saati yok) 00:00–24:00. created_at UTC
// yazıldığı için aralık TRT'ye çevrilerek verilir.
const TRT_OFFSET_MS = 3 * 3600 * 1000;

function trtDayRange(nowMs = Date.now()) {
  const t = new Date(nowMs + TRT_OFFSET_MS); // UTC alanları artık TRT takvimini verir
  const start = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - TRT_OFFSET_MS;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return [iso(start), iso(start + 24 * 3600 * 1000)];
}

const DAILY_VIEW_TYPES = ['news', 'announcements', 'places', 'sightseeing', 'companies', 'photos'];
const DAILY_VIEW_PATTERNS = [
  ['news', /\/(?:[a-z]{2}\/)?haber\/([^\/]+)$/],
  ['news', /\/api\/news\/([^\/]+)$/],
  ['announcements', /\/(?:[a-z]{2}\/)?duyuru\/([^\/]+)$/],
  ['places', /\/(?:[a-z]{2}\/)?mekan\/([^\/]+)$/],
  ['sightseeing', /\/(?:[a-z]{2}\/)?gezilecek-yer\/([^\/]+)$/],
  ['companies', /\/(?:[a-z]{2}\/)?rehber\/([^\/]+)$/],
  ['photos', /\/(?:[a-z]{2}\/)?api\/foto-gor\/([^\/]+)$/]
];

function dailyViewsToday() {
  const { all } = require('./db');
  const [start, end] = trtDayRange();
  const rows = all(`SELECT path, COUNT(*) AS c FROM page_views
    WHERE created_at >= ? AND created_at < ?
    GROUP BY path`, [start, end]);
  const out = {};
  for (const t of DAILY_VIEW_TYPES) out[t] = { byKey: {}, total: 0 };
  for (const r of rows) {
    const p = String(r.path || '');
    for (const [type, re] of DAILY_VIEW_PATTERNS) {
      const m = p.match(re);
      if (!m) continue;
      let key;
      try { key = decodeURIComponent(m[1]); } catch (e) { key = m[1]; }
      const c = Number(r.c) || 0;
      out[type].byKey[key] = (out[type].byKey[key] || 0) + c;
      out[type].total += c;
    }
  }
  return out;
}

function withViewsToday(rows, daily) {
  return rows.map(r => Object.assign({}, r, {
    // Eski id'li URL'lerden (301 taramalari) gelen goruntulenmeler de slug satirina yazilsin
    views_today: (daily.byKey[String(r.slug || r.id)] || 0) + (r.slug ? (daily.byKey[String(r.id)] || 0) : 0)
  }));
}

// Basliklar satir toplamiyla hesaplanir: silinmis/gesik path key'leri yuzunden
// baslik satir toplamindan buyuk gorunmesin.
function sumViewsToday(rows) {
  return rows.reduce((s, r) => s + (Number(r.views_today) || 0), 0);
}

// Gunluk ("Bugun") sayaclari sifirlama: bugunku (TRT) page_views satirlarini siler.
// keys = null ise tipin tum gunluk satirlari, yoksa sadece verilen slug/id anahtarlarinin satirlari.
function clearDailyViews(type, keys) {
  const { all, run } = require('./db');
  const pat = DAILY_VIEW_PATTERNS.find(p => p[0] === type);
  if (!pat) return 0;
  const [start, end] = trtDayRange();
  const rows = all('SELECT id, path FROM page_views WHERE created_at >= ? AND created_at < ?', [start, end]);
  const want = keys ? new Set(keys.map(String)) : null;
  let n = 0;
  for (const r of rows) {
    const m = String(r.path || '').match(pat[1]);
    if (!m) continue;
    let k; try { k = decodeURIComponent(m[1]); } catch (e) { k = m[1]; }
    if (want && !want.has(String(k))) continue;
    run('DELETE FROM page_views WHERE id = ?', [r.id]);
    n++;
  }
  return n;
}

app.get('/admin', isAuthenticated, async (req, res) => {
  const { all, get } = require('./db');
  const daily = dailyViewsToday();
  const announcements = withViewsToday(all("SELECT * FROM announcements ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, sort_order ASC, created_at DESC"), daily.announcements);
  const places = withViewsToday(all('SELECT * FROM places ORDER BY sort_order ASC, is_featured DESC, created_at DESC'), daily.places);
  const news = withViewsToday(all("SELECT * FROM news ORDER BY sort_order ASC, created_at DESC"), daily.news);
  const newsCount = get('SELECT COUNT(*) as cnt FROM news');
  const companies = withViewsToday(all('SELECT * FROM companies ORDER BY sort_order ASC, created_at DESC'), daily.companies);
  const sightseeing = withViewsToday(all('SELECT * FROM sightseeing ORDER BY sort_order ASC, created_at DESC'), daily.sightseeing);
  const pendingComments = get("SELECT COUNT(*) as cnt FROM comments WHERE status = 'pending'");
  const totalComments = get('SELECT COUNT(*) as cnt FROM comments');
  const unreadMessages = get("SELECT COUNT(*) as cnt FROM contact_messages WHERE status = 'new'");
  const sightseeingCount = get('SELECT COUNT(*) as cnt FROM sightseeing');
  const pendingPhotos = get("SELECT COUNT(*) as cnt FROM photo_submissions WHERE status = 'pending'");
  const totalPhotos = get('SELECT COUNT(*) as cnt FROM photo_submissions');
  const pollActive = get("SELECT p.id, p.question, COALESCE((SELECT COUNT(*) FROM poll_votes v WHERE v.poll_id = p.id), 0) AS votes FROM polls p WHERE p.status = 'active' ORDER BY p.created_at DESC LIMIT 1");
  const pollTotalVotesAll = get('SELECT COUNT(*) as cnt FROM poll_votes');
  const pollCountAll = get('SELECT COUNT(*) as cnt FROM polls');
  res.render('admin/dashboard', {
    announcements, places, news, sightseeing,
    newsCount: (newsCount && newsCount.cnt) ? newsCount.cnt : 0,
    newsTodayViews: sumViewsToday(news),
    announcementsTodayViews: sumViewsToday(announcements),
    placesTodayViews: sumViewsToday(places),
    companiesTodayViews: sumViewsToday(companies),
    sightseeingTodayViews: sumViewsToday(sightseeing),
    companies,
    pendingCommentsCount: (pendingComments && pendingComments.cnt) ? pendingComments.cnt : 0,
    totalCommentsCount: (totalComments && totalComments.cnt) ? totalComments.cnt : 0,
    unreadMessagesCount: (unreadMessages && unreadMessages.cnt) ? unreadMessages.cnt : 0,
    sightseeingCount: (sightseeingCount && sightseeingCount.cnt) ? sightseeingCount.cnt : 0,
    pendingPhotosCount: (pendingPhotos && pendingPhotos.cnt) ? pendingPhotos.cnt : 0,
    totalPhotosCount: (totalPhotos && totalPhotos.cnt) ? totalPhotos.cnt : 0,
    pollActiveQuestion: (pollActive && pollActive.id) ? String(pollActive.question || '') : '',
    pollTotalVotes: (pollTotalVotesAll && pollTotalVotesAll.cnt) ? pollTotalVotesAll.cnt : 0,
    pollCount: (pollCountAll && pollCountAll.cnt) ? pollCountAll.cnt : 0
  });
});

app.get('/admin/haberler', isAuthenticated, (req, res) => {
  const { all } = require('./db');
  const dailyViews = dailyViewsToday();
  const news = withViewsToday(all('SELECT * FROM news ORDER BY sort_order ASC, created_at DESC'), dailyViews.news);
  res.render('admin/news-list', { news, todayViews: sumViewsToday(news) });
});

// ---- Admin sıralama (▲/▼ taşıma) ----
// Her liste satırındaki yönlendirme butonları bu rotaya POST eder.
// Taşıma sonrası listedeki tüm kayıtlar 1..n olarak yeniden numaralanır;
// böylece eski kayıtlardaki eşit sort_order değerleri de çözülür.
const REORDERABLE = {
  news: {
    orderBy: 'sort_order ASC, created_at DESC',
    back: '/admin/haberler'
  },
  announcements: {
    orderBy: "CASE WHEN status = 'pending' THEN 0 ELSE 1 END, sort_order ASC, created_at DESC",
    back: '/admin?tab=announcements'
  },
  places: {
    orderBy: 'sort_order ASC, is_featured DESC, created_at DESC',
    back: '/admin?tab=places'
  },
  companies: {
    orderBy: 'sort_order ASC, created_at DESC',
    back: '/admin?tab=companies'
  },
  sightseeing: {
    orderBy: 'sort_order ASC, created_at DESC',
    back: '/admin?tab=sightseeing'
  }
};

app.post('/admin/sirala', isAuthenticated, (req, res) => {
  const { all, run } = require('./db');
  const { tablo, id, yon } = req.body;
  const conf = REORDERABLE[tablo];
  let back = (conf && conf.back) || '/admin';
  try {
    const ref = new URL(req.get('Referer') || '', 'http://localhost');
    if (ref.host === req.get('host')) back = ref.pathname + ref.search;
  } catch (e) {}
  if (!conf || (yon !== 'yukari' && yon !== 'asagi')) return res.redirect(back);
  const rowId = parseInt(id, 10);
  if (!rowId) return res.redirect(back);
  const items = all(`SELECT id FROM ${tablo} ORDER BY ${conf.orderBy}`);
  const idx = items.findIndex(i => i.id === rowId);
  if (idx < 0) return res.redirect(back);
  const swap = yon === 'yukari' ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= items.length) return res.redirect(back);
  const ids = items.map(i => i.id);
  const tmp = ids[idx];
  ids[idx] = ids[swap];
  ids[swap] = tmp;
  ids.forEach((newId, pos) => {
    run(`UPDATE ${tablo} SET sort_order = ? WHERE id = ?`, [pos + 1, newId]);
  });
  res.redirect(back);
});

app.post('/admin/haberler/toggle/:id', isAuthenticated, (req, res) => {
  const { get, run } = require('./db');
  const item = get('SELECT * FROM news WHERE id = ?', [req.params.id]);
  let next = 'active';
  if (item && item.id) {
    next = item.status === 'active' ? 'passive' : 'active';
    run("UPDATE news SET status = ?, updated_at = datetime('now') WHERE id = ?", [next, item.id]);
  }
  flash(res, '/admin/haberler',
    ((item && item.title) || '#' + req.params.id) + (next === 'active' ? ' yayına alındı' : ' pasife alındı'),
    next === 'active' ? 'success' : 'info');
});

app.post('/admin/haberler/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const total = get('SELECT COALESCE(SUM(views_count), 0) AS t FROM news').t || 0;
  run("UPDATE news SET views_count = 0, views_reset_at = datetime('now'), updated_at = datetime('now')");
  const daily = clearDailyViews('news', null);
  console.log(`[admin] Görüntelenme sayıları sıfırlandı (toplam ${total}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  flash(res, '/admin/haberler', 'Görüntülenme sayaçları sıfırlandı (toplam ' + total + ', bugün ' + daily + ')', 'info');
});

app.post('/admin/haberler/:id/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT * FROM news WHERE id = ?', [req.params.id]);
  if (item && item.id) {
    const prev = Number(item.views_count) || 0;
    run("UPDATE news SET views_count = 0, views_reset_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [item.id]);
    const daily = clearDailyViews('news', [item.slug, item.id]);
    console.log(`[admin] Haber görüntülenmesi sıfırlandı: "${item.title}" (${prev}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  }
  let back = '/admin/haberler';
  try {
    const ref = new URL(req.get('Referer') || '', 'http://localhost');
    if (ref.host === req.get('host')) back = ref.pathname + ref.search;
  } catch (e) {}
  flash(res, back, 'Görüntülenme sıfırlandı: ' + ((item && item.title) || '#' + req.params.id), 'info');
});

app.get('/admin/haber-ekle', isAuthenticated, (req, res) => {
  const { get } = require('./db');
  const edit = req.query.edit ? get('SELECT * FROM news WHERE id = ?', [req.query.edit]) : null;
  res.render('admin/news-form', { edit, error: null });
});

app.post('/admin/haber-ekle', isAuthenticated, function(req, res, next) {
  withUpload(upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'gallery_files', maxCount: 10 }
  ]))(req, res, function(err) {
    if (err) {
      const edit = req.body && req.body.edit_id ? require('./db').get('SELECT * FROM news WHERE id = ?', [req.body.edit_id]) : null;
      return res.render('admin/news-form', { edit, error: 'Görsel yüklenemedi.' });
    }
    next();
  });
}, (req, res) => {
  const { run, get, slugify, ensureUniqueSlug } = require('./db');
  const { title, badge_text, summary, content, category, headline_order, is_headline, status, expires_at, edit_id } = req.body;
  let main_image_url = (req.files && req.files.image && req.files.image[0]) ? pubUrl(req.files.image[0]) : '';

  let galleryArr = [];
  if (req.body.existing_gallery) {
    let existingRaw = req.body.existing_gallery;
    if (typeof existingRaw === 'string') {
      try {
        const parsed = JSON.parse(existingRaw);
        if (Array.isArray(parsed)) galleryArr = parsed;
        else galleryArr = [existingRaw];
      } catch (e) {
        galleryArr = [existingRaw];
      }
    } else if (Array.isArray(existingRaw)) {
      galleryArr = existingRaw.slice();
    }
  }
  const newUrls = (req.files && req.files.gallery_files && Array.isArray(req.files.gallery_files))
    ? req.files.gallery_files.map(f => pubUrl(f))
    : [];
  galleryArr = applyGalleryOrder(req, galleryArr, newUrls);

  if (!title || !content) {
    const edit = edit_id ? get('SELECT * FROM news WHERE id = ?', [edit_id]) : null;
    return res.render('admin/news-form', { edit, error: 'Başlık ve içerik zorunludur' });
  }

  const expiresValue = (expires_at && expires_at.trim()) ? expires_at.trim().replace('T', ' ').replace(/:\d{2}$/, ':00') : null;
  const isHeadline = (is_headline === 'on' || is_headline === '1' || is_headline === 'true') ? 1 : 0;
  // Admin'de kaydedilen haber, süresi dolmamışsa otomatik yayına alınır.
  // Formda "Pasif" seçilmiş olsa bile düzenleme yapıldığı için yayınlanır.
  const requestedPassive = status === 'passive';
  const statusVal = (requestedPassive && !expiresValue) ? 'passive' : 'active';
  const order = parseInt(headline_order) || 999;

  if (edit_id) {
    const existing = get('SELECT * FROM news WHERE id = ?', [edit_id]);
    if (existing && !main_image_url) main_image_url = existing.main_image_url || '';
    let slug = existing.slug;
    if (existing.title !== title) {
      slug = ensureUniqueSlug(slugify(title), parseInt(edit_id));
    }
    run(`UPDATE news SET title=?, slug=?, badge_text=?, summary=?, content=?, main_image_url=?, gallery_images=?, is_headline=?, headline_order=?, status=?, expires_at=?, category=?, updated_at=datetime('now') WHERE id=?`,
      [title, slug, badge_text || '', summary || '', content, main_image_url, JSON.stringify(galleryArr), isHeadline, order, statusVal, expiresValue, category || 'Gündem', edit_id]);
    deleteReplacedMedia([existing.main_image_url], [main_image_url].concat(galleryArr));
    deleteReplacedMedia(galleryJsonUrls(existing.gallery_images), galleryArr);
    pingIndexNow('/haber/' + slug);
  } else {
    const slug = ensureUniqueSlug(slugify(title), null);
    run(`INSERT INTO news (title, slug, badge_text, summary, content, main_image_url, gallery_images, is_headline, headline_order, status, expires_at, category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [title, slug, badge_text || '', summary || '', content, main_image_url, JSON.stringify(galleryArr), isHeadline, order, statusVal, expiresValue, category || 'Gündem']);
    pingIndexNow('/haber/' + slug);
  }
  flash(res, '/admin/haberler', (edit_id ? 'Güncellendi: ' : 'Eklendi: ') + title);
});

app.post('/admin/haber-sil/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT title, main_image_url, gallery_images FROM news WHERE id = ?', [req.params.id]);
  if (item) deleteUploadedMedia([item.main_image_url].concat(galleryJsonUrls(item.gallery_images)));
  run('DELETE FROM news WHERE id = ?', [req.params.id]);
  flash(res, '/admin/haberler', 'Silindi: ' + ((item && item.title) || '#' + req.params.id));
});

const multer = require('multer');
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'public', 'img', 'uploads'),
  filename: (req, file, cb) => {
    // Dosya adını tamamen ASCII'ye indir: boşluk ve Türkçe karakterler
    // URL'de bozulup 404'e yol açıyordu.
    const ext = (path.extname(file.originalname || '') || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
    const base = path.basename(file.originalname || 'image', path.extname(file.originalname || ''))
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 60) || 'image';
    cb(null, Date.now() + '-' + base + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') && file.mimetype !== 'image/svg+xml') return cb(null, true);
    cb(new Error('Sadece JPG, PNG, WebP veya GIF görsel yükleyebilirsiniz.'));
  }
});

// ---- Cloudflare R2 (kalıcı görsel deposu; servis kendi domain'imizden /uploads üzerinden) ----
const { AwsClient } = require('aws4fetch');
const R2 = (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET)
  ? {
      account: process.env.R2_ACCOUNT_ID,
      bucket: process.env.R2_BUCKET,
      publicBase: String(process.env.R2_PUBLIC_URL).replace(/\/+$/, ''),
      client: new AwsClient({
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        region: 'auto',
        service: 's3'
      })
    }
  : null;
if (R2) console.log('\x1b[32m✓ R2 görsel deposu aktif (servis: /uploads/*)\x1b[0m');
else console.log('\x1b[33m⚠ R2 yapılandırması yok — görseller yerel diske yazılacak.\x1b[0m');

function pubUrl(file) {
  if (!file) return '';
  if (file.r2Url) return '/uploads/' + path.basename(file.r2Url);
  return '/img/uploads/' + encodeURIComponent(file.filename);
}

// Yüklenmiş medya dosyalarını local diskten ve (R2 aktifse) R2'den siler.
// Sadece kendi yüklemelerimiz (/uploads/*, /img/uploads/*) silinir; dış URL'lere dokunulmaz.
function galleryJsonUrls(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function deleteUploadedMedia(input) {
  const list = Array.isArray(input) ? input : [input];
  const seen = {};
  list.forEach(function(raw) {
    const url = String(raw || '').trim();
    if (!url || seen[url]) return;
    seen[url] = 1;
    if (url.indexOf('/uploads/') !== 0 && url.indexOf('/img/uploads/') !== 0) return;
    const name = path.basename(url.split('?')[0]);
    if (!name || name === '.' || name === '..') return;
    try {
      const fsx = require('fs');
      const localPath = path.join(__dirname, 'public', 'img', 'uploads', name);
      if (fsx.existsSync(localPath)) fsx.unlinkSync(localPath);
    } catch (e) {
      console.warn('[media] local silinemedi (' + name + '):', e.message);
    }
    if (R2) {
      R2.client.fetch('https://' + R2.account + '.r2.cloudflarestorage.com/' + R2.bucket + '/uploads/' + name, { method: 'DELETE' })
        .then(function(r) {
          if (r.ok || r.status === 204) console.log('[r2] silindi: uploads/' + name);
          else console.warn('[r2] silme yanıtı ' + r.status + ': ' + name);
        })
        .catch(function(e) { console.warn('[r2] silinemedi (' + name + '):', e.message); });
    }
  });
}

// Düzenlemede değişen/değiştirilen medyayı siler: eski listede olup "keep" Listesinde
// araçmayan öğeleri deleteUploadedMedia ile sıralar (aynı URL kalmışsa dokunulmaz).
function deleteReplacedMedia(oldItems, keepItems) {
  const keep = new Set((Array.isArray(keepItems) ? keepItems : [keepItems]).filter(Boolean).map(String));
  const old = (Array.isArray(oldItems) ? oldItems : [oldItems]).filter(Boolean).map(String);
  deleteUploadedMedia(old.filter(function(u) { return !keep.has(u); }));
}

// Formdaki sürükle-bırak sıralaması `gallery_order` alanına JSON olarak yazılır:
// [["e", mevcutUrl], ["n", yeniDosyaIndeksi], ...]
// Alan yoksa (eski istemci / JS kapalı) davranış değişmez: mevcutlar önce, yeniler sonra.
function applyGalleryOrder(req, existingArr, newUrls) {
  const existing = Array.isArray(existingArr) ? existingArr : [];
  const fresh = Array.isArray(newUrls) ? newUrls : [];
  const base = existing.concat(fresh);
  const raw = req.body ? req.body.gallery_order : '';
  if (!raw) return base;
  let order;
  try { order = JSON.parse(raw); } catch (e) { return base; }
  if (!Array.isArray(order) || !order.length) return base;

  const out = [];
  const remain = {};
  existing.forEach(function(u) { remain[u] = (remain[u] || 0) + 1; });
  const usedNew = {};
  order.forEach(function(it) {
    if (!Array.isArray(it) || it.length < 2) return;
    if (it[0] === 'e') {
      const url = String(it[1]);
      if (remain[url] > 0) { remain[url]--; out.push(url); }
    } else if (it[0] === 'n') {
      const i = parseInt(it[1], 10);
      if (!isNaN(i) && fresh[i] !== undefined && !usedNew[i]) {
        usedNew[i] = 1;
        out.push(fresh[i]);
      }
    }
  });
  // Güvenlik ağı: sırada kalmayan mevcut görseller ve yeni yüklenenler sona eklenir.
  Object.keys(remain).forEach(function(u) {
    while (remain[u] > 0) { out.push(u); remain[u]--; }
  });
  fresh.forEach(function(u, i) { if (!usedNew[i]) out.push(u); });
  return out;
}

function finishUploads(req, res, done) {
  const files = [];
  if (req.file) files.push(req.file);
  if (req.files) {
    if (Array.isArray(req.files)) files.push.apply(files, req.files);
    else Object.keys(req.files).forEach(function(k) {
      const v = req.files[k];
      if (Array.isArray(v)) files.push.apply(files, v);
    });
  }
  if (!R2 || !files.length) return done();
  let pending = files.length;
  const step = function() { if (--pending === 0) done(); };
  files.forEach(function(file) {
    const key = 'uploads/' + file.filename;
    let body = null;
    try { body = require('fs').readFileSync(file.path); } catch (e) {}
    if (!body) return step();
    R2.client.fetch('https://' + R2.account + '.r2.cloudflarestorage.com/' + R2.bucket + '/' + key, {
      method: 'PUT',
      body: body,
      headers: { 'Content-Type': file.mimetype || 'application/octet-stream' }
    }).then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      file.r2Url = R2.publicBase + '/' + key;
      try { require('fs').unlinkSync(file.path); } catch (e) {}
      console.log('[r2] yüklendi:', key);
    }).catch(function(e) {
      console.error('[r2] yükleme hatası (' + file.filename + '):', e.message);
    }).then(step);
  });
}

// Yüklenen fotoğrafları R2'ye gitmeden önce küçültür: max 1600px + WebP q70.
// Orijinal (telefon) fotoğraflar 2-8 MB olabiliyordu — LCP ve bandwidth için en
// büyük kazanç bu. Hata olursa dosya olduğu gibi yüklenir (akış bozulmaz).
function collectUploadedFiles(req) {
  const files = [];
  if (req.file) files.push(req.file);
  if (req.files) {
    if (Array.isArray(req.files)) files.push.apply(files, req.files);
    else Object.keys(req.files).forEach(function(k) {
      const v = req.files[k];
      if (Array.isArray(v)) files.push.apply(files, v);
    });
  }
  return files.filter(f => f && f.path);
}

// Tarayici mimetype'sine guvenmek yetersiz: uzantisi/icerik tipi image
// gorunen ama aslında o olmayan dosyalari ilk baytlarina (magic byte) bakarak
// ayiklar. Sahte dosya diskten silinir, istek goralsiz devam eder.
const IMAGE_SIGNATURES = [
  b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,                                    // JPEG
  b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,                   // PNG
  b => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',   // WEBP
  b => { const g = b.toString('latin1', 0, 6); return g === 'GIF87a' || g === 'GIF89a'; }  // GIF
];
function looksLikeImage(file) {
  let head;
  try {
    const fd = require('fs').openSync(file.path, 'r');
    head = Buffer.alloc(12);
    require('fs').readSync(fd, head, 0, 12, 0);
    require('fs').closeSync(fd);
  } catch (e) { return false; }
  return IMAGE_SIGNATURES.some(fn => fn(head));
}
function dropForgedImages(req) {
  const bad = collectUploadedFiles(req).filter(f => !looksLikeImage(f));
  if (!bad.length) return;
  const badSet = new Set(bad);
  bad.forEach(function(f) {
    try { require('fs').unlinkSync(f.path); } catch (e) {}
    console.warn('[img] sahte goruntu reddedildi:', f.originalname || f.filename);
  });
  if (req.file && badSet.has(req.file)) req.file = null;
  if (Array.isArray(req.files)) {
    req.files = req.files.filter(f => !badSet.has(f));
  } else if (req.files) {
    Object.keys(req.files).forEach(function(k) {
      const v = req.files[k];
      if (Array.isArray(v)) req.files[k] = v.filter(f => !badSet.has(f));
    });
  }
}

async function optimizeUploadedImages(req) {
  const files = collectUploadedFiles(req);
  const fsp = require('fs');
  const sharp = require('sharp');
  await Promise.all(files.map(async function(file) {
    if (!file || !file.path || !/^image\/(jpeg|png|webp)$/.test(file.mimetype || '')) return;
    try {
      const before = fsp.statSync(file.path).size;
      const out = await sharp(file.path)
        .resize({ width: 1600, withoutEnlargement: true })
        .webp({ quality: 70, smartSubsample: true })
        .toBuffer();
      if (out.length >= before) return; // küçülmediyse dokunma
      const newPath = file.path.replace(/\.[A-Za-z0-9]+$/, '') + '.webp';
      fsp.writeFileSync(newPath, out);
      if (newPath !== file.path) { try { fsp.unlinkSync(file.path); } catch (e) {} }
      file.path = newPath;
      file.filename = require('path').basename(newPath);
      file.mimetype = 'image/webp';
      console.log('[img] optimize:', file.filename, Math.round(before / 1024) + 'KB -> ' + Math.round(out.length / 1024) + 'KB');
    } catch (e) {
      console.warn('[img] optimize atlandi (' + file.filename + '):', e.message);
    }
  }));
}

function withUpload(mw) {
  return function(req, res, next) {
    mw(req, res, function(err) {
      if (err) return next(err);
      dropForgedImages(req);
      optimizeUploadedImages(req).then(function() {
        finishUploads(req, res, next);
      }).catch(function(e) {
        console.warn('[img] optimize hata:', e.message);
        finishUploads(req, res, next);
      });
    });
  };
}

// Eski kayıtlar /img/uploads/* altında URL tutuyor; dosyalar R2'de uploads/ altında.
// express.static dosyayı bulamayınca next() ile bu rotaya düşer.
async function serveUploadByName(req, res) {
  const name = path.basename(String(req.params.file || ''));
  if (!name || name === '.' || name === '..') return res.status(404).type('text').send('Görsel bulunamadı');
  if (R2) {
    try {
      const r = await R2.client.fetch('https://' + R2.account + '.r2.cloudflarestorage.com/' + R2.bucket + '/uploads/' + name, { method: 'GET' });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.set('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        return res.send(buf);
      }
      if (r.status !== 404) console.error('[r2] okuma hatası (' + name + '): HTTP ' + r.status);
    } catch (e) {
      console.error('[r2] okuma hatası (' + name + '):', e.message);
    }
  }
  const local = path.join(__dirname, 'public', 'img', 'uploads', name);
  if (require('fs').existsSync(local)) {
    res.set('Cache-Control', 'public, max-age=86400');
    return res.sendFile(local);
  }
  res.status(404).type('text').send('Görsel bulunamadı');
}

app.get('/uploads/:file', serveUploadByName);
app.get('/img/uploads/:file', serveUploadByName);

function uploadHandler(field, renderView, loadData) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        const edit = req.body && req.body.edit_id ? loadData(req.body.edit_id) : (req.query && req.query.edit ? loadData(req.query.edit) : null);
        let msg = 'Görsel yüklenemedi.';
        if (err.code === 'LIMIT_FILE_SIZE') msg = 'Dosya çok büyük (maksimum 10 MB).';
        else if (err.code === 'LIMIT_UNEXPECTED_FILE') msg = 'Beklenmeyen alan.';
        return res.render(renderView, { edit, error: msg });
      }
      if (err) {
        const edit = req.body && req.body.edit_id ? loadData(req.body.edit_id) : null;
        return res.render(renderView, { edit, error: 'Görsel yüklenemedi: ' + err.message });
      }
      next();
    });
  };
}

app.get('/admin/duyuru-ekle', isAuthenticated, (req, res) => {
  const { get } = require('./db');
  const edit = req.query.edit ? get('SELECT * FROM announcements WHERE id = ?', [req.query.edit]) : null;
  res.render('admin/announcement-form', { edit, error: null });
});

app.post('/admin/duyuru-ekle', isAuthenticated, function(req, res, next) {
  withUpload(upload.single('image'))(req, res, function(err) {
    if (err) {
      const edit = req.body && req.body.edit_id ? require('./db').get('SELECT * FROM announcements WHERE id = ?', [req.body.edit_id]) : null;
      return res.render('admin/announcement-form', { edit, error: 'Görsel yüklenemedi.' });
    }
    next();
  });
}, (req, res) => {
  const { run, get, slugify, ensureUniqueSlug } = require('./db');
  const { title, content, category, edit_id, existing_image } = req.body;
  let image = existing_image || '';
  const safeTitle = title || '';
  const safeContent = content || '';
  const safeCategory = category || 'duyuru';
  const eventDateRaw = String(req.body.event_date || '');
  const event_date = safeCategory === 'etkinlik' && /^\d{4}-\d{2}-\d{2}$/.test(eventDateRaw) ? eventDateRaw : null;
  if (req.file) image = pubUrl(req.file);
  if (edit_id) {
    const existing = get('SELECT * FROM announcements WHERE id = ?', [edit_id]);
    let slug = existing && existing.slug;
    if (existing && existing.title !== safeTitle) {
      slug = ensureUniqueSlug(slugify(safeTitle), parseInt(edit_id), 'announcements');
    }
    run('UPDATE announcements SET title=?, slug=?, content=?, category=?, image=?, event_date=? WHERE id=?', [safeTitle, slug, safeContent, safeCategory, image, event_date, edit_id]);
    deleteReplacedMedia(existing && existing.image, image);
    pingIndexNow('/duyuru/' + slug);
    pingIndexNow('/etkinlikler');
  } else {
    const slug = ensureUniqueSlug(slugify(safeTitle), null, 'announcements');
    run('INSERT INTO announcements (title, slug, content, category, image, event_date) VALUES (?,?,?,?,?,?)', [safeTitle, slug, safeContent, safeCategory, image, event_date]);
    pingIndexNow('/duyuru/' + slug);
    pingIndexNow('/etkinlikler');
  }
  flash(res, '/admin?tab=announcements', (edit_id ? 'Güncellendi: ' : 'Eklendi: ') + safeTitle);
});

app.post('/admin/duyuru-sil/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT title, image FROM announcements WHERE id = ?', [req.params.id]);
  if (item) deleteUploadedMedia(item.image);
  run('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  flash(res, '/admin?tab=announcements', 'Silindi: ' + ((item && item.title) || '#' + req.params.id));
});

// Kullanıcı ilan/duyuru onay akışı
app.post('/admin/duyuru-onay/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  run("UPDATE announcements SET status = 'active' WHERE id = ?", [req.params.id]);
  const item = get('SELECT title, slug FROM announcements WHERE id = ?', [req.params.id]);
  if (item) pingIndexNow('/duyuru/' + (item.slug || req.params.id));
  pingIndexNow('/etkinlikler');
  flash(res, '/admin?tab=announcements', 'Yayına alındı: ' + ((item && item.title) || '#' + req.params.id));
});

app.post('/admin/duyuru-reddet/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT title, image FROM announcements WHERE id = ?', [req.params.id]);
  if (item) deleteUploadedMedia(item.image);
  run('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  flash(res, '/admin?tab=announcements', 'Reddedildi ve silindi: ' + ((item && item.title) || '#' + req.params.id), 'info');
});

// Yayınla/Gizle (haberlerdeki toggle ile aynı davranış)
app.post('/admin/duyurular/toggle/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT * FROM announcements WHERE id = ?', [req.params.id]);
  let next = 'active';
  if (item && item.id) {
    next = item.status === 'active' ? 'passive' : 'active';
    run('UPDATE announcements SET status = ? WHERE id = ?', [next, item.id]);
  }
  flash(res, '/admin?tab=announcements',
    ((item && item.title) || '#' + req.params.id) + (next === 'active' ? ' yayına alındı' : ' yayından kaldırıldı (gizlendi)'),
    next === 'active' ? 'success' : 'info');
});

// ---- "Sizlerden Gelen" fotoğraf gönderileri: admin yönetimi ----
app.get('/admin/fotograflar', isAuthenticated, (req, res) => {
  const { all } = require('./db');
  const items = all("SELECT * FROM photo_submissions ORDER BY (status = 'pending') DESC, created_at DESC");
  const daily = dailyViewsToday().photos || { byKey: {}, total: 0 };
  items.forEach(p => { p.views_today = daily.byKey[String(p.id)] || 0; });
  res.render('admin/photos', { items, photosTodayViews: daily.total });
});

app.post('/admin/fotograflar/onayla/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT * FROM photo_submissions WHERE id = ?', [req.params.id]);
  if (!item || !item.id) return flash(res, '/admin/fotograflar', 'Fotoğraf bulunamadı', 'error');
  run("UPDATE photo_submissions SET status = 'active' WHERE id = ?", [req.params.id]);
  pingIndexNow('/sizlerden-gelen');
  if (item.author_email) {
    sendPortalMail({
      to: item.author_email,
      subject: '✓ Fotoğrafınız yayına alındı — Marmara\'nın İncisi',
      text: 'Paylaştığınız fotoğraf onaylandı ve "Sizlerden Gelen" sayfamızda yayınlandı.\n\nBaşlık: ' + (item.title || '') + '\nhttps://marmaraninincisi.com/sizlerden-gelen',
      logTag: 'foto-onay'
    }).catch(e => console.error('[foto-onay] bildirim maili gönderilemedi:', e.message));
  }
  flash(res, '/admin/fotograflar', 'Yayına alındı: ' + (item.title || '#' + req.params.id) + (item.author_email ? '; yazara bildirim maili gönderildi' : ''));
});

app.post('/admin/fotograflar/reddet/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT title, image FROM photo_submissions WHERE id = ?', [req.params.id]);
  if (item && item.image) deleteUploadedMedia(item.image);
  run('DELETE FROM photo_submissions WHERE id = ?', [req.params.id]);
  flash(res, '/admin/fotograflar', 'Reddedildi ve silindi: ' + ((item && item.title) || '#' + req.params.id), 'info');
});

app.post('/admin/fotograflar/toggle/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT * FROM photo_submissions WHERE id = ?', [req.params.id]);
  let next = 'active';
  if (item && item.id) {
    next = item.status === 'active' ? 'passive' : 'active';
    run('UPDATE photo_submissions SET status = ? WHERE id = ?', [next, item.id]);
  }
  flash(res, '/admin/fotograflar',
    ((item && item.title) || '#' + req.params.id) + (next === 'active' ? ' yayına alındı' : ' yayından kaldırıldı (gizlendi)'),
    next === 'active' ? 'success' : 'info');
});

app.post('/admin/fotograflar/sil/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT title, image FROM photo_submissions WHERE id = ?', [req.params.id]);
  if (item && item.image) deleteUploadedMedia(item.image);
  run('DELETE FROM photo_submissions WHERE id = ?', [req.params.id]);
  flash(res, '/admin/fotograflar', 'Silindi: ' + ((item && item.title) || '#' + req.params.id));
});

// Fotoğraf görüntülenme sıfırlama (toplu + satır bazlı)
app.post('/admin/fotograflar/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const total = get('SELECT COALESCE(SUM(views_count), 0) AS t FROM photo_submissions').t || 0;
  run('UPDATE photo_submissions SET views_count = 0');
  const daily = clearDailyViews('photos', null);
  console.log(`[admin] Fotoğraf görüntülenmeleri sıfırlandı (toplam ${total}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  flash(res, '/admin/fotograflar', 'Görüntülenme sayaçları sıfırlandı (toplam ' + total + ', bugün ' + daily + ')', 'info');
});

app.post('/admin/fotograflar/:id/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT * FROM photo_submissions WHERE id = ?', [req.params.id]);
  if (item && item.id) {
    const prev = Number(item.views_count) || 0;
    run('UPDATE photo_submissions SET views_count = 0 WHERE id = ?', [item.id]);
    const daily = clearDailyViews('photos', [item.id]);
    console.log(`[admin] Fotoğraf görüntülenmesi sıfırlandı: "${item.title}" (${prev}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  }
  let back = '/admin/fotograflar';
  try {
    const ref = new URL(req.get('Referer') || '', 'http://localhost');
    if (ref.host === req.get('host')) back = ref.pathname + ref.search;
  } catch (e) {}
  flash(res, back, 'Görüntülenme sıfırlandı: ' + ((item && item.title) || '#' + req.params.id), 'info');
});

// ---- Ana sayfa anketi (admin) ----
// Liste: soru + secenekler + oy adetleri. Yeni anket PASIF eklenir, tek anket
// 'active' olabilir (yayina alma degil digerlerini passive yapar).
app.get('/admin/anketler', isAuthenticated, (req, res) => {
  const { all } = require('./db');
  const polls = all('SELECT * FROM polls ORDER BY (status = \'active\') DESC, created_at DESC');
  const counts = all('SELECT poll_id, COUNT(*) AS cnt FROM poll_votes GROUP BY poll_id');
  const byPoll = {};
  (counts || []).forEach(c => { byPoll[c.poll_id] = Number(c.cnt) || 0; });
  polls.forEach(p => { p.votes = byPoll[p.id] || 0; });
  const optRows = all('SELECT o.id, o.poll_id, o.label, COUNT(v.id) AS cnt FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id GROUP BY o.id ORDER BY o.poll_id ASC, o.position ASC, o.id ASC') || [];
  polls.forEach(p => { p.options = optRows.filter(o => o.poll_id === p.id); });
  res.render('admin/polls', { polls, errorQ: req.query.err === 'q', errorOpt: req.query.err === 'opt' });
});

app.post('/admin/anketler/ekle', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const question = String(req.body.question || '').trim().replace(/\s+/g, ' ');
  const labels = (Array.isArray(req.body.labels) ? req.body.labels : [req.body.labels])
    .map(l => String(l || '').trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (question.length < 3 || question.length > 300) {
    return flash(res, '/admin/anketler?err=q', 'Soru 3-300 karakter olmalı', 'error');
  }
  if (labels.length < 2) {
    return flash(res, '/admin/anketler?err=opt', 'En az 2 seçenek gerekli', 'error');
  }
  if (labels.length > 8) {
    return flash(res, '/admin/anketler?err=opt', 'En fazla 8 seçenek', 'error');
  }
  if (labels.some(l => l.length > 120)) {
    return flash(res, '/admin/anketler?err=opt', 'Seçenek başına en fazla 120 karakter', 'error');
  }
  run('INSERT INTO polls (question, status, created_at) VALUES (?, \'passive\', datetime(\'now\'))', [question]);
  const poll = get('SELECT id FROM polls ORDER BY id DESC LIMIT 1');
  labels.forEach((l, i) => {
    run('INSERT INTO poll_options (poll_id, label, position) VALUES (?, ?, ?)', [poll.id, l, i]);
  });
  console.log(`[admin] Yeni anket eklendi (#${poll.id}): "${question}" (${labels.length} seçenek) - ${req.session.adminUser || 'admin'}`);
  flash(res, '/admin/anketler', `Anket kaydedildi (#${poll.id}) — yayına almak için ▶ kullanın`, 'info');
});

app.post('/admin/anketler/toggle/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT id, question, status FROM polls WHERE id = ?', [req.params.id]);
  if (!item || !item.id) return flash(res, '/admin/anketler', 'Anket bulunamadı', 'error');
  if (item.status === 'active') {
    run('UPDATE polls SET status = \'passive\' WHERE id = ?', [item.id]);
    flash(res, '/admin/anketler', 'Anket yayından kaldırıldı', 'info');
  } else {
    // tek aktif anket: tum aktifleri passive yapar, bu aktif olur
    run('UPDATE polls SET status = \'passive\' WHERE status = \'active\'');
    run('UPDATE polls SET status = \'active\' WHERE id = ?', [item.id]);
    console.log(`[admin] Anket yayına alındı (#${item.id}): "${item.question}" - ${req.session.adminUser || 'admin'}`);
    flash(res, '/admin/anketler', `Anket yayında: "${item.question}"`);
  }
});

app.post('/admin/anketler/oy-sifirla/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM poll_votes WHERE poll_id = ?', [req.params.id]);
  console.log(`[admin] Anket oyları sıfırlandı (#${req.params.id}) - ${req.session.adminUser || 'admin'}`);
  flash(res, '/admin/anketler', `Anket #${req.params.id} oyları sıfırlandı`, 'info');
});

app.post('/admin/anketler/sil/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM poll_votes WHERE poll_id = ?', [req.params.id]);
  run('DELETE FROM poll_options WHERE poll_id = ?', [req.params.id]);
  run('DELETE FROM polls WHERE id = ?', [req.params.id]);
  console.log(`[admin] Anket tamamen silindi (#${req.params.id}) - ${req.session.adminUser || 'admin'}`);
  flash(res, '/admin/anketler', `Anket #${req.params.id} silindi`, 'info');
});

app.get('/admin/anketler/duzenle/:id', isAuthenticated, (req, res) => {
  const { get, all } = require('./db');
  const poll = get('SELECT id, question, status, created_at FROM polls WHERE id = ?', [req.params.id]);
  if (!poll || !poll.id) return flash(res, '/admin/anketler', 'Anket bulunamadi', 'error');
  const options = all('SELECT id, label, position FROM poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC', [poll.id]);
  res.render('admin/poll-edit', { poll, options, errorQ: req.query.err === 'q', errorOpt: req.query.err === 'opt' });
});

app.post('/admin/anketler/guncelle/:id', isAuthenticated, (req, res) => {
  const { run, get, all } = require('./db');
  const poll = get('SELECT id, question FROM polls WHERE id = ?', [req.params.id]);
  if (!poll || !poll.id) return flash(res, '/admin/anketler', 'Anket bulunamadi', 'error');
  const question = String(req.body.question || '').trim();
  const labels = (Array.isArray(req.body.labels) ? req.body.labels : [req.body.labels])
    .map(l => String(l || '').trim()).filter(l => l.length > 0);
  if (question.length < 3 || question.length > 300) return flash(res, `/admin/anketler/duzenle/${poll.id}?err=q`, 'Soru 3-300 karakter olmali', 'error');
  if (labels.length < 2) return flash(res, `/admin/anketler/duzenle/${poll.id}?err=opt`, 'En az 2 secenek gerekli', 'error');
  if (labels.length > 8) return flash(res, `/admin/anketler/duzenle/${poll.id}?err=opt`, 'En fazla 8 secenek', 'error');
  if (labels.some(l => l.length > 120)) return flash(res, `/admin/anketler/duzenle/${poll.id}?err=opt`, 'Secenek basina en fazla 120 karakter', 'error');
  const existing = all('SELECT id, label FROM poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC', [poll.id]) || [];
  // mevcut secenekler sira korunur -> oylar (option_id bazli) bozulmaz
  for (let i = 0; i < Math.min(labels.length, existing.length); i++) {
    if (labels[i] !== existing[i].label) run('UPDATE poll_options SET label = ? WHERE id = ?', [labels[i], existing[i].id]);
  }
  if (labels.length > existing.length) {
    const maxPos = get('SELECT COALESCE(MAX(position), -1) AS m FROM poll_options WHERE poll_id = ?', [poll.id]);
    let pos = (maxPos && maxPos.m != null ? Number(maxPos.m) : -1) + 1;
    for (let i = existing.length; i < labels.length; i++) {
      run('INSERT INTO poll_options (poll_id, label, position) VALUES (?, ?, ?)', [poll.id, labels[i], pos++]);
    }
  } else if (labels.length < existing.length) {
    const removed = existing.slice(labels.length);
    removed.forEach(o => {
      run('DELETE FROM poll_votes WHERE option_id = ?', [o.id]);
      run('DELETE FROM poll_options WHERE id = ?', [o.id]);
    });
  }
  if (question !== poll.question) run('UPDATE polls SET question = ? WHERE id = ?', [question, poll.id]);
  console.log(`[admin] Anket guncellendi (#${poll.id}): "${question}" (${labels.length} secenek) - ${req.session.adminUser || 'admin'}`);
  flash(res, '/admin/anketler', `Anket #${poll.id} guncellendi`);
});

// Duyuru/ilan görüntülenme sıfırlama (toplu + satır bazlı)
app.post('/admin/duyurular/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const total = get('SELECT COALESCE(SUM(views_count), 0) AS t FROM announcements').t || 0;
  run("UPDATE announcements SET views_count = 0, views_reset_at = datetime('now')");
  const daily = clearDailyViews('announcements', null);
  console.log(`[admin] Duyuru/ilan görüntülenmeleri sıfırlandı (toplam ${total}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  flash(res, '/admin?tab=announcements', 'Görüntülenme sayaçları sıfırlandı (toplam ' + total + ', bugün ' + daily + ')', 'info');
});

app.post('/admin/duyurular/:id/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT * FROM announcements WHERE id = ?', [req.params.id]);
  if (item && item.id) {
    const prev = Number(item.views_count) || 0;
    run("UPDATE announcements SET views_count = 0, views_reset_at = datetime('now') WHERE id = ?", [item.id]);
    const daily = clearDailyViews('announcements', [item.slug, item.id]);
    console.log(`[admin] Duyuru/ilan görüntülenmesi sıfırlandı: "${item.title}" (${prev}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  }
  let back = '/admin?tab=announcements';
  try {
    const ref = new URL(req.get('Referer') || '', 'http://localhost');
    if (ref.host === req.get('host')) back = ref.pathname + ref.search;
  } catch (e) {}
  flash(res, back, 'Görüntülenme sıfırlandı: ' + ((item && item.title) || '#' + req.params.id), 'info');
});

// ==================== KULLANICI İLAN/İLAN VERME ====================

// İlan verme sayfası serbest (Google girişi zorunlu değil; varsa kullanıcı bilgileri önceden doldurulur)

app.get('/ilan-ver', (req, res) => {
  const code = issueCaptcha(req);
  const user = (req.session.isGoogleAuth && req.session.googleUser) ? req.session.googleUser : null;
  res.render('ilan-ver', {
    user,
    error: null,
    form: {
      user_name: user ? user.name : '',
      user_email: user ? user.email : '',
      phone: ''
    },
    captchaImage: svgDataUri(code)
  });
});

app.post('/ilan-ver', function(req, res, next) {
  withUpload(upload.single('image'))(req, res, function(err) {
    const isJson = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || req.query.format === 'json';
    if (err) {
      let msg = 'Görsel yüklenemedi.';
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') msg = 'Dosya çok büyük (maksimum 10 MB).';
        else if (err.code === 'LIMIT_UNEXPECTED_FILE') msg = 'Beklenmeyen dosya alanı.';
      } else if (err && err.message) {
        msg = err.message;
      }
      if (isJson) return res.status(400).json({ success: false, error: msg });
      const user = (req.session.isGoogleAuth && req.session.googleUser) ? req.session.googleUser : null;
      return res.render('ilan-ver', { user, error: msg, form: req.body || {}, captchaImage: svgDataUri(issueCaptcha(req)) });
    }
    next();
  });
}, async (req, res) => {
  const { run } = require('./db');
  const isJson = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || req.query.format === 'json';
  const gUser = (req.session.isGoogleAuth && req.session.googleUser) ? req.session.googleUser : null;

  const userName = String(req.body.user_name || req.body.name || (gUser ? gUser.name : '')).trim();
  const userEmail = String(req.body.user_email || req.body.email || (gUser ? gUser.email : '')).trim();
  const userPhone = String(req.body.phone || req.body.user_phone || '').trim();
  const title = String(req.body.title || '').trim();
  const content = String(req.body.content || '').trim();
  const category = ['duyuru', 'ilan', 'etkinlik'].includes(req.body.category) ? req.body.category : 'ilan';
  const captcha = String(req.body.captcha || '').trim().toUpperCase();

  function fail(errMsg) {
    if (isJson) return res.status(400).json({ success: false, error: errMsg });
    return res.render('ilan-ver', {
      user: gUser,
      error: errMsg,
      form: req.body || {},
      captchaImage: svgDataUri(issueCaptcha(req))
    });
  }

  if (!userName || userName.length < 2) {
    return fail('Lütfen adınızı ve soyadınızı belirtin.');
  }
  if (!userEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) {
    return fail('Lütfen geçerli bir e-posta adresi girin.');
  }
  if (title.length < 5 || title.length > 120) {
    return fail('Başlık 5 ile 120 karakter arasında olmalıdır.');
  }
  if (content.length < 20 || content.length > 4000) {
    return fail('İçerik 20 ile 4000 karakter arasında olmalıdır.');
  }
  const rcCheck = await verifyUserCaptcha(req);
  if (!rcCheck.ok) {
    return fail(rcCheck.error);
  }

  const image = req.file ? pubUrl(req.file) : '';
  const { slugify: annSlugify, ensureUniqueSlug: annUniqueSlug } = require('./db');
  const slug = annUniqueSlug(annSlugify(title), null, 'announcements');
  const eventDateRaw = String(req.body.event_date || '');
  const event_date = category === 'etkinlik' && /^\d{4}-\d{2}-\d{2}$/.test(eventDateRaw) ? eventDateRaw : null;

  run("INSERT INTO announcements (title, slug, content, category, image, status, user_name, user_email, phone, event_date) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [title.slice(0, 120), slug, content.slice(0, 4000), category, image, 'pending', userName.slice(0, 80), userEmail.slice(0, 120), userPhone.slice(0, 40), event_date]);

  req.session.captchaCodes = [];

  const turMap = { ilan: 'İlan', duyuru: 'Duyuru', etkinlik: 'Etkinlik' };
  sendPortalMail({
    to: process.env.ADMIN_2FA_EMAIL || 'kerimkaplan@yahoo.com',
    subject: '📝 Yeni ' + (turMap[category] || 'İlan') + ' başvurusu: ' + title.slice(0, 60),
    text: 'Tür: ' + (turMap[category] || 'İlan') +
      '\nBaşlık: ' + title +
      '\nGönderen: ' + userName + ' <' + userEmail + '>' +
      (userPhone ? '\nTelefon: ' + userPhone : '') +
      (event_date ? '\nEtkinlik Tarihi: ' + event_date : '') +
      '\nGörsel: ' + (image || 'Yok') +
      '\n\nİçerik:\n' + content,
    replyTo: userEmail || '',
    logTag: 'ilan-ver'
  }).catch(e => console.error('[ilan-ver] bildirim maili gönderilemedi:', e.message));

  if (isJson) {
    return res.json({
      success: true,
      message: 'İlanınız başarıyla alındı. Yönetici onayından sonra yayınlanacaktır.'
    });
  }
  flash(res, '/duyurular?gonderildi=1', 'İlanınız alındı; onaylandıktan sonra yayınlanacak');
});

// ---- "Sizlerden Gelen": kullanıcı fotoğraf paylaşımları (girişsiz, admin onaylı) ----
app.get('/sizlerden-gelen', (req, res) => {
  const { all } = require('./db');
  const photos = all("SELECT * FROM photo_submissions WHERE status = 'active' ORDER BY created_at DESC LIMIT 200");
  const user = (req.session.isGoogleAuth && req.session.googleUser) ? req.session.googleUser : null;
  res.render('photos', {
    photos,
    user,
    sent: req.query.gonderildi === '1',
    error: null,
    form: { user_name: user ? user.name : '', user_email: user ? user.email : '' },
    captchaImage: svgDataUri(issueCaptcha(req))
  });
});

app.post('/sizlerden-gelen', function(req, res, next) {
  withUpload(upload.single('image'))(req, res, function(err) {
    const isJson = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || req.query.format === 'json';
    if (err) {
      let msg = 'Fotoğraf yüklenemedi.';
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') msg = 'Dosya çok büyük (maksimum 10 MB).';
        else if (err.code === 'LIMIT_UNEXPECTED_FILE') msg = 'Beklenmeyen dosya alanı.';
      } else if (err && err.message) {
        msg = err.message;
      }
      if (isJson) return res.status(400).json({ success: false, error: msg });
      const user = (req.session.isGoogleAuth && req.session.googleUser) ? req.session.googleUser : null;
      return res.render('photos', {
        photos: require('./db').all("SELECT * FROM photo_submissions WHERE status = 'active' ORDER BY created_at DESC LIMIT 200"),
        user, error: msg, sent: false,
        form: req.body || {},
        captchaImage: svgDataUri(issueCaptcha(req))
      });
    }
    next();
  });
}, async (req, res) => {
  const { run, all } = require('./db');
  const isJson = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || req.query.format === 'json';
  const gUser = (req.session.isGoogleAuth && req.session.googleUser) ? req.session.googleUser : null;

  const userName = String(req.body.user_name || req.body.name || (gUser ? gUser.name : '')).trim();
  const userEmail = String(req.body.user_email || req.body.email || (gUser ? gUser.email : '')).trim();
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const captcha = String(req.body.captcha || '').trim().toUpperCase();

  function fail(errMsg) {
    if (isJson) return res.status(400).json({ success: false, error: errMsg });
    return res.render('photos', {
      photos: all("SELECT * FROM photo_submissions WHERE status = 'active' ORDER BY created_at DESC LIMIT 200"),
      user: gUser, error: errMsg, sent: false,
      form: req.body || {},
      captchaImage: svgDataUri(issueCaptcha(req))
    });
  }

  if (!userName || userName.length < 2) return fail('Lütfen adınızı ve soyadınızı belirtin.');
  if (!userEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) return fail('Lütfen geçerli bir e-posta adresi girin.');
  if (title.length < 3 || title.length > 120) return fail('Başlık 3 ile 120 karakter arasında olmalıdır.');
  if (description.length > 2000) return fail('Açıklama en fazla 2000 karakter olabilir.');
  if (!req.file) return fail('Lütfen paylaşmak istediğiniz fotoğrafı seçin.');
  const rcCheck = await verifyUserCaptcha(req);
  if (!rcCheck.ok) return fail(rcCheck.error);

  run("INSERT INTO photo_submissions (title, description, image, author_name, author_email, status) VALUES (?,?,?,?,?,'pending')",
    [title.slice(0, 120), description.slice(0, 2000), pubUrl(req.file), userName.slice(0, 80), userEmail.slice(0, 120)]);

  req.session.captchaCodes = [];

  sendPortalMail({
    to: process.env.ADMIN_2FA_EMAIL || 'kerimkaplan@yahoo.com',
    subject: '📷 Yeni fotoğraf paylaşımı: ' + title.slice(0, 60),
    text: 'Başlık: ' + title +
      '\nGönderen: ' + userName + ' <' + userEmail + '>' +
      (description ? '\nAçıklama: ' + description : '') +
      '\nFotoğraf: /sizlerden-gelen (admin panelden onaylayabilirsiniz)',
    replyTo: userEmail || '',
    logTag: 'foto-paylasim'
  }).catch(e => console.error('[foto-paylasim] bildirim maili gönderilemedi:', e.message));

  const receivedMsg = i18n.t(req.lang, 'photosReceived');
  if (isJson) return res.json({ success: true, message: receivedMsg });
  flash(res, '/sizlerden-gelen?gonderildi=1', 'Fotoğrafınız alındı; onaylandıktan sonra yayınlanacaktır');
});

app.get('/admin/hakkinda', isAuthenticated, (req, res) => {
  const { get } = require('./db');
  const about = get('SELECT * FROM about_page WHERE id = 1');
  res.render('admin/about-form', { about, error: null, saved: req.query.saved === '1' });
});

app.post('/admin/hakkinda', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  const { banner_subtitle, content, cta_title, cta_text } = req.body;
  if (!content || !content.trim()) {
    const { get } = require('./db');
    const about = get('SELECT * FROM about_page WHERE id = 1');
    return res.render('admin/about-form', { about, error: 'İçerik zorunludur', saved: false });
  }
  run(`UPDATE about_page SET banner_subtitle=?, content=?, cta_title=?, cta_text=?, updated_at=datetime('now') WHERE id=1`,
    [banner_subtitle || '', content, cta_title || '', cta_text || '']);
  flash(res, '/admin/hakkinda?saved=1', 'Hakkında sayfası kaydedildi');
});

app.get('/admin/mekan-ekle', isAuthenticated, (req, res) => {
  const { get } = require('./db');
  const edit = req.query.edit ? get('SELECT * FROM places WHERE id = ?', [req.query.edit]) : null;
  res.render('admin/place-form', { edit, error: null });
});

app.post('/admin/mekan-ekle', isAuthenticated, function(req, res, next) {
  withUpload(upload.fields([
    { name: 'main_image', maxCount: 1 },
    { name: 'gallery_images', maxCount: 10 }
  ]))(req, res, function(err) {
    if (err) {
      const edit = req.body && req.body.edit_id ? require('./db').get('SELECT * FROM places WHERE id = ?', [req.body.edit_id]) : (req.query && req.query.edit ? require('./db').get('SELECT * FROM places WHERE id = ?', [req.query.edit]) : null);
      return res.render('admin/place-form', { edit, error: 'Görsel yüklenemedi.' });
    }
    next();
  });
}, (req, res) => {
  const { run, get, slugify, ensureUniqueSlug } = require('./db');
  const { name, category, cuisine_type, establishment_type, meal_type, address, phone, working_hours, map_link, description, status, is_featured, display_until, sort_order, google_reviews_url, edit_id } = req.body;
  const estTypeArr = Array.isArray(establishment_type) ? establishment_type : (establishment_type ? [establishment_type] : []);
  const mealTypeArr = Array.isArray(meal_type) ? meal_type : (meal_type ? [meal_type] : []);

  let main_image_url = (req.files && req.files.main_image && req.files.main_image[0]) ? pubUrl(req.files.main_image[0]) : '';

  let galleryArr = [];
  if (req.body.existing_gallery) {
    let existingRaw = req.body.existing_gallery;
    if (typeof existingRaw === 'string') {
      try {
        const parsed = JSON.parse(existingRaw);
        if (Array.isArray(parsed)) galleryArr = parsed;
        else galleryArr = [existingRaw];
      } catch (e) {
        galleryArr = [existingRaw];
      }
    } else if (Array.isArray(existingRaw)) {
      galleryArr = existingRaw.slice();
    }
  }
  const newUrls = (req.files && req.files.gallery_images && Array.isArray(req.files.gallery_images))
    ? req.files.gallery_images.map(f => pubUrl(f))
    : [];
  galleryArr = applyGalleryOrder(req, galleryArr, newUrls);

  if (!name || !category || !description) {
    const edit = edit_id ? get('SELECT * FROM places WHERE id = ?', [edit_id]) : null;
    return res.render('admin/place-form', { edit, error: 'Mekan adı, kategori ve açıklama zorunludur' });
  }

  const features = req.body.features ? (Array.isArray(req.body.features) ? req.body.features : [req.body.features]) : [];
  const statusVal = status === 'passive' ? 'passive' : 'active';
  const isFeatured = is_featured ? 1 : 0;

  if (edit_id) {
    const existing = get('SELECT * FROM places WHERE id = ?', [edit_id]);
    if (existing && !main_image_url) main_image_url = existing.main_image_url || '';
    let slug = existing.slug;
    if (existing.name !== name) {
      slug = ensureUniqueSlug(slugify(name), parseInt(edit_id), 'places');
    }
    run(`UPDATE places SET name=?, slug=?, category=?, cuisine_type=?, establishment_type=?, meal_type=?, address=?, phone=?, working_hours=?, map_link=?, features=?, main_image_url=?, gallery_images=?, description=?, is_featured=?, status=?, display_until=?, sort_order=?, google_reviews_url=? WHERE id=?`,
        [name, slug, category, cuisine_type || '', JSON.stringify(estTypeArr), JSON.stringify(mealTypeArr), address || '', phone || '', working_hours || '', map_link || '', JSON.stringify(features), main_image_url, JSON.stringify(galleryArr), description || '', isFeatured, statusVal, display_until || null, parseInt(sort_order) || 0, google_reviews_url || '', edit_id]);
    deleteReplacedMedia([existing.main_image_url], [main_image_url].concat(galleryArr));
    deleteReplacedMedia(galleryJsonUrls(existing.gallery_images), galleryArr);
    pingIndexNow('/mekan/' + slug);
    flash(res, '/admin?tab=places', 'Güncellendi: ' + name);
  } else {
    const slug = ensureUniqueSlug(slugify(name), null, 'places');
    run(`INSERT INTO places (name, slug, category, cuisine_type, establishment_type, meal_type, address, phone, working_hours, map_link, features, main_image_url, gallery_images, description, is_featured, status, display_until, sort_order, google_reviews_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, slug, category, cuisine_type || '', JSON.stringify(estTypeArr), JSON.stringify(mealTypeArr), address || '', phone || '', working_hours || '', map_link || '', JSON.stringify(features), main_image_url, JSON.stringify(galleryArr), description || '', isFeatured, statusVal, display_until || null, parseInt(sort_order) || 0, google_reviews_url || '']);
    pingIndexNow('/mekan/' + slug);
    flash(res, '/admin?tab=places', 'Eklendi: ' + name);
  }
});

app.post('/admin/gallery-delete', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const { place_id, image_url, existing_gallery } = req.body;

  let galleryArr = [];
  if (existing_gallery) {
    try {
      const parsed = JSON.parse(existing_gallery);
      if (Array.isArray(parsed)) galleryArr = parsed;
    } catch (e) {}
  }

  const filtered = galleryArr.filter(g => g !== image_url);
  run('UPDATE places SET gallery_images = ? WHERE id = ?', [JSON.stringify(filtered), place_id]);
  deleteUploadedMedia(image_url);

  res.json({ success: true, gallery: filtered });
});

app.post('/admin/mekan-sil/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT name, main_image_url, gallery_images FROM places WHERE id = ?', [req.params.id]);
  if (item) deleteUploadedMedia([item.main_image_url].concat(galleryJsonUrls(item.gallery_images)));
  run('DELETE FROM places WHERE id = ?', [req.params.id]);
  flash(res, '/admin?tab=places', 'Silindi: ' + ((item && item.name) || '#' + req.params.id));
});

// Mekan görüntülenme sıfırlama (toplu + satır bazlı)
app.post('/admin/mekanlar/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const total = get('SELECT COALESCE(SUM(views_count), 0) AS t FROM places').t || 0;
  run("UPDATE places SET views_count = 0, views_reset_at = datetime('now')");
  const daily = clearDailyViews('places', null);
  console.log(`[admin] Mekan görüntülenmeleri sıfırlandı (toplam ${total}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  let back = '/admin?tab=places';
  try {
    const ref = new URL(req.get('Referer') || '', 'http://localhost');
    if (ref.host === req.get('host')) back = ref.pathname + ref.search;
  } catch (e) {}
  flash(res, back, 'Görüntülenme sayaçları sıfırlandı (' + total + ')', 'info');
});

app.post('/admin/mekanlar/:id/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT * FROM places WHERE id = ?', [req.params.id]);
  if (item && item.id) {
    const prev = Number(item.views_count) || 0;
    run("UPDATE places SET views_count = 0, views_reset_at = datetime('now') WHERE id = ?", [item.id]);
    const daily = clearDailyViews('places', [item.slug, item.id]);
    console.log(`[admin] Mekan görüntülenmesi sıfırlandı: "${item.name}" (${prev}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  }
  let back = '/admin?tab=places';
  try {
    const ref = new URL(req.get('Referer') || '', 'http://localhost');
    if (ref.host === req.get('host')) back = ref.pathname + ref.search;
  } catch (e) {}
  flash(res, back, 'Görüntülenme sıfırlandı: ' + ((item && item.name) || '#' + req.params.id), 'info');
});

// ==================== FİMA REHBERİ ====================

app.get('/rehber', async (req, res) => {
  const { all } = require('./db');
  const type = req.query.type || 'all';
  let companies;
  if (type === 'all') {
    companies = all("SELECT * FROM companies WHERE status = 'active' ORDER BY sort_order ASC, is_featured DESC, created_at DESC");
  } else {
    companies = all("SELECT * FROM companies WHERE status = 'active' AND (category = ? OR sector = ?) ORDER BY sort_order ASC, is_featured DESC, created_at DESC", [type, type]);
  }
  const parseJSON = (data) => {
    if (!data) return [];
    if (typeof data === 'object') return data;
    try { return JSON.parse(data); } catch (e) { return []; }
  };
  companies.forEach(function(c) {
    c.features = parseJSON(c.features);
    c.gallery_images = parseJSON(c.gallery_images);
  });
  await txArray(companies, ['description'], req.lang);
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  res.render('rehber', {
    companies, selectedType: type,
    pageTitle: i18n.t(req.lang, 'guide') + ' & Firma Esnaf Rehberi',
    metaDescription: 'Çınarcık esnaf ve firma rehberi: market, usta, taksi, nakliyat, sağlık ve işletme iletişim bilgileri — Marmara\'nın İncisi.',
    pageSchema: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          "name": "Çınarcık Firma Rehberi",
          "description": "Çınarcık esnaf ve işletmeler rehberi.",
          "url": siteUrl + lp + '/rehber'
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
            { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'guide') }
          ]
        }
      ]
    }
  });
});

app.get('/rehber/:slug', async (req, res) => {
  const { get, run } = require('./db');
  const company = get("SELECT * FROM companies WHERE slug = ? OR id = ?", [req.params.slug, isNaN(parseInt(req.params.slug)) ? -1 : req.params.slug]);
  if (!company || !company.id) return res.redirect('/rehber');
  if (!isBotRequest(req)) run("UPDATE companies SET views_count = views_count + 1 WHERE id = ?", [company.id]);
  const parseJSON = (data) => {
    if (!data) return [];
    if (typeof data === 'object') return data;
    try { return JSON.parse(data); } catch (e) { return []; }
  };
  company.features = parseJSON(company.features);
  company.gallery_images = parseJSON(company.gallery_images);
  await Promise.all([
    txFields(company, ['description', 'sector', 'working_hours'], req.lang),
    txJsonArrayField(company, 'features', req.lang)
  ]);
  let embedMapUrl = '';
  let directionsUrl = '';
  let embedFallback = '';
  let embedCoords = null;
  const dirFromCoords = (c) => 'https://www.google.com/maps/dir/?api=1&destination=' + c.lat + ',' + c.lng;
  let pbCid = '';
  if (company.map_embed) {
    // Admin'in yapistirdigi Google embed kodu (tam iframe veya saf src).
    const srcMatch = String(company.map_embed).match(/src=["']([^"']+)["']/i);
    embedFallback = srcMatch ? srcMatch[1] : String(company.map_embed).trim();
    // pb icindeki place key (0x...:0x...) cid'ye cevrilir; hem etiketli pin embed'i
    // hem de tam firmanin pin'ine giden yol tarifi icin kullanilir.
    pbCid = extractPlaceCid(embedFallback);
    if (pbCid) directionsUrl = 'https://www.google.com/maps/dir/?api=1&destination=cid:' + pbCid;
    embedCoords = extractMapCoords(embedFallback);
    if (!directionsUrl && embedCoords) directionsUrl = dirFromCoords(embedCoords);
  }
  // Gorunum diger sayfalarla uyumlu olsun diye koordinattan tek tip keyless
  // Google embed uretilir. once map_link'den cozulen TAM pin gelir; admin'in
  // pb embed'indeki koordinat sadece gorunum merkezidir (~350 m kayma olabilir),
  // o yuzden sadece fallback olarak kullanilir.
  if (company.map_link) {
    const mapInfo = await getMapInfo(company.map_link, company.address);
    if (mapInfo.embedUrl) embedMapUrl = mapInfo.embedUrl;
    if (!directionsUrl) directionsUrl = mapInfo.directionsUrl;
  }
  if (!embedMapUrl && (embedCoords || pbCid)) embedMapUrl = buildMapEmbedUrl(embedCoords, pbCid);
  // Son care: hicbir sekilde koordinat cikmadiysa admin'in ham embed'i.
  if (!embedMapUrl) embedMapUrl = embedFallback;
  const shortDesc = stripHtml(company.description || '').slice(0, 160);
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  res.render('rehber-detail', {
    company, embedMapUrl, directionsUrl,
    pageTitle: company.name + ' - ' + i18n.t(req.lang, 'guide'),
    metaDescription: shortDesc || (company.name + ' — ' + company.category + ' | ' + i18n.t(req.lang, 'metaDescShort')),
    ogImage: company.logo_url || '',
    pageSchema: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "LocalBusiness",
          "name": company.name,
          "description": shortDesc || undefined,
          "image": company.logo_url || undefined,
          "address": company.address ? { "@type": "PostalAddress", "streetAddress": company.address, "addressLocality": "Çınarcık", "addressRegion": "Yalova", "addressCountry": "TR" } : undefined,
          "telephone": company.phone || undefined,
          "email": company.email || undefined,
          "url": siteUrl + lp + '/rehber/' + (company.slug || company.id),
          "openingHours": company.working_hours || undefined
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": i18n.t(req.lang, 'home'), "item": siteUrl + lp + '/' },
            { "@type": "ListItem", "position": 2, "name": i18n.t(req.lang, 'guide'), "item": siteUrl + lp + '/rehber' },
            { "@type": "ListItem", "position": 3, "name": company.name }
          ]
        }
      ]
    }
  });
});

// Admin firma yönetimi
app.get('/admin/firmalar', isAuthenticated, (req, res) => {
  const { all } = require('./db');
  const daily = dailyViewsToday();
  const companies = withViewsToday(all('SELECT * FROM companies ORDER BY sort_order ASC, created_at DESC'), daily.companies);
  res.render('admin/company-list', { companies, todayViews: sumViewsToday(companies) });
});

app.get('/admin/raporlar', isAuthenticated, (req, res) => {
  const { all, get } = require('./db');
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  // "Bugün" ve günlük grafik serisi Türkiye saati (UTC+3) 00:00–24:00 aralığına göre.
  const dayStart = trtDayRange(now.getTime())[0];
  const yesterdayStart = trtDayRange(now.getTime() - 24 * 3600 * 1000)[0];
  const d7 = iso(new Date(now.getTime() - 7 * 24 * 3600 * 1000));
  const d30 = iso(new Date(now.getTime() - 30 * 24 * 3600 * 1000));

  // İç ağ (10.x, 172.16-31, 192.168, 127., IPv6 yerel) + Bot User-Agent'ları + Arka plan API/dosya istekleri
  // istatistikleri şişirmesin diye gerçek ziyaretçi sorgularından tamamen hariç tutulur.
  const PUBLIC_IP = `ip NOT LIKE '10.%' AND ip NOT LIKE '127.%' AND ip NOT LIKE '192.168.%'
    AND ip NOT GLOB '172.1[6-9]*' AND ip NOT GLOB '172.2[0-9]*' AND ip NOT GLOB '172.3[0-1]*'
    AND ip != '::1'`;
  const HUMAN_UA_SQL = `user_agent IS NOT NULL AND LENGTH(TRIM(user_agent)) >= 12
    AND LOWER(user_agent) NOT GLOB '*bot*'
    AND LOWER(user_agent) NOT GLOB '*crawl*'
    AND LOWER(user_agent) NOT GLOB '*spider*'
    AND LOWER(user_agent) NOT GLOB '*slurp*'
    AND LOWER(user_agent) NOT GLOB '*headless*'
    AND LOWER(user_agent) NOT GLOB '*lighthouse*'
    AND LOWER(user_agent) NOT GLOB '*powershell*'
    AND LOWER(user_agent) NOT GLOB '*curl*'
    AND LOWER(user_agent) NOT GLOB '*wget*'
    AND LOWER(user_agent) NOT GLOB '*python*'
    AND LOWER(user_agent) NOT GLOB '*go-http*'
    AND LOWER(user_agent) NOT GLOB '*axios*'
    AND LOWER(user_agent) NOT GLOB '*node-fetch*'
    AND LOWER(user_agent) NOT GLOB '*postman*'
    AND LOWER(user_agent) NOT GLOB '*uptime*'
    AND LOWER(user_agent) NOT GLOB '*pingdom*'
    AND LOWER(user_agent) NOT GLOB '*statuscake*'
    AND LOWER(user_agent) NOT GLOB '*kuma*'
    AND LOWER(user_agent) NOT GLOB '*monitor*'
    AND LOWER(user_agent) NOT GLOB '*whatsapp*'
    AND LOWER(user_agent) NOT GLOB '*facebookexternalhit*'
    AND LOWER(user_agent) NOT GLOB '*embedly*'
    AND LOWER(user_agent) NOT GLOB '*playwright*'
    AND LOWER(user_agent) NOT GLOB '*puppeteer*'
    AND LOWER(user_agent) NOT GLOB '*selenium*'`;
  const PAGE_PATH_SQL = `path NOT LIKE '/api/%'
    AND path NOT LIKE '/uploads/%'
    AND path NOT LIKE '/img/%'
    AND path NOT LIKE '/css/%'
    AND path NOT LIKE '/js/%'
    AND path NOT LIKE '/admin%'
    AND path NOT IN ('/captcha.svg', '/robots.txt', '/sitemap.xml', '/rss.xml', '/favicon.ico')
    AND LOWER(path) NOT GLOB '*.png'
    AND LOWER(path) NOT GLOB '*.jpg'
    AND LOWER(path) NOT GLOB '*.jpeg'
    AND LOWER(path) NOT GLOB '*.webp'
    AND LOWER(path) NOT GLOB '*.gif'
    AND LOWER(path) NOT GLOB '*.svg'
    AND LOWER(path) NOT GLOB '*.ico'
    AND LOWER(path) NOT GLOB '*.css'
    AND LOWER(path) NOT GLOB '*.js'
    AND LOWER(path) NOT GLOB '*.xml'
    AND LOWER(path) NOT GLOB '*.txt'`;

  const HUMAN_WHERE = `${PUBLIC_IP} AND ${HUMAN_UA_SQL} AND ${PAGE_PATH_SQL}`;

  // Sözlükler: URL path'lerini anlamlı sayfa başlığına çevirmek için içerik tablolarını çekiyoruz
  const newsRows = all('SELECT id, title, slug, category, views_count FROM news WHERE status = \'active\' ORDER BY views_count DESC');
  const annRows = all('SELECT id, title, slug, category, views_count FROM announcements WHERE status = \'active\' ORDER BY views_count DESC');
  const placeRows = all('SELECT id, name, slug, category, views_count FROM places WHERE status = \'active\' ORDER BY views_count DESC');
  const sightRows = all('SELECT id, title, slug, category, views_count FROM sightseeing WHERE status = \'active\' ORDER BY views_count DESC');
  const compRows = all('SELECT id, name, slug, category, views_count FROM companies WHERE status = \'active\' ORDER BY views_count DESC');

  const dailyToday = dailyViewsToday();
  const topNewsClicked = withViewsToday(newsRows, dailyToday.news).sort((a, b) => (b.views_today - a.views_today) || ((b.views_count || 0) - (a.views_count || 0))).slice(0, 8);
  const topAnnClicked = withViewsToday(annRows, dailyToday.announcements).sort((a, b) => (b.views_today - a.views_today) || ((b.views_count || 0) - (a.views_count || 0))).slice(0, 8);
  const topPlacesClicked = withViewsToday(placeRows, dailyToday.places).sort((a, b) => (b.views_today - a.views_today) || ((b.views_count || 0) - (a.views_count || 0))).slice(0, 8);
  const topSightsClicked = withViewsToday(sightRows, dailyToday.sightseeing).sort((a, b) => (b.views_today - a.views_today) || ((b.views_count || 0) - (a.views_count || 0))).slice(0, 8);
  const topCompaniesClicked = withViewsToday(compRows, dailyToday.companies).sort((a, b) => (b.views_today - a.views_today) || ((b.views_count || 0) - (a.views_count || 0))).slice(0, 8);

  const newsMap = new Map();
  newsRows.forEach(r => { if (r.slug) newsMap.set(r.slug, r.title); newsMap.set(String(r.id), r.title); });
  const annMap = new Map();
  annRows.forEach(r => { if (r.slug) annMap.set(r.slug, r.title); annMap.set(String(r.id), r.title); });
  const placeMap = new Map();
  placeRows.forEach(r => { if (r.slug) placeMap.set(r.slug, r.name); placeMap.set(String(r.id), r.name); });
  const sightMap = new Map();
  sightRows.forEach(r => { if (r.slug) sightMap.set(r.slug, r.title); sightMap.set(String(r.id), r.title); });
  const compMap = new Map();
  compRows.forEach(r => { if (r.slug) compMap.set(r.slug, r.name); compMap.set(String(r.id), r.name); });

  const STATIC_PAGE_META = {
    '/': { title: 'Ana Sayfa', section: 'Ana Sayfa', icon: '🏠' },
    '/haberler': { title: 'Haberler Listesi', section: 'Haberler', icon: '📰' },
    '/duyurular': { title: 'Duyuru & İlanlar', section: 'Duyurular', icon: '📢' },
    '/etkinlikler': { title: 'Etkinlikler Takvimi', section: 'Etkinlikler', icon: '🎉' },
    '/ulasim': { title: 'Ulaşım & Sefer Saatleri', section: 'Ulaşım & Seferler', icon: '🚌' },
    '/mekanlar': { title: 'Mekanlar Rehberi', section: 'Mekanlar', icon: '📍' },
    '/gezilecek-yerler': { title: 'Gezilecek Yerler', section: 'Gezilecek Yerler', icon: '🧳' },
    '/rehber': { title: 'Firma Rehberi', section: 'Firma Rehberi', icon: '🏢' },
    '/sizlerden-gelen': { title: 'Sizlerden Gelen Fotoğraflar', section: 'Fotoğraflar', icon: '📸' },
    '/deniz-durumu': { title: 'Deniz & Hava Durumu', section: 'Deniz Durumu', icon: '🌊' },
    '/iletisim': { title: 'İletişim & Bize Ulaşın', section: 'İletişim', icon: '✉️' },
    '/hakkinda': { title: 'Çınarcık Hakkında', section: 'Hakkında', icon: 'ℹ️' },
    '/ilan-ver': { title: 'Ücretsiz İlan / Duyuru Ver', section: 'Duyurular', icon: '➕' },
    '/kaydettiklerim': { title: 'Kaydettiklerim (Favoriler)', section: 'Favoriler', icon: '★' },
    '/gizlilik': { title: 'Gizlilik Politikası', section: 'Diğer', icon: '🔒' }
  };

  function resolvePageMeta(rawPath) {
    const p = (rawPath || '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (STATIC_PAGE_META[p]) return Object.assign({ path: p }, STATIC_PAGE_META[p]);
    let m;
    if ((m = p.match(/^\/haber\/([^/]+)$/))) {
      const key = decodeURIComponent(m[1]);
      const t = newsMap.get(key);
      return { path: p, title: t ? t : ('Haber: ' + key.replace(/-/g, ' ')), section: 'Haberler', icon: '📰' };
    }
    if ((m = p.match(/^\/duyuru\/([^/]+)$/))) {
      const key = decodeURIComponent(m[1]);
      const t = annMap.get(key);
      return { path: p, title: t ? t : ('Duyuru: ' + key.replace(/-/g, ' ')), section: 'Duyurular', icon: '📢' };
    }
    if ((m = p.match(/^\/mekan\/([^/]+)$/))) {
      const key = decodeURIComponent(m[1]);
      const t = placeMap.get(key);
      return { path: p, title: t ? t : ('Mekan: ' + key.replace(/-/g, ' ')), section: 'Mekanlar', icon: '📍' };
    }
    if ((m = p.match(/^\/gezilecek-yer\/([^/]+)$/))) {
      const key = decodeURIComponent(m[1]);
      const t = sightMap.get(key);
      return { path: p, title: t ? t : ('Gezilecek Yer: ' + key.replace(/-/g, ' ')), section: 'Gezilecek Yerler', icon: '🧳' };
    }
    if ((m = p.match(/^\/rehber\/([^/]+)$/))) {
      const key = decodeURIComponent(m[1]);
      const t = compMap.get(key);
      return { path: p, title: t ? t : ('Firma: ' + key.replace(/-/g, ' ')), section: 'Firma Rehberi', icon: '🏢' };
    }
    return { path: p, title: p, section: 'Diğer', icon: '📄' };
  }

  function parseDeviceAndBrowser(ua) {
    const s = ua || '';
    let device = 'Masaüstü', deviceIcon = '💻';
    if (/iPad|Tablet|PlayBook|Silk/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) {
      device = 'Tablet'; deviceIcon = '📲';
    } else if (/iPhone|iPod/i.test(s)) {
      device = 'iPhone'; deviceIcon = '📱';
    } else if (/Android/i.test(s)) {
      device = 'Android'; deviceIcon = '📱';
    } else if (/Mobile|IEMobile|Opera Mini/i.test(s)) {
      device = 'Mobil'; deviceIcon = '📱';
    } else if (/Macintosh|Mac OS X/i.test(s)) {
      device = 'Mac'; deviceIcon = '💻';
    } else if (/Windows/i.test(s)) {
      device = 'Windows'; deviceIcon = '💻';
    } else if (/Linux/i.test(s)) {
      device = 'Linux'; deviceIcon = '💻';
    }
    let browser = 'Tarayıcı';
    if (/Edg\//i.test(s)) browser = 'Edge';
    else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
    else if (/SamsungBrowser/i.test(s)) browser = 'Samsung';
    else if (/Chrome\/|CriOS/i.test(s)) browser = 'Chrome';
    else if (/Firefox\/|FxiOS/i.test(s)) browser = 'Firefox';
    else if (/Safari\//i.test(s)) browser = 'Safari';
    const isMobile = (device === 'iPhone' || device === 'Android' || device === 'Mobil');
    return { device, browser, deviceIcon, isMobile, label: `${deviceIcon} ${device} · ${browser}` };
  }

  function classifyReferrer(ref) {
    if (!ref || !ref.trim()) return { category: 'Direkt Giriş', label: 'Direkt (Adres Çubuğu / Yer İmi)', icon: '🎯' };
    try {
      const u = new URL(ref);
      const h = u.hostname.toLowerCase();
      if (h.includes('marmaraninincisi.com') || h.includes('localhost') || h.includes('127.0.0.1')) {
        return { category: 'Site İçi Gezinme', label: 'Site İçi (' + (u.pathname || '/') + ')', icon: '🔄' };
      }
      if (/google\.|bing\.|yandex\.|duckduckgo\.|yahoo\./.test(h)) {
        return { category: 'Arama Motoru (Google vb.)', label: h.replace(/^www\./, ''), icon: '🔍' };
      }
      if (/instagram\.|facebook\.|fb\.|t\.co|twitter\.|x\.com|whatsapp\.|youtube\.|tiktok\.|linkedin\./.test(h)) {
        return { category: 'Sosyal Medya & WhatsApp', label: h.replace(/^www\./, ''), icon: '📲' };
      }
      return { category: 'Diğer Siteler', label: h.replace(/^www\./, ''), icon: '🌐' };
    } catch {
      return { category: 'Diğer Siteler', label: ref.slice(0, 40), icon: '🌐' };
    }
  }

  const statRange = (since, until) => {
    const r = until
      ? get(`SELECT COUNT(*) AS views, COUNT(DISTINCT ip) AS uniques FROM page_views WHERE created_at >= ? AND created_at < ? AND ${HUMAN_WHERE}`, [since, until])
      : get(`SELECT COUNT(*) AS views, COUNT(DISTINCT ip) AS uniques FROM page_views WHERE created_at >= ? AND ${HUMAN_WHERE}`, [since]);
    return { views: (r && r.views) || 0, uniques: (r && r.uniques) || 0 };
  };

  const today = statRange(dayStart);
  const yesterday = statRange(yesterdayStart, dayStart);
  const week = statRange(d7);
  const month = statRange(d30);
  const totals = get(`SELECT COUNT(*) AS total, COUNT(DISTINCT ip) AS totalUniques FROM page_views WHERE ${HUMAN_WHERE}`) || { total: 0, totalUniques: 0 };
  const rawAllTotals = get('SELECT COUNT(*) AS rawTotal FROM page_views') || { rawTotal: 0 };
  const filteredBotCount = Math.max(0, (rawAllTotals.rawTotal || 0) - (totals.total || 0));

  today.yesterdayViews = yesterday.views;
  today.diffPct = yesterday.views > 0 ? Math.round(((today.views - yesterday.views) / yesterday.views) * 100) : null;
  week.avgDaily = Math.round((week.views || 0) / 7);
  month.avgDaily = Math.round((month.views || 0) / 30);

  const queryTopPages = (since) => {
    const rows = since
      ? all(`SELECT path, COUNT(*) AS views, COUNT(DISTINCT ip) AS uniques FROM page_views WHERE created_at >= ? AND ${HUMAN_WHERE} GROUP BY path ORDER BY views DESC LIMIT 20`, [since])
      : all(`SELECT path, COUNT(*) AS views, COUNT(DISTINCT ip) AS uniques FROM page_views WHERE ${HUMAN_WHERE} GROUP BY path ORDER BY views DESC LIMIT 20`);
    const sumViews = rows.reduce((s, r) => s + (r.views || 0), 0) || 1;
    return rows.map((r, idx) => {
      const meta = resolvePageMeta(r.path);
      return {
        rank: idx + 1,
        path: r.path,
        title: meta.title,
        section: meta.section,
        icon: meta.icon,
        views: r.views || 0,
        uniques: r.uniques || 0,
        pct: Math.max(2, Math.round(((r.views || 0) / sumViews) * 100))
      };
    });
  };

  const topPagesByPeriod = {
    today: queryTopPages(dayStart),
    week: queryTopPages(d7),
    month: queryTopPages(d30),
    total: queryTopPages(null)
  };

  // Son 30 günlük gerçek ziyaretçi kayıtları üzerinden Bölüm Popülerliği, Cihaz, Trafik Kaynağı ve Yoğun Saat analizi
  const humanRows30d = all(`SELECT path, ip, user_agent, referrer, created_at FROM page_views WHERE created_at >= ? AND ${HUMAN_WHERE} ORDER BY id DESC`, [d30]);

  const sectionCounts = new Map();
  let mobileCount = 0, desktopCount = 0, tabletCount = 0;
  const browserCounts = new Map();
  const refCounts = new Map([
    ['Direkt Giriş', { label: 'Direkt Giriş (Adres / Yer İmi)', icon: '🎯', count: 0 }],
    ['Arama Motoru (Google vb.)', { label: 'Google & Arama Motorları', icon: '🔍', count: 0 }],
    ['Sosyal Medya & WhatsApp', { label: 'Sosyal Medya & WhatsApp', icon: '📲', count: 0 }],
    ['Site İçi Gezinme', { label: 'Site İçi Tıklamalar (Sayfalar Arası)', icon: '🔄', count: 0 }],
    ['Diğer Siteler', { label: 'Diğer Referans Siteler', icon: '🌐', count: 0 }]
  ]);
  const hourBuckets = new Array(24).fill(0);

  humanRows30d.forEach(r => {
    const meta = resolvePageMeta(r.path);
    const secKey = meta.section || 'Diğer';
    if (!sectionCounts.has(secKey)) {
      sectionCounts.set(secKey, { section: secKey, icon: meta.icon, views: 0, ips: new Set() });
    }
    const secObj = sectionCounts.get(secKey);
    secObj.views++;
    if (r.ip) secObj.ips.add(r.ip);

    const dev = parseDeviceAndBrowser(r.user_agent);
    if (dev.device === 'Tablet') tabletCount++;
    else if (dev.isMobile) mobileCount++;
    else desktopCount++;
    browserCounts.set(dev.browser, (browserCounts.get(dev.browser) || 0) + 1);

    const refInfo = classifyReferrer(r.referrer);
    const refEntry = refCounts.get(refInfo.category);
    if (refEntry) refEntry.count++;

    if (r.created_at) {
      const dt = new Date(r.created_at.replace(' ', 'T') + 'Z');
      if (!isNaN(dt.getTime())) {
        const trHour = new Date(dt.getTime() + TRT_OFFSET_MS).getUTCHours();
        if (trHour >= 0 && trHour < 24) hourBuckets[trHour]++;
      }
    }
  });

  const total30dAnalyzed = humanRows30d.length || 1;
  const sectionBreakdown = Array.from(sectionCounts.values())
    .map(s => ({
      section: s.section,
      icon: s.icon,
      views: s.views,
      uniques: s.ips.size,
      pct: Math.round((s.views / total30dAnalyzed) * 100)
    }))
    .sort((a, b) => b.views - a.views);

  const deviceBreakdown = {
    mobile: { count: mobileCount, pct: Math.round((mobileCount / total30dAnalyzed) * 100) },
    desktop: { count: desktopCount, pct: Math.round((desktopCount / total30dAnalyzed) * 100) },
    tablet: { count: tabletCount, pct: Math.round((tabletCount / total30dAnalyzed) * 100) },
    topBrowsers: Array.from(browserCounts.entries())
      .map(([name, count]) => ({ name, count, pct: Math.round((count / total30dAnalyzed) * 100) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  };

  const trafficSources = Array.from(refCounts.values())
    .map(x => ({ label: x.label, icon: x.icon, count: x.count, pct: Math.round((x.count / total30dAnalyzed) * 100) }))
    .sort((a, b) => b.count - a.count);

  let peakHour = 20, peakHourViews = 0;
  hourBuckets.forEach((cnt, hr) => {
    if (cnt > peakHourViews) { peakHourViews = cnt; peakHour = hr; }
  });
  const pad2 = (n) => String(n).padStart(2, '0');
  const peakHourLabel = `${pad2(peakHour)}:00 - ${pad2((peakHour + 1) % 24)}:00`;

  // 1) Bugün (Saatlik 00:00 - 23:00 TR)
  const todayHourlyRows = all(`SELECT strftime('%H', datetime(created_at, '+3 hours')) AS hr, COUNT(*) AS views, COUNT(DISTINCT ip) AS uniques
    FROM page_views WHERE created_at >= ? AND ${HUMAN_WHERE} GROUP BY hr ORDER BY hr ASC`, [dayStart]);
  const todayHourMap = {};
  todayHourlyRows.forEach(r => { todayHourMap[r.hr] = r; });
  const todayLabels = [], todayViewsSeries = [], todayUniquesSeries = [];
  for (let h = 0; h < 24; h++) {
    const hk = pad2(h);
    todayLabels.push(hk + ':00');
    todayViewsSeries.push((todayHourMap[hk] && todayHourMap[hk].views) || 0);
    todayUniquesSeries.push((todayHourMap[hk] && todayHourMap[hk].uniques) || 0);
  }

  // 2) Tüm Zamanlar / Son 30 Gün / Son 7 Gün (Günlük TR — Türkçe Tarih Etiketli ve İlk Kayıt Gününden Başlayan)
  const TR_SHORT_MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
  const fmtTrDayLabel = (yyyyMmDd) => {
    if (!yyyyMmDd || yyyyMmDd.length < 10) return yyyyMmDd;
    const mIdx = parseInt(yyyyMmDd.slice(5, 7), 10) - 1;
    const dNum = parseInt(yyyyMmDd.slice(8, 10), 10);
    return dNum + ' ' + (TR_SHORT_MONTHS[mIdx] || yyyyMmDd.slice(5, 7));
  };

  const allDailyRows = all(`SELECT date(created_at, '+3 hours') AS day, COUNT(*) AS views, COUNT(DISTINCT ip) AS uniques
    FROM page_views WHERE ${HUMAN_WHERE} GROUP BY day ORDER BY day ASC`);
  const dailyMap = {};
  allDailyRows.forEach(r => { if (r.day) dailyMap[r.day] = r; });

  const todayStr = new Date(now.getTime() + TRT_OFFSET_MS).toISOString().slice(0, 10);
  const todayMs = new Date(todayStr + 'T00:00:00Z').getTime();
  const firstDayStr = allDailyRows.length > 0 ? allDailyRows[0].day : todayStr;
  const firstMs = new Date(firstDayStr + 'T00:00:00Z').getTime();
  const daysSinceFirstRecord = Math.max(1, Math.min(365, Math.round((todayMs - firstMs) / (24 * 3600 * 1000)) + 1));

  // Son 30 gün ortalamasını gerçek kayıt tutulan gün sayısına (en fazla 30) bölerek hesapla
  const activeMonthDays = Math.max(1, Math.min(30, daysSinceFirstRecord));
  month.avgDaily = Math.round((month.views || 0) / activeMonthDays);

  const weekSpan = Math.min(7, daysSinceFirstRecord);
  const weekLabels = [], weekViewsSeries = [], weekUniquesSeries = [];
  for (let i = weekSpan - 1; i >= 0; i--) {
    const key = new Date(todayMs - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    weekLabels.push(fmtTrDayLabel(key));
    weekViewsSeries.push((dailyMap[key] && dailyMap[key].views) || 0);
    weekUniquesSeries.push((dailyMap[key] && dailyMap[key].uniques) || 0);
  }

  // Son 30 gün grafiği: Kayıtlar 30 günden daha yeni başladıysa (ör. 18 Ekim), boş 0 günlerini göstermeyip ilk kayıt gününden başlar
  const monthSpan = Math.min(30, daysSinceFirstRecord);
  const labels = [], viewsSeries = [], uniquesSeries = [];
  for (let i = monthSpan - 1; i >= 0; i--) {
    const key = new Date(todayMs - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    labels.push(fmtTrDayLabel(key));
    viewsSeries.push((dailyMap[key] && dailyMap[key].views) || 0);
    uniquesSeries.push((dailyMap[key] && dailyMap[key].uniques) || 0);
  }

  const totalLabels = [], totalViewsSeries = [], totalUniquesSeries = [];
  for (let i = daysSinceFirstRecord - 1; i >= 0; i--) {
    const key = new Date(todayMs - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    totalLabels.push(fmtTrDayLabel(key));
    totalViewsSeries.push((dailyMap[key] && dailyMap[key].views) || 0);
    totalUniquesSeries.push((dailyMap[key] && dailyMap[key].uniques) || 0);
  }

  const chartDataByPeriod = {
    today: {
      title: 'Bugünkü Saatlik Gerçek Ziyaretçi Grafiği (00:00 - 23:00)',
      subtitle: 'Bugün saat bazında gerçekleşen sayfa görüntülenme ve tekil ziyaretçi (IP) dağılımı',
      labels: todayLabels,
      views: todayViewsSeries,
      uniques: todayUniquesSeries
    },
    week: {
      title: 'Haftalık (Son 7 Gün) Gerçek Ziyaretçi Grafiği',
      subtitle: 'Son 7 günün günlük gerçek sayfa görüntülenme ve tekil ziyaretçi (IP) eğrisi',
      labels: weekLabels,
      views: weekViewsSeries,
      uniques: weekUniquesSeries
    },
    month: {
      title: 'Son 30 Günlük Gerçek Ziyaretçi Grafiği (Botlar Hariç)',
      subtitle: 'Son 30 günün günlük gerçek sayfa görüntülenme ve tekil ziyaretçi (IP) eğrisi',
      labels,
      views: viewsSeries,
      uniques: uniquesSeries
    },
    total: {
      title: 'Tüm Zamanlar Gerçek Ziyaretçi Grafiği (Botlar Hariç)',
      subtitle: 'İlk kayıttan bugüne günlük gerçek sayfa görüntülenme ve tekil ziyaretçi (IP) eğrisi',
      labels: totalLabels,
      views: totalViewsSeries,
      uniques: totalUniquesSeries
    }
  };

  // Son gerçek ziyaretçiler (botlar ve arka plan istekleri hariç)
  const recent = all(`SELECT id, path, ip, user_agent, referrer, datetime(created_at, '+3 hours') AS tr_time
    FROM page_views WHERE ${HUMAN_WHERE} ORDER BY id DESC LIMIT 120`)
    .map(r => {
      const meta = resolvePageMeta(r.path);
      const dev = parseDeviceAndBrowser(r.user_agent);
      const ref = classifyReferrer(r.referrer);
      return {
        tr_time: r.tr_time || '',
        path: r.path,
        pageTitle: meta.title,
        pageIcon: meta.icon,
        pageSection: meta.section,
        ip: r.ip,
        deviceLabel: dev.label,
        deviceType: dev.device === 'Tablet' ? 'tablet' : (dev.isMobile ? 'mobile' : 'desktop'),
        refLabel: ref.label,
        refIcon: ref.icon,
        refCategory: ref.category
      };
    });

  // Ziyaretçileri IP bazında gruplayarak aynı kişinin hangi sayfaları gezdiğini tek satırda özetle
  const ipGroupMap = new Map();
  recent.forEach(v => {
    const key = v.ip || 'unknown';
    if (!ipGroupMap.has(key)) {
      ipGroupMap.set(key, {
        ip: key,
        lastSeen: v.tr_time,
        firstSeen: v.tr_time,
        deviceLabel: v.deviceLabel,
        deviceType: v.deviceType,
        refLabel: v.refLabel,
        refIcon: v.refIcon,
        totalClicks: 0,
        sections: new Set(),
        pages: []
      });
    }
    const grp = ipGroupMap.get(key);
    grp.firstSeen = v.tr_time;
    grp.totalClicks++;
    if (v.pageSection) grp.sections.add(v.pageSection);
    // Dış kaynak varsa (Site İçi değilse) giriş kaynağı olarak onu tercih et
    if (v.refCategory !== 'Site İçi Gezinme') {
      grp.refLabel = v.refLabel;
      grp.refIcon = v.refIcon;
    }
    grp.pages.push({
      tr_time: v.tr_time,
      path: v.path,
      pageTitle: v.pageTitle,
      pageIcon: v.pageIcon,
      pageSection: v.pageSection
    });
  });
  const recentGrouped = Array.from(ipGroupMap.values()).map(g => ({
    ip: g.ip,
    lastSeen: g.lastSeen,
    firstSeen: g.firstSeen,
    deviceLabel: g.deviceLabel,
    deviceType: g.deviceType,
    refLabel: g.refLabel,
    refIcon: g.refIcon,
    totalClicks: g.totalClicks,
    sectionsStr: Array.from(g.sections).join('|'),
    pages: g.pages
  }));

  res.render('admin/raporlar', {
    today,
    week,
    month,
    totalViews: totals.total || 0,
    totalUniques: totals.totalUniques || 0,
    filteredBotCount,
    topPages: topPagesByPeriod.month,
    topPagesByPeriod,
    sectionBreakdown,
    topClicked: {
      news: topNewsClicked,
      announcements: topAnnClicked,
      places: topPlacesClicked,
      sightseeing: topSightsClicked,
      companies: topCompaniesClicked
    },
    deviceBreakdown,
    trafficSources,
    hourBuckets,
    peakHourLabel,
    peakHourViews,
    recent,
    recentGrouped,
    chartData: { labels, views: viewsSeries, uniques: uniquesSeries },
    chartDataByPeriod
  });
});

app.get('/admin/firma-ekle', isAuthenticated, (req, res) => {
  const { get } = require('./db');
  const edit = req.query.edit ? get('SELECT * FROM companies WHERE id = ?', [req.query.edit]) : null;
  res.render('admin/company-form', { edit, error: null });
});

app.post('/admin/firma-ekle', isAuthenticated, function(req, res, next) {
  withUpload(upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'gallery_images', maxCount: 10 }
  ]))(req, res, function(err) {
    if (err) {
      const edit = req.body && req.body.edit_id ? require('./db').get('SELECT * FROM companies WHERE id = ?', [req.body.edit_id]) : null;
      return res.render('admin/company-form', { edit, error: 'Görsel yüklenemedi.' });
    }
    next();
  });
}, (req, res) => {
  const { run, get, slugify, ensureUniqueSlug } = require('./db');
  const { name, category, sector, address, phone, website, email, working_hours, map_link, map_embed, google_reviews_url, description, status, is_featured, sort_order, edit_id } = req.body;
  const mapEmbedVal = String(map_embed || '').trim();

  let logo_url = (req.files && req.files.logo && req.files.logo[0]) ? pubUrl(req.files.logo[0]) : '';

  let galleryArr = [];
  if (req.body.existing_gallery) {
    let existingRaw = req.body.existing_gallery;
    if (typeof existingRaw === 'string') {
      try {
        const parsed = JSON.parse(existingRaw);
        if (Array.isArray(parsed)) galleryArr = parsed;
        else galleryArr = [existingRaw];
      } catch (e) {
        galleryArr = [existingRaw];
      }
    } else if (Array.isArray(existingRaw)) {
      galleryArr = existingRaw.slice();
    }
  }
  const newUrls = (req.files && req.files.gallery_images && Array.isArray(req.files.gallery_images))
    ? req.files.gallery_images.map(f => pubUrl(f))
    : [];
  galleryArr = applyGalleryOrder(req, galleryArr, newUrls);

  if (!name || !category) {
    const edit = edit_id ? get('SELECT * FROM companies WHERE id = ?', [edit_id]) : null;
    return res.render('admin/company-form', { edit, error: 'Firma adı ve kategori zorunludur' });
  }

  const features = req.body.features ? (Array.isArray(req.body.features) ? req.body.features : [req.body.features]) : [];
  const statusVal = status === 'passive' ? 'passive' : 'active';
  const isFeatured = is_featured ? 1 : 0;

    if (edit_id) {
    const existing = get('SELECT * FROM companies WHERE id = ?', [edit_id]);
    if (existing && !logo_url) logo_url = existing.logo_url || '';
    let slug = existing.slug;
    if (existing.name !== name) {
      slug = ensureUniqueSlug(slugify(name), parseInt(edit_id), 'companies');
    }
    run(`UPDATE companies SET name=?, slug=?, category=?, sector=?, address=?, phone=?, website=?, email=?, working_hours=?, map_link=?, map_embed=?, google_reviews_url=?, description=?, logo_url=?, gallery_images=?, features=?, is_featured=?, status=?, sort_order=? WHERE id=?`,
      [name, slug, category || 'Genel', sector || '', address || '', phone || '', website || '', email || '', working_hours || '', map_link || '', mapEmbedVal, google_reviews_url || '', description || '', logo_url, JSON.stringify(galleryArr), JSON.stringify(features), isFeatured, statusVal, parseInt(sort_order) || 0, edit_id]);
    deleteReplacedMedia([existing.logo_url], [logo_url].concat(galleryArr));
    deleteReplacedMedia(galleryJsonUrls(existing.gallery_images), galleryArr);
    pingIndexNow('/rehber/' + (slug || edit_id));
    flash(res, '/admin/firmalar', 'Güncellendi: ' + name);
  } else {
    const slug = ensureUniqueSlug(slugify(name), null, 'companies');
    run(`INSERT INTO companies (name, slug, category, sector, address, phone, website, email, working_hours, map_link, map_embed, google_reviews_url, description, logo_url, gallery_images, features, is_featured, status, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, slug, category || 'Genel', sector || '', address || '', phone || '', website || '', email || '', working_hours || '', map_link || '', mapEmbedVal, google_reviews_url || '', description || '', logo_url, JSON.stringify(galleryArr), JSON.stringify(features), isFeatured, statusVal, parseInt(sort_order) || 0]);
    pingIndexNow('/rehber/' + slug);
    flash(res, '/admin/firmalar', 'Eklendi: ' + name);
  }
});

app.post('/admin/firma-sil/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT name, logo_url FROM companies WHERE id = ?', [req.params.id]);
  if (item) deleteUploadedMedia(item.logo_url);
  run('DELETE FROM companies WHERE id = ?', [req.params.id]);
  flash(res, '/admin/firmalar', 'Silindi: ' + ((item && item.name) || '#' + req.params.id));
});

app.post('/admin/firma-toggle/:id', isAuthenticated, (req, res) => {
  const { get, run } = require('./db');
  const item = get('SELECT * FROM companies WHERE id = ?', [req.params.id]);
  let next = 'active';
  if (item && item.id) {
    next = item.status === 'active' ? 'passive' : 'active';
    run("UPDATE companies SET status = ? WHERE id = ?", [next, item.id]);
  }
  flash(res, '/admin/firmalar',
    ((item && item.name) || '#' + req.params.id) + (next === 'active' ? ' yayına alındı' : ' pasife alındı'),
    next === 'active' ? 'success' : 'info');
});

// Firma görüntülenme sıfırlama (toplu + satır bazlı)
app.post('/admin/firmalar/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const total = get('SELECT COALESCE(SUM(views_count), 0) AS t FROM companies').t || 0;
  run("UPDATE companies SET views_count = 0, views_reset_at = datetime('now')");
  const daily = clearDailyViews('companies', null);
  console.log(`[admin] Firma görüntülenmeleri sıfırlandı (toplam ${total}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  let back = '/admin?tab=companies';
  try {
    const ref = new URL(req.get('Referer') || '', 'http://localhost');
    if (ref.host === req.get('host')) back = ref.pathname + ref.search;
  } catch (e) {}
  flash(res, back, 'Görüntülenme sayaçları sıfırlandı (' + total + ')', 'info');
});

app.post('/admin/firmalar/:id/goruntulenme-sifirla', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const item = get('SELECT * FROM companies WHERE id = ?', [req.params.id]);
  if (item && item.id) {
    const prev = Number(item.views_count) || 0;
    run("UPDATE companies SET views_count = 0, views_reset_at = datetime('now') WHERE id = ?", [item.id]);
    const daily = clearDailyViews('companies', [item.slug, item.id]);
    console.log(`[admin] Firma görüntülenmesi sıfırlandı: "${item.name}" (${prev}, bugün ${daily}) - ${req.session.adminUser || 'admin'}`);
  }
  let back = '/admin/firmalar';
  try {
    const ref = new URL(req.get('Referer') || '', 'http://localhost');
    if (ref.host === req.get('host')) back = ref.pathname + ref.search;
  } catch (e) {}
  flash(res, back, 'Görüntülenme sıfırlandı: ' + ((item && item.name) || '#' + req.params.id), 'info');
});

// ==================== GOOGLE OAuth & YORUM SİSTEMİ ====================

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// redirect_uri istek host'undan dinamik üretilir: istek localhost'a gelirse
// http://localhost:3000, canlı domain'e gelirse SITE_URL (veya localhost OLMAYAN
// GOOGLE_CALLBACK_URL env override'ı) kullanılır.
// DİKKAT: Google Cloud Console → Authorized redirect URIs içinde şunlar ekli OLMALI:
//   http://localhost:3000/auth/google/callback   (lokal test)
//   https://marmaraninincisi.com/auth/google/callback  (canlı)
// Eski hata: .env'deki GOOGLE_CALLBACK_URL=localhost'a sabitti → canlıda Google
// girişi yapan herkes localhost:3000'e düşüyordu (ERR_CONNECTION_REFUSED).
function googleRedirectUri(req) {
  const host = String((req.get('host') || '')).toLowerCase().split(':')[0];
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000/auth/google/callback';
  }
  const envCb = process.env.GOOGLE_CALLBACK_URL;
  if (envCb && !envCb.includes('localhost')) return envCb.replace(/\/+$/, '');
  return (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/+$/, '') + '/auth/google/callback';
}

// Env değişken kontrolü
if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com') {
  console.warn('\x1b[33m⚠  GOOGLE_CLIENT_ID tanımlı değil veya geçersiz! Google OAuth çalışmaz.\x1b[0m');
  console.warn('   → .env dosyasına geçerli bir Client ID girin.');
} else {
  console.log('\x1b[32m✓ GOOGLE_CLIENT_ID yüklendi:\x1b[0m', GOOGLE_CLIENT_ID.substring(0, 20) + '...');
}
if (!GOOGLE_CLIENT_SECRET || GOOGLE_CLIENT_SECRET === 'YOUR_GOOGLE_CLIENT_SECRET') {
  console.warn('\x1b[33m⚠  GOOGLE_CLIENT_SECRET tanımlı değil veya geçersiz!\x1b[0m');
} else {
  console.log('\x1b[32m✓ GOOGLE_CLIENT_SECRET yüklendi.\x1b[0m');
}
console.log('\x1b[36m→ Google callback (dinamik):\x1b[0m');
console.log('   lokal : http://localhost:3000/auth/google/callback');
console.log('   canlı : ' + (process.env.GOOGLE_CALLBACK_URL && !process.env.GOOGLE_CALLBACK_URL.includes('localhost')
  ? process.env.GOOGLE_CALLBACK_URL
  : (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/+$/, '') + '/auth/google/callback'));

// (Eski statik callback-host doğrulaması kaldırıldı — redirect_uri artık isteğe göre dinamik.)

// Auth config endpoint
app.get('/api/auth/config', (req, res) => {
  res.json({ 
    clientId: GOOGLE_CLIENT_ID,
    isAuthenticated: req.session.isGoogleAuth || false,
    user: req.session.googleUser || null
  });
});

// Güvenli geri dönüş yolu (open redirect engeli)
function safeReturnPath(p) {
  if (typeof p !== 'string') return null;
  const v = p.trim();
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return null;
  return v;
}

// Google OAuth giriş başlatma
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com') {
    return res.redirect('/auth/error?type=client_id_missing');
  }
  const returnTo = safeReturnPath(req.query.return);
  if (returnTo) req.session.returnTo = returnTo;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Google OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  
  if (error) {
    console.error('Google OAuth hata:', error);
    return res.redirect('/auth/error?type=' + encodeURIComponent(error));
  }
  
  if (!code) {
    return res.redirect('/auth/error?type=no_code');
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code'
      })
    });
    
    const tokenData = await tokenResponse.json();
    
    if (tokenData.error) {
      console.error('Token hatası:', tokenData.error, tokenData.error_description);
      console.error('Gönderilen parametreler: client_id=' + GOOGLE_CLIENT_ID.substring(0, 15) + '..., redirect_uri=' + googleRedirectUri(req));
      return res.redirect('/auth/error?type=' + encodeURIComponent(tokenData.error) + '&desc=' + encodeURIComponent(tokenData.error_description || ''));
    }
    
    if (!tokenData.id_token) {
      console.error('Token yanıtında id_token yok:', tokenData);
      return res.redirect('/auth/error?type=token_failed');
    }

    const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64url').toString());
    
    if (!payload.email || !payload.email.endsWith('@gmail.com')) {
      return res.redirect('/auth/error?type=not_gmail');
    }

    req.session.isGoogleAuth = true;
    req.session.googleUser = {
      name: payload.name || payload.given_name || 'Kullanıcı',
      email: payload.email,
      avatar: payload.picture || ''
    };

    const returnTo = req.session.returnTo;
    req.session.returnTo = null;
    res.redirect(returnTo || '/haberler');
  } catch (error) {
    console.error('Google OAuth hatası:', error.message || error);
    res.redirect('/auth/error?type=auth_error');
  }
});

// Google çıkış
app.get('/auth/google/logout', (req, res) => {
  req.session.isGoogleAuth = false;
  req.session.googleUser = null;
  res.redirect(safeReturnPath(req.query.return) || '/');
});

// OAuth hata sayfası
app.get('/auth/error', (req, res) => {
  const error = req.query.type || 'unknown';
  const messages = {
    'client_id_missing': 'Google OAuth yapılandırması eksik. Lütfen yöneticiyle iletişime geçin.',
    'invalid_client': 'Google OAuth istemcisi bulunamadı. Client ID geçersiz.',
    'access_denied': 'Giriş işlemi iptal edildi.',
    'not_gmail': 'Sadece @gmail.com adresleri ile giriş yapabilirsiniz.',
    'token_failed': 'Token alınamadı. Lütfen tekrar deneyin.',
    'auth_error': 'Kimlik doğrulama hatası. Lütfen tekrar deneyin.',
    'no_code': 'Doğrulama kodu alınamadı.',
    'unknown': 'Bilinmeyen bir hata oluştu.'
  };
  res.render('error', {
    title: 'Giriş Hatası',
    message: messages[error] || messages['unknown'],
    error: error
  });
});

// API: Mevcut kullanıcı bilgisi
app.get('/api/auth/me', (req, res) => {
  if (req.session.isGoogleAuth && req.session.googleUser) {
    res.json({ success: true, user: req.session.googleUser });
  } else {
    res.json({ success: false, user: null });
  }
});

// Onaylanmış yorumları getir
app.get('/api/comments/:newsId', (req, res) => {
  const { all } = require('./db');
  const comments = all("SELECT id, user_name, user_avatar, content, created_at, likes_count FROM comments WHERE news_id = ? AND status = 'approved' ORDER BY likes_count DESC, created_at DESC", [req.params.newsId]);
  res.json({ success: true, comments });
});

// Yorum beğeni toggle (anonim; localStorage tekil, sunucu sadece count tutar)
app.post('/api/comments/:id/like', likeLimiter, (req, res) => {
  const { run, get } = require('./db');
  const comment = get('SELECT id, likes_count FROM comments WHERE id = ?', [req.params.id]);
  if (!comment.id) return res.status(404).json({ success: false, error: 'Yorum bulunamadı' });
  const liked = !!req.body.liked;
  const next = Math.max(0, (Number(comment.likes_count) || 0) + (liked ? 1 : -1));
  run('UPDATE comments SET likes_count = ? WHERE id = ?', [next, req.params.id]);
  res.json({ success: true, likes: next });
});

// "Sizlerden Gelen" fotoğraf görüntülenme sayacı (lightbox açılışında 1 kez)
app.post('/api/foto-gor/:id', (req, res) => {
  const { get, run } = require('./db');
  const p = get("SELECT id FROM photo_submissions WHERE id = ? AND status = 'active'", [req.params.id]);
  if (!p.id) return res.status(404).json({ success: false, error: 'Fotoğraf bulunamadı' });
  if (!isBotRequest(req)) {
    run('UPDATE photo_submissions SET views_count = views_count + 1 WHERE id = ?', [p.id]);
    logPageView({
      path: '/api/foto-gor/' + p.id,
      method: 'POST',
      status: 200,
      ip: req.ip,
      user_agent: req.headers['user-agent'] || '',
      referrer: req.headers.referer || req.headers.referrer || ''
    });
  }
  res.json({ success: true });
});

// ---- Ana sayfa anketi ----
// Oy verme POST'larında basit CSRF koruması (admin '/admin' korumasının public kopyası)
function pollOriginOk(req) {
  const source = req.headers.origin || req.headers.referer;
  if (!source) return true;
  try { return new URL(source).host === req.headers.host; } catch (e) { return false; }
}
// voter_key: httpOnly poll_uid cookie'si (1 yıl). Yoksa üretip Response'a basar.
function pollVoterKey(req, res) {
  let key = getCookie(req, 'poll_uid');
  if (!key || key.length < 10) {
    key = crypto.randomBytes(16).toString('hex');
    res.cookie('poll_uid', key, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000 });
  }
  return key;
}
// Anket sonuçları: seçenekler + adet + yüzde (sesiz secenekler 0 sayar)
function pollResults(pollId) {
  const { all } = require('./db');
  const opts = all('SELECT id, label, position FROM poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC', [pollId]);
  const counts = all('SELECT option_id, COUNT(*) AS cnt FROM poll_votes WHERE poll_id = ? GROUP BY option_id', [pollId]);
  const byOpt = {};
  let total = 0;
  (counts || []).forEach(c => { byOpt[c.option_id] = Number(c.cnt) || 0; total += Number(c.cnt) || 0; });
  const options = (opts || []).map(o => {
    const cnt = byOpt[o.id] || 0;
    return { id: o.id, label: o.label, count: cnt, pct: total > 0 ? Math.round(cnt * 100 / total) : 0 };
  });
  return { pollId, total, options };
}

// Ana sayfada aktif anket verisi (sonuçlar gizli: yalnızca soru + seçenekler)
app.get('/api/poll-aktif', (req, res) => {
  const { get, all } = require('./db');
  const poll = get("SELECT id, question FROM polls WHERE status = 'active' ORDER BY created_at DESC LIMIT 1");
  if (!poll.id) return res.json({ success: true, poll: null });
  const opts = all('SELECT id, label FROM poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC', [poll.id]);
  res.json({ success: true, poll: { id: poll.id, question: poll.question, options: opts || [] } });
});

// Oy kullanma: tek seçim, kullanıcı başına 1 oy (poll_uid cookie + UNIQUE(poll_id, voter_key))
app.post('/api/poll/oy', async (req, res) => {
  const { get, run } = require('./db');
  if (!pollOriginOk(req)) return res.status(403).json({ success: false, error: 'Geçersiz istek kaynağı' });
  const poll = get("SELECT id, question FROM polls WHERE status = 'active' ORDER BY created_at DESC LIMIT 1");
  if (!poll.id) return res.status(404).json({ success: false, error: 'Aktif anket yok' });
  const optionId = parseInt(String(req.body && req.body.optionId || '').replace(/\D/g, ''));
  const opt = get('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?', [optionId, poll.id]);
  if (!opt.id) return res.status(400).json({ success: false, error: 'Geçerli bir seçenek seçin' });
  const rcCheck = await verifyUserCaptcha(req);
  if (!rcCheck.ok) return res.status(400).json({ success: false, error: rcCheck.error });
  const voterKey = pollVoterKey(req, res);
  const existing = get('SELECT id, option_id FROM poll_votes WHERE poll_id = ? AND voter_key = ?', [poll.id, voterKey]);
  if (existing.id) {
    return res.json({ success: true, already: true, ...pollResults(poll.id), myOptionId: existing.option_id });
  }
  try {
    run("INSERT INTO poll_votes (poll_id, option_id, voter_key, created_at) VALUES (?, ?, ?, datetime('now'))", [poll.id, optionId, voterKey]);
  } catch (e) {
    if (String(e.message).indexOf('UNIQUE') >= 0) {
      const again = get('SELECT id, option_id FROM poll_votes WHERE poll_id = ? AND voter_key = ?', [poll.id, voterKey]);
      return res.json({ success: true, already: true, ...pollResults(poll.id), myOptionId: (again && again.option_id) || optionId });
    }
    return res.status(500).json({ success: false, error: 'Oy kaydedilemedi' });
  }
  logPageView({ path: '/api/poll/oy', method: 'POST', status: 200, ip: req.ip, user_agent: req.headers['user-agent'] || '', referrer: req.headers.referer || '' });
  res.json({ success: true, already: false, ...pollResults(poll.id), myOptionId: optionId });
});

// Sonuçlar: kişi daha önce oy verdiyse sonucu geri getirir (yeniden oylama yok)
app.get('/api/poll-sonuc', (req, res) => {
  const { get } = require('./db');
  const poll = get("SELECT id FROM polls WHERE status = 'active' ORDER BY created_at DESC LIMIT 1");
  if (!poll.id) return res.json({ success: true, poll: null });
  const voterKey = getCookie(req, 'poll_uid');
  const mine = voterKey ? get('SELECT id, option_id FROM poll_votes WHERE poll_id = ? AND voter_key = ?', [poll.id, voterKey]) : null;
  if (!mine || !mine.id) return res.json({ success: true, voted: false, poll: { id: poll.id } });
  res.json({ success: true, voted: true, ...pollResults(poll.id), myOptionId: mine.option_id });
});

// Google auth middleware
function requireGoogleAuth(req, res, next) {
  if (req.session.isGoogleAuth && req.session.googleUser) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'Google ile giriş yapmanız gerekiyor' });
}

// Yeni yorum ekle (girişsiz: ad + e-posta + güvenlik kodu; onaylı yayın)
app.post('/api/comments', commentLimiter, async (req, res) => {
  const { run, get } = require('./db');
  const gUser = (req.session.isGoogleAuth && req.session.googleUser) ? req.session.googleUser : null;
  const name = String(req.body.name || '').trim() || (gUser ? gUser.name : '');
  // Google ile giriş yapıldıysa ad/e-posta sunucu tarafında kilitlenir (body'deki değerler yok sayılır)
  const email = gUser ? gUser.email : String(req.body.email || '').trim();
  const captcha = String(req.body.captcha || '').trim().toUpperCase();
  const content = String(req.body.content || '').trim();
  const newsId = parseInt(req.body.news_id);

  if (!newsId || !get('SELECT id FROM news WHERE id = ?', [newsId]).id) {
    return res.status(400).json({ success: false, error: 'Haber bulunamadı' });
  }

  if (!name || name.length < 2) {
    return res.status(400).json({ success: false, error: 'Lütfen ad soyad girin' });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Geçerli bir e-posta adresi girin' });
  }

  if (!content) {
    return res.status(400).json({ success: false, error: 'Yorum içeriği gerekli' });
  }

  if (content.length > 1000) {
    return res.status(400).json({ success: false, error: 'Yorum 1000 karakteri aşamaz' });
  }

  const rcCheck = await verifyUserCaptcha(req);
  if (!rcCheck.ok) {
    return res.status(400).json({ success: false, error: rcCheck.error });
  }

  req.session.captchaCodes = [];

  run("INSERT INTO comments (news_id, user_name, user_email, user_avatar, content, status) VALUES (?,?,?,?,?,?)",
    [newsId, name, email, gUser ? gUser.avatar : null, content, 'pending']);

  const inserted = get("SELECT id FROM comments WHERE user_email = ? AND news_id = ? ORDER BY id DESC LIMIT 1", [email, newsId]);
  res.json({ success: true, id: inserted ? inserted.id : undefined, message: 'Yorumunuz alındı, onaylandıktan sonra yayınlanacaktır' });
});

// Admin yorum yönetimi
app.get('/admin/comments', isAuthenticated, (req, res) => {
  const { all } = require('./db');
  const pendingComments = all("SELECT c.*, n.title as news_title, n.slug as news_slug FROM comments c LEFT JOIN news n ON c.news_id = n.id WHERE c.status = 'pending' ORDER BY c.created_at DESC");
  const approvedComments = all("SELECT c.*, n.title as news_title, n.slug as news_slug FROM comments c LEFT JOIN news n ON c.news_id = n.id WHERE c.status = 'approved' ORDER BY c.created_at DESC");
  const hiddenComments = all("SELECT c.*, n.title as news_title, n.slug as news_slug FROM comments c LEFT JOIN news n ON c.news_id = n.id WHERE c.status = 'hidden' ORDER BY c.created_at DESC");
  res.render('admin/comments', { pendingComments, approvedComments, hiddenComments });
});

// Yorum onayla + yazarına otomatik "yayına alındı" maili
app.post('/admin/comments/approve/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const comment = get("SELECT c.*, n.title as news_title, n.slug as news_slug FROM comments c LEFT JOIN news n ON c.news_id = n.id WHERE c.id = ?", [req.params.id]);
  if (!comment.id) return flash(res, '/admin/comments', 'Yorum bulunamadı', 'error');
  run("UPDATE comments SET status = 'approved' WHERE id = ?", [req.params.id]);

  // Zaten yayındaysa mail tekrar gönderilmez; e-postası bilinmiyorsa da sessizce atlanır
  if (comment.status !== 'approved' && comment.user_email) {
    const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
    const newsUrl = siteUrl + '/haber/' + (comment.news_slug || comment.news_id);
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const excerpt = String(comment.content || '').substring(0, 200) + ((comment.content || '').length > 200 ? '…' : '');
    const mailHtml = '<div style="font-family:Segoe UI,Arial,sans-serif;background:#f4f4f5;padding:24px">'
      + '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e4e4e7">'
      + '<p style="margin:0 0 14px;color:#18181b;font-size:15px">Merhaba <strong>' + esc(comment.user_name) + '</strong>,</p>'
      + '<p style="margin:0 0 14px;color:#18181b;font-size:15px">&ldquo;<strong>' + esc(comment.news_title || 'haber') + '</strong>&rdquo; başlıklı haberin altındaki yorumunuz onaylandı ve artık yayında.</p>'
      + '<p style="margin:0 0 14px;color:#3f3f46;font-size:14px;background:#f9fafb;border-radius:8px;padding:12px">&ldquo;' + esc(excerpt) + '&rdquo;</p>'
      + '<p style="margin:0 0 24px"><a href="' + esc(newsUrl) + '" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:11px 22px;border-radius:10px">Yorumunuzu görmek için tıklayın →</a></p>'
      + '<p style="margin:0 0 4px;color:#52525b;font-size:13px">Katkınız için teşekkürler!</p>'
      + '<p style="margin:0;color:#52525b;font-size:13px">Marmara&rsquo;nın İncisi ekibi</p>'
      + '</div></div>';
    sendPortalMail({
      to: comment.user_email,
      subject: '✓ Yorumunuz yayına alındı — Marmara\u2019nın İncisi',
      text: 'Merhaba ' + (comment.user_name || '') + ',\n\n'
        + '"' + (comment.news_title || 'haber') + '" başlıklı haberin altındaki yorumunuz onaylandı ve artık yayında.\n\n'
        + 'Yorumunuz: ' + excerpt + '\n\n'
        + 'Haberin linki: ' + newsUrl + '\n\n'
        + 'Katkınız için teşekkürler!\nMarmara\u2019nın İncisi ekibi',
      html: mailHtml,
      replyTo: process.env.ADMIN_2FA_EMAIL || '',
      logTag: 'yorum-onay'
    }).catch(e => console.error('[yorum-onay] bildirim maili gönderilemedi:', e.message));
  }

  flash(res, '/admin/comments', 'Yorum onaylandı ve yayında' + (comment.user_email ? '; yazara bildirim maili gönderildi' : ''));
});

// Yorum görünürlük değiştir (approved<->hidden)
app.post('/admin/comments/toggle/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const comment = get("SELECT status FROM comments WHERE id = ?", [req.params.id]);
  if (!comment) return flash(res, '/admin/comments', 'Yorum bulunamadı', 'error');
  const newStatus = comment.status === 'approved' ? 'hidden' : 'approved';
  run("UPDATE comments SET status = ? WHERE id = ?", [newStatus, req.params.id]);
  flash(res, '/admin/comments',
    newStatus === 'approved' ? 'Yorum yeniden görünür yapıldı' : 'Yorum gizlendi',
    newStatus === 'approved' ? 'success' : 'info');
});

// Yorum düzenle (admin)
app.post('/admin/comments/edit/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  const { content } = req.body;
  if (!content || content.trim().length === 0) return flash(res, '/admin/comments', 'Yorum içeriği boş olamaz', 'error');
  run("UPDATE comments SET content = ? WHERE id = ?", [content.trim().substring(0, 1000), req.params.id]);
  flash(res, '/admin/comments', 'Yorum güncellendi');
});

// Yorum sil
app.post('/admin/comments/delete/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM comments WHERE id = ?', [req.params.id]);
  flash(res, '/admin/comments', 'Yorum silindi');
});

// ---- Gelen Mesajlar (İletişim Formu) ----
app.get('/admin/iletisim', isAuthenticated, (req, res) => {
  const { all } = require('./db');
  const messages = all('SELECT * FROM contact_messages ORDER BY status ASC, created_at DESC');
  res.render('admin/messages', { messages });
});

app.post('/admin/iletisim/read/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run("UPDATE contact_messages SET status = 'read' WHERE id = ?", [req.params.id]);
  flash(res, '/admin/iletisim', 'Mesaj okundu olarak işaretlendi', 'info');
});

app.post('/admin/iletisim/delete/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM contact_messages WHERE id = ?', [req.params.id]);
  flash(res, '/admin/iletisim', 'Mesaj silindi');
});

// Yorum düzenle (kullanıcı - sadece kendi yorumu)
app.put('/api/comments/:id', requireGoogleAuth, (req, res) => {
  const { run, get } = require('./db');
  const { content } = req.body;
  const user = req.session.googleUser;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Yorum içeriği gerekli' });
  }

  const comment = get("SELECT * FROM comments WHERE id = ?", [req.params.id]);
  if (!comment) {
    return res.status(404).json({ success: false, error: 'Yorum bulunamadı' });
  }

  if (comment.user_email !== user.email) {
    return res.status(403).json({ success: false, error: 'Bu yorumu düzenleme yetkiniz yok' });
  }

  run("UPDATE comments SET content = ? WHERE id = ?", [content.trim().substring(0, 1000), req.params.id]);
  res.json({ success: true, message: 'Yorumunuz güncellendi' });
});

// Yorum sil (kullanıcı - sadece kendi yorumu)
app.delete('/api/comments/:id', requireGoogleAuth, (req, res) => {
  const { run, get } = require('./db');
  const user = req.session.googleUser;

  const comment = get("SELECT * FROM comments WHERE id = ?", [req.params.id]);
  if (!comment) {
    return res.status(404).json({ success: false, error: 'Yorum bulunamadı' });
  }

  if (comment.user_email !== user.email) {
    return res.status(403).json({ success: false, error: 'Bu yorumu silme yetkiniz yok' });
  }

  run('DELETE FROM comments WHERE id = ?', [req.params.id]);
  res.json({ success: true, message: 'Yorumunuz silindi' });
});



// ===================== TICKER DATA (Weather + Finance) =====================
let tickerCache = { data: null, ts: 0 };
const TICKER_CACHE_MS = 5 * 60 * 1000;
const TICKER_PARTIAL_MS = 60 * 1000;
const HTTP_JSON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'application/json'
};

async function fetchJson(url, tries) {
  let lastErr;
  const n = tries || 2;
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch(url, { headers: HTTP_JSON_HEADERS, signal: AbortSignal.timeout(8000) });
      if (r.ok) return await r.json();
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) {
      lastErr = e;
    }
    if (i < n - 1) await new Promise(function(res) { setTimeout(res, 700); });
  }
  throw lastErr;
}

function chartMeta(j) {
  try {
    const m = j.chart.result[0].meta;
    if (m && m.regularMarketPrice) {
      return { price: m.regularMarketPrice, prev: m.chartPreviousClose || m.previousClose || null };
    }
  } catch (e) {}
  return null;
}

async function yahooChart(symbol) {
  let j;
  try {
    j = await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=5d');
  } catch (e) {
    j = await fetchJson('https://query2.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=5d');
  }
  return chartMeta(j);
}

function changeOf(cur, prev) {
  if (!cur || !prev) return '';
  const pct = ((cur - prev) / prev * 100);
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
}

function fmtNum(v, decimals) {
  const s = String(v).replace(/[^0-9.,-]/g, '');
  const withoutThousands = s.replace(/\.(?=\d{3}(?:,|$))/g, '');
  const n = parseFloat(withoutThousands.replace(',', '.'));
  if (isNaN(n)) return '--';
  return n.toLocaleString('tr-TR', { minimumFractionDigits: decimals || 2, maximumFractionDigits: decimals || 2 });
}

function parseTurkishNum(v) {
  if (!v) return NaN;
  // "6.499,50" → 6499.50  |  "47,5967" → 47.5967
  const s = String(v).replace(/[^0-9.,-]/g, '');
  // Binlik ayracı noktaları kaldır
  const withoutThousands = s.replace(/\.(?=\d{3}(?:,|$))/g, '');
  // Virgülü noktaya çevir
  return parseFloat(withoutThousands.replace(',', '.'));
}

async function fetchTickerData() {
  const now = Date.now();
  if (tickerCache.data && (now - tickerCache.ts) < TICKER_CACHE_MS) {
    return tickerCache.data;
  }

  const prev = tickerCache.data || null;
  const result = {
    weather: { temp: '--', description: '---', icon: '' },
    usd: '--', eur: '--', gramAltin: '--', ceYrekAltin: '--', bist100: '--',
    usdChange: '', eurChange: '', gramChange: '', ceYrekChange: '', bistChange: ''
  };
  let usdNum = null;
  let erapiData = null;
  const getErapi = async function() {
    if (!erapiData) erapiData = await fetchJson('https://open.er-api.com/v6/latest/USD');
    return erapiData;
  };

  // 1. Hava Durumu - Open-Meteo (yedek: wttr.in)
  try {
    const w = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=40.6475&longitude=29.0736&current=temperature_2m,weather_code&timezone=Europe/Istanbul' + (process.env.OPENMETEO_API_KEY ? '&apikey=' + encodeURIComponent(process.env.OPENMETEO_API_KEY) : ''));
    const wc = w.current;
    if (!wc || typeof wc.temperature_2m !== 'number') throw new Error('veri yok');
    result.weather.temp = Math.round(wc.temperature_2m) + '°C';
    const wmo = { 0:'Güneşli',1:'Az Bulutlu',2:'Parçalı Bulutlu',3:'Kapalı', 45:'Sisli',48:'Sisli',51:'Hafif Yağmurlu',53:'Yağmurlu',55:'Şiddetli Yağmurlu', 61:'Hafif Yağmurlu',63:'Yağmurlu',65:'Şiddetli Yağmurlu', 71:'Hafif Karlı',73:'Karlı',75:'Şiddetli Kar',80:'Sağanak',81:'Sağanak',82:'Şiddetli Sağanak',95:'Gök Gürültülü' };
    result.weather.description = wmo[wc.weather_code] || 'Bilinmiyor';
    if (wc.weather_code <= 1) result.weather.icon = '☀️';
    else if (wc.weather_code <= 3) result.weather.icon = '⛅';
    else if (wc.weather_code <= 48) result.weather.icon = '🌫️';
    else if (wc.weather_code <= 67) result.weather.icon = '🌧️';
    else if (wc.weather_code <= 77) result.weather.icon = '🌨️';
    else result.weather.icon = '⛈️';
  } catch (e) {
    console.log('[ticker] open-meteo basarisiz (' + e.message + '), wttr.in yedegine gecildi');
    try {
      const j = await fetchJson('https://wttr.in/Cinarcik?format=j1');
      const cc = j.current_condition && j.current_condition[0];
      if (!cc || cc.temp_C == null) throw new Error('veri yok');
      const desc = (cc.weatherDesc && cc.weatherDesc[0] && cc.weatherDesc[0].Value) || 'Bilinmiyor';
      result.weather.temp = cc.temp_C + '°C';
      result.weather.description = desc;
      const d = desc.toLowerCase();
      if (d.indexOf('rain') >= 0 || d.indexOf('drizzle') >= 0) result.weather.icon = '🌧️';
      else if (d.indexOf('snow') >= 0) result.weather.icon = '🌨️';
      else if (d.indexOf('sun') >= 0 || d.indexOf('clear') >= 0) result.weather.icon = '☀️';
      else if (d.indexOf('thunder') >= 0) result.weather.icon = '⛈️';
      else if (d.indexOf('fog') >= 0 || d.indexOf('mist') >= 0) result.weather.icon = '🌫️';
      else result.weather.icon = '⛅';
    } catch (e2) { console.log('[ticker] wttr.in yedegi de basarisiz: ' + e2.message); }
  }

  // 2. USD/TRY - Yahoo (yedek: er-api)
  try {
    const m = await yahooChart('USDTRY=X');
    if (!m) throw new Error('veri yok');
    usdNum = m.price;
    result.usd = fmtNum(m.price);
    result.usdChange = changeOf(m.price, m.prev);
  } catch (e) {
    console.log('[ticker] USDTRY yahoo basarisiz (' + e.message + '), yedek er-api');
    try {
      const j = await getErapi();
      if (j.result !== 'success' || !j.rates || !j.rates.TRY) throw new Error('veri yok');
      usdNum = j.rates.TRY;
      result.usd = fmtNum(usdNum);
    } catch (e2) { console.log('[ticker] USD yedek de basarisiz: ' + e2.message); }
  }

  // 3. EUR/TRY - Yahoo (yedek: er-api)
  try {
    const m = await yahooChart('EURTRY=X');
    if (!m) throw new Error('veri yok');
    result.eur = fmtNum(m.price);
    result.eurChange = changeOf(m.price, m.prev);
  } catch (e) {
    console.log('[ticker] EURTRY yahoo basarisiz (' + e.message + '), yedek er-api');
    try {
      const j = await getErapi();
      if (j.result !== 'success' || !j.rates || !j.rates.TRY || !j.rates.EUR) throw new Error('veri yok');
      result.eur = fmtNum(j.rates.TRY / j.rates.EUR);
    } catch (e2) { console.log('[ticker] EUR yedek de basarisiz: ' + e2.message); }
  }

  // 4. Gram + Çeyrek altın (XAU/USD ons → gram → TL; 1 ons = 31.1035 g)
  const usdForGold = usdNum || (prev && prev.usd !== '--' ? parseTurkishNum(prev.usd) : null);
  try {
    const m = await yahooChart('GC=F');
    if (!m || !usdForGold) throw new Error('veri yok (altin veya usd eksik)');
    const gramTRY = (m.price / 31.1035) * usdForGold;
    result.gramAltin = fmtNum(gramTRY);
    if (m.prev) result.gramChange = changeOf(gramTRY, (m.prev / 31.1035) * usdForGold);
    result.ceYrekAltin = fmtNum(gramTRY * 1.75);
    result.ceYrekChange = result.gramChange;
  } catch (e) { console.log('[ticker] altin basarisiz: ' + e.message); }

  // 5. BIST 100 - Yahoo
  try {
    const m = await yahooChart('XU100.IS');
    if (!m) throw new Error('veri yok');
    result.bist100 = fmtNum(m.price);
    result.bistChange = changeOf(m.price, m.prev);
  } catch (e) { console.log('[ticker] BIST basarisiz: ' + e.message); }

  // 6. Eksik alanları önceki başarılı veriden tamamla
  if (prev) {
    ['usd', 'eur', 'gramAltin', 'ceYrekAltin', 'bist100'].forEach(function(k) {
      if (result[k] === '--' && prev[k] && prev[k] !== '--') result[k] = prev[k];
    });
    [['usd', 'usdChange'], ['eur', 'eurChange'], ['gramAltin', 'gramChange'], ['ceYrekAltin', 'ceYrekChange'], ['bist100', 'bistChange']].forEach(function(p) {
      if (result[p[0]] === prev[p[0]] && !result[p[1]] && prev[p[1]]) result[p[1]] = prev[p[1]];
    });
    if (result.weather.temp === '--' && prev.weather && prev.weather.temp !== '--') result.weather = prev.weather;
  }

  // 7. Cache: alanlar tam → 5 dk, eksik varsa → 60 sn (hızlı yeniden deneme)
  const full = result.usd !== '--' && result.eur !== '--' && result.gramAltin !== '--' && result.bist100 !== '--' && result.weather.temp !== '--';
  const fetchedAt = Date.now();
  result.updated = new Date(fetchedAt).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' });
  tickerCache = { data: result, ts: full ? fetchedAt : fetchedAt - (TICKER_CACHE_MS - TICKER_PARTIAL_MS) };
  return result;
}

// Hava durumu tahmin rotası (Haftalık / 15 Gün / Aylık)
let forecastCache = { data: null, ts: 0 };
let forecastFetching = false;
let forecastDbLoaded = false;
const FORECAST_CACHE_MS = 6 * 60 * 60 * 1000; // 6 saat (Open-Meteo rate-limit'e dusmemek icin)
const FALLBACK_CACHE_MS = 10 * 60 * 1000; // yedek (wttr.in) veri kisa sure taze; Open-Meteo'yu sik deneyip 16 gunluge gec

// Son iyi tahmin verisini DB'ye kalici yap; Open-Meteo dusen/bloklayan anlarda
// (429/503) bayat veriyi servis ederek "Tahmin verisi alinamadi" hatasini onle.
function loadCachedForecast() {
  try {
    const { get } = require('./db');
    const r = get('SELECT value FROM app_cache WHERE key = ?', ['weather_forecast']);
    return (r && r.value) ? JSON.parse(r.value) : null;
  } catch (e) { return null; }
}
function persistForecast(data) {
  try {
    const { run } = require('./db');
    run('INSERT OR REPLACE INTO app_cache (key, value, updated_at) VALUES (?, ?, ?)',
      ['weather_forecast', JSON.stringify(data), new Date().toISOString()]);
  } catch (e) {}
}

const WMO_ICONS = {
  0:'☀️',1:'🌤️',2:'⛅',3:'☁️',
  45:'🌫️',48:'🌫️',51:'🌦️',53:'🌧️',55:'🌧️',
  61:'🌧️',63:'🌧️',65:'🌧️',
  71:'🌨️',73:'🌨️',75:'❄️',80:'🌦️',81:'🌧️',82:'⛈️',95:'⛈️',96:'⛈️',99:'⛈️'
};
const WMO_DESC = {
  0:'Güneşli',1:'Az Bulutlu',2:'Parçalı Bulutlu',3:'Kapalı',
  45:'Sisli',48:'Sisli',51:'Hafif Yağmurlu',53:'Yağmurlu',55:'Şiddetli Yağmurlu',
  61:'Hafif Yağmurlu',63:'Yağmurlu',65:'Şiddetli Yağmurlu',
  71:'Hafif Karlı',73:'Karlı',75:'Şiddetli Kar',80:'Sağanak',81:'Sağanak',82:'Şiddetli Sağanak',95:'Gök Gürültülü',96:'Dolu',99:'Şiddetli Dolu'
};
const DAY_NAMES_TR = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
const MONTH_NAMES_TR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

function wmoToIcon(code) { return WMO_ICONS[code] || '🌡️'; }
function wmoToDesc(code) { return WMO_DESC[code] || 'Bilinmiyor'; }

function fmtDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// Yedek saglayici: Open-Meteo tamamen dusukken (429/503) wttr.in'den 3 gunluk
// tahmin al; "Tahmin verisi alinamadi" hatasini onle. WMO kodlarina cevirip
// wmoToIcon/wmoToDesc ile tutarli ikon/aciklama uret.
const WTTR_TO_WMO = {
  113:0, 116:2, 119:3, 122:3, 143:45, 176:61, 200:95, 227:73, 230:75,
  248:45, 260:45, 263:51, 266:51, 293:61, 296:61, 299:63, 302:63, 305:65,
  308:65, 311:66, 314:67, 317:66, 320:67, 323:71, 326:71, 329:73, 332:73,
  335:75, 338:75, 350:77, 353:80, 356:81, 359:82, 362:80, 365:81, 368:80,
  371:81, 374:80, 377:81, 386:96, 389:99, 392:96, 395:99
};
async function fetchWttrFallback() {
  const r = await fetch('https://wttr.in/40.6475,29.0736?format=j1', { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('wttr HTTP ' + r.status);
  const j = await r.json();
  const days = (j.weather || []).slice(0, 3);
  if (!days.length) throw new Error('wttr veri yok');
  const todayStr = fmtDateLocal(new Date());
  return days.map(d => {
    const date = new Date(d.date + 'T12:00:00');
    const hourly = d.hourly || [];
    const noon = hourly[4] || hourly[Math.floor(hourly.length / 2)] || {};
    const code = WTTR_TO_WMO[parseInt(noon.weatherCode, 10)] !== undefined ? WTTR_TO_WMO[parseInt(noon.weatherCode, 10)] : 3;
    return {
      date: d.date,
      dayName: DAY_NAMES_TR[date.getDay()],
      dayNum: date.getDate(),
      month: MONTH_NAMES_TR[date.getMonth()],
      tempMax: parseInt(d.maxtempC, 10),
      tempMin: parseInt(d.mintempC, 10),
      rainChance: parseInt(noon.chanceofrain || 0, 10),
      wind: Math.round(parseFloat(noon.windspeedKmph || 0) * 0.277778), // km/h -> m/s
      icon: wmoToIcon(code),
      description: wmoToDesc(code),
      isForecast: d.date !== todayStr
    };
  });
}

// Open-Meteo ani kapasite/overload anlarinda (429/503) kisa backoff ile dene;
// boylece kisa sureli throttle kalkinca 16 gunluk tahmini kacirmayiz.
async function fetchWithRetry(url, opts, tries) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr;
}

app.get('/api/weather-forecast', (req, res) => {
  const cacheTtl = forecastCache.source === 'wttr' ? FALLBACK_CACHE_MS : FORECAST_CACHE_MS;
  if (forecastCache.data && forecastCache.data.length && (Date.now() - forecastCache.ts) < cacheTtl) {
    return res.json({ success: true, forecast: forecastCache.data });
  }
  // Cold-boot / restart: DB'den son iyi veriyi bir kez yukle
  if (!forecastDbLoaded) {
    forecastDbLoaded = true;
    if (!forecastCache.data) {
      const persisted = loadCachedForecast();
      if (persisted && persisted.length) forecastCache = { data: persisted, ts: 0 };
    }
  }
  // Tek-ucus: baska bir refresh donuyorsa bayat veriyi hemen servis et
  if (forecastFetching && forecastCache.data && forecastCache.data.length) {
    return res.json({ success: true, forecast: forecastCache.data, stale: true });
  }
  forecastFetching = true;

  // Bugünün tarihi ve ayın son günü
  const now = new Date();
  const todayStr = fmtDateLocal(now);
  const year = now.getFullYear();
  const month = now.getMonth();
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
  const todayDay = now.getDate();
  const remainingDays = lastDayOfMonth - todayDay;

  // 16 günlük tahmin
  // OPENMETEO_API_KEY tanimliysa ekle: anonim/datacenter IP throttle'ini asar,
  // hesap bazi limit uygulanir (10k/gun). Render'da env olarak tanimlanir.
  const omKey = process.env.OPENMETEO_API_KEY ? '&apikey=' + encodeURIComponent(process.env.OPENMETEO_API_KEY) : '';
  const forecastUrl = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=40.6475&longitude=29.0736'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max'
    + '&timezone=Europe/Istanbul&forecast_days=16' + omKey;

  fetchWithRetry(forecastUrl, { signal: AbortSignal.timeout(10000) }, 3)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(async w => {
      const d = w.daily;
      const forecastMap = {};
      const forecast = [];

      // Gerçek tahmini parse et
      for (let i = 0; i < d.time.length; i++) {
        const date = new Date(d.time[i] + 'T12:00:00');
        const code = d.weather_code[i];
        const item = {
          date: d.time[i],
          dayName: DAY_NAMES_TR[date.getDay()],
          dayNum: date.getDate(),
          month: MONTH_NAMES_TR[date.getMonth()],
          tempMax: Math.round(d.temperature_2m_max[i]),
          tempMin: Math.round(d.temperature_2m_min[i]),
          rainChance: d.precipitation_probability_max[i] || 0,
          wind: Math.round(d.wind_speed_10m_max[i]),
          icon: wmoToIcon(code),
          description: wmoToDesc(code),
          isForecast: true
        };
        forecast.push(item);
        forecastMap[d.time[i]] = item;
      }

      // Kalan günler varsa geçmiş yıllardan ortalamayla doldur
      if (remainingDays > 0) {
        const histYears = [year - 1, year - 2, year - 3];
        const histStart = fmtDateLocal(new Date(year - 3, month, todayDay + 1));
        const histEnd = fmtDateLocal(new Date(year - 1, month, lastDayOfMonth));
        const histUrl = 'https://archive-api.open-meteo.com/v1/archive'
          + '?latitude=40.6475&longitude=29.0736'
          + '&start_date=' + histStart + '&end_date=' + histEnd
          + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max'
          + '&timezone=Europe/Istanbul';

        try {
          const hRes = await fetch(histUrl, { signal: AbortSignal.timeout(10000) });
          if (hRes.ok) {
            const hData = await hRes.json();
            const hDaily = hData.daily;

            // Her ayın günü için geçmiş verileri grupla
            const histByDay = {};
            for (let i = 0; i < hDaily.time.length; i++) {
              const hDate = new Date(hDaily.time[i] + 'T12:00:00');
              if (hDate.getMonth() === month && hDate.getDate() > todayDay) {
                const dd = hDate.getDate();
                if (!histByDay[dd]) histByDay[dd] = { codes: [], maxs: [], mins: [], rains: [], winds: [] };
                histByDay[dd].codes.push(hDaily.weather_code[i]);
                histByDay[dd].maxs.push(hDaily.temperature_2m_max[i]);
                histByDay[dd].mins.push(hDaily.temperature_2m_min[i]);
                histByDay[dd].rains.push(hDaily.precipitation_sum[i] || 0);
                histByDay[dd].winds.push(hDaily.wind_speed_10m_max[i]);
              }
            }

            // Eksik günleri tarihsel ortalamayla doldur
            for (let day = todayDay + 1; day <= lastDayOfMonth; day++) {
              const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
              if (forecastMap[dateStr]) continue;

              const hd = histByDay[day];
              if (hd && hd.codes.length > 0) {
                // En sık görülen weather code
                const codeFreq = {};
                hd.codes.forEach(c => { codeFreq[c] = (codeFreq[c] || 0) + 1; });
                const avgCode = parseInt(Object.keys(codeFreq).reduce((a, b) => codeFreq[a] > codeFreq[b] ? a : b));

                const avgMax = Math.round(hd.maxs.reduce((a, b) => a + b, 0) / hd.maxs.length);
                const avgMin = Math.round(hd.mins.reduce((a, b) => a + b, 0) / hd.mins.length);
                const avgWind = Math.round(hd.winds.reduce((a, b) => a + b, 0) / hd.winds.length);
                const avgRain = Math.round(hd.rains.reduce((a, b) => a + b, 0) / hd.rains.length * 10) / 10;

                const histDate = new Date(year, month, day);
                forecast.push({
                  date: dateStr,
                  dayName: DAY_NAMES_TR[histDate.getDay()],
                  dayNum: day,
                  month: MONTH_NAMES_TR[month],
                  tempMax: avgMax,
                  tempMin: avgMin,
                  rainChance: Math.min(Math.round(avgRain * 20), 100),
                  wind: avgWind,
                  icon: wmoToIcon(avgCode),
                  description: wmoToDesc(avgCode) + ' (tahmini)',
                  isForecast: false
                });
              }
            }

            // Tarihe göre sırala
            forecast.sort((a, b) => a.date.localeCompare(b.date));
          }
        } catch (e) {
          console.log('Historical data error:', e.message);
        }
      }

      forecastCache = { data: forecast, ts: Date.now() };
      persistForecast(forecast);
      forecastFetching = false;
      res.json({ success: true, forecast });
    })
    .catch(err => {
      console.log('Forecast fetch error:', err.message);
      forecastFetching = false;
      // Refresh basarisiz — bayat (bellek veya DB) veri varsa onu servis et
      if (forecastCache.data && forecastCache.data.length) {
        return res.json({ success: true, forecast: forecastCache.data, stale: true });
      }
      const persisted = loadCachedForecast();
      if (persisted && persisted.length) {
        forecastCache = { data: persisted, ts: 0 };
        return res.json({ success: true, forecast: persisted, stale: true });
      }
      // Hicbayat veri yok — yedek saglayici (wttr.in) ile3 gunluk tahmin doldur
      fetchWttrFallback()
        .then(fb => {
          if (fb && fb.length) {
            forecastCache = { data: fb, ts: Date.now(), source: 'wttr' };
            persistForecast(fb);
            res.json({ success: true, forecast: fb, fallback: true });
          } else {
            res.json({ success: false, forecast: [], error: err.message });
          }
        })
        .catch(fbErr => {
          console.log('Wttr fallback error:', fbErr.message);
          res.json({ success: false, forecast: [], error: err.message });
        });
    });
});

app.get('/api/ticker-data', async (req, res) => {
  try {
    const data = await fetchTickerData();
    res.json({ success: true, ...data, updated: data.updated || new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' }) });
  } catch (e) {
    res.json({ success: false, weather:{temp:'--',description:'---',icon:''}, usd:'--', eur:'--', gramAltin:'--', ceYrekAltin:'--', bist100:'--', updated:'--' });
  }
});

// --- Diğer Haberler (Google News RSS) ---
let trendingNewsCache = { data: null, ts: 0 };
const TRENDING_CACHE_MS = 30 * 60 * 1000;

async function fetchTrendingNews() {
  const now = Date.now();
  if (trendingNewsCache.data && (now - trendingNewsCache.ts) < TRENDING_CACHE_MS) {
    return trendingNewsCache.data;
  }

  try {
    const rssUrl = 'https://news.google.com/rss/search?q=' + encodeURIComponent('Çınarcık') + '&hl=tr&gl=TR&ceid=TR:tr';
    const response = await fetch(rssUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('RSS fetch failed: ' + response.status);
    const xml = await response.text();

    const weatherKeywords = ['hava durumu', 'sıcaklık', 'derece', 'yağmur', 'güneşli', 'bulutlu', 'karlı', 'rüzgar', 'saatlik hava', 'günlük hava', 'haftalık hava', 'tahmin', 'meteoroloji', 'uv endeksi'];

    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || (block.match(/<link\/>([\s\S]*?)(?=<)/) || []))[1] || '';
      const description = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';

      const cleanTitle = title.replace(/<[^>]+>/g, '').trim();
      const lowerTitle = cleanTitle.toLowerCase();

      const isWeather = weatherKeywords.some(function(kw) {
        return lowerTitle.indexOf(kw) > -1;
      });
      if (isWeather) continue;

      const cleanDesc = description
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();

      if (cleanTitle && link) {
        items.push({
          title: cleanTitle,
          link: link.trim(),
          description: cleanDesc.substring(0, 200),
          source: source.trim(),
          pubDate: pubDate,
          dateObj: new Date(pubDate)
        });
      }
      if (items.length >= 10) break;
    }

    items.sort(function(a, b) { return b.dateObj - a.dateObj; });
    items.forEach(function(item) { delete item.dateObj; });

    trendingNewsCache = { data: items, ts: Date.now() };
    return items;
  } catch (e) {
    console.log('Trending news error:', e.message);
    return trendingNewsCache.data || [];
  }
}

app.get('/api/trending-news', async (req, res) => {
  try {
    const news = await fetchTrendingNews();
    res.json({ success: true, news });
  } catch (e) {
    res.json({ success: true, news: [] });
  }
});

// ---- Hizli site ici arama (Ctrl+K paneli) ----
// 5 icerik tablosunda baslik/ozet/alan uzerinden LIKE arama; public
// listelemelerdeki status='active' filtresi burada da gecerli.
// Donus: { results: [{ type, emoji, title, meta, url }] } — url on ekisiz (tr'de bos).
function trSearchNorm(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[âîû]/g, (m) => ({ 'â': 'a', 'î': 'i', 'û': 'u' }[m] || m))
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreSearchMatch(tokens, fullNormQ, titleText, extraText) {
  const tNorm = trSearchNorm(titleText);
  const eNorm = trSearchNorm(extraText);
  const combined = tNorm + ' ' + eNorm;
  for (const tk of tokens) {
    if (!combined.includes(tk)) return 0;
  }
  let score = 40;
  if (tNorm === fullNormQ) score += 100;
  else if (tNorm.startsWith(fullNormQ)) score += 75;
  else if (tNorm.includes(fullNormQ)) score += 55;
  else if (tokens.every(tk => tNorm.includes(tk))) score += 40;
  else if (combined.includes(fullNormQ)) score += 20;
  return score;
}

const SITE_SEARCH_SHORTCUTS = [
  {
    id: 'sc-ido',
    type: 'ulasim',
    typeLabel: 'Ulaşım & Seferler',
    emoji: '⛴️',
    title: 'İDO Feribot Seferleri (Yalova ↔ Pendik & Yenikapı)',
    meta: 'Günlük ve 7 günlük haftalık İDO hızlı feribot saatleri',
    url: '/ulasim#ido-ulasim-saatler',
    keywords: 'ido i̇do feribot hızlı feribot arabalı vapur yalova pendik yenikapı yenikapi deniz otobüsü ido sefer saatleri haftalık ido'
  },
  {
    id: 'sc-turyol',
    type: 'ulasim',
    typeLabel: 'Ulaşım & Seferler',
    emoji: '⛴️',
    title: 'Turyol Sefer Saatleri (Çınarcık ↔ Eminönü / Kadıköy)',
    meta: 'Çınarcık İskele ve Esenköy günlük vapur sefer saatleri ve ücretleri',
    url: '/ulasim#turyol-ulasim-saatler',
    keywords: 'turyol vapur deniz otobüsü eminönü eminonu kadıköy kadikoy çınarcık iskele esenköy esenkoy vapur saatleri sefer saatleri'
  },
  {
    id: 'sc-otobus',
    type: 'ulasim',
    typeLabel: 'Ulaşım & Seferler',
    emoji: '🚌',
    title: 'Şehir İçi Otobüs & Minibüs Sefer Saatleri',
    meta: 'Yalova – Çınarcık belediye otobüsü, minibüs saatleri ve ücret tarifesi',
    url: '/ulasim#ulasim-saatler',
    keywords: 'otobüs otobus minibüs minibus dolmuş dolmus belediye otobüsü ulaşım ulasim karpuzdere halk pazarı petrol ofisi yalova çınarcık otobüs saatleri sefer saatleri'
  },
  {
    id: 'sc-eczane',
    type: 'pharmacy',
    typeLabel: 'Nöbetçi Eczane',
    emoji: '💊',
    title: 'Çınarcık Nöbetçi Eczaneler (Bugün Nöbetçi)',
    meta: 'Bugün Çınarcık nöbetçi eczane adresi, telefonu ve yol tarifi',
    url: '/#nobetci-eczaneler',
    keywords: 'eczane nöbetçi eczane nobetci eczane ilaç ilac sağlık saglik açık eczane gece açık eczane pharmacy apotheke'
  },
  {
    id: 'sc-deniz',
    type: 'sea',
    typeLabel: 'Deniz & Hava',
    emoji: '🌊',
    title: 'Çınarcık Deniz Durumu & Su Sıcaklığı',
    meta: 'Canlı deniz suyu sıcaklığı, dalga boyu, rüzgar ve UV indeksi',
    url: '/deniz',
    keywords: 'deniz deniz durumu su sıcaklığı deniz suyu dalga boyu rüzgar uv indeksi yüzme plaj sahil'
  },
  {
    id: 'sc-hava',
    type: 'weather',
    typeLabel: 'Deniz & Hava',
    emoji: '🌤️',
    title: 'Çınarcık Hava Durumu (7 / 15 Günlük & Aylık Tahmin)',
    meta: 'Anlık sıcaklık, yağış ve 15 günlük meteoroloji tahmini',
    url: '/#hava-durumu',
    keywords: 'hava hava durumu meteoroloji yağmur yagmur sıcaklık sicaklik güneş rüzgar tahmin 15 günlük haftalık hava'
  },
  {
    id: 'sc-etkinlik',
    type: 'events',
    typeLabel: 'Etkinlikler',
    emoji: '📅',
    title: 'Çınarcık Etkinlik Takvimi',
    meta: 'Yaklaşan konser, festival, gösteri ve etkinlikler',
    url: '/etkinlikler',
    keywords: 'etkinlik etkinlikler takvim konser festival tiyatro gösteri şenlik bu hafta çınarcık'
  },
  {
    id: 'sc-ilan-ver',
    type: 'announcements',
    typeLabel: 'İlan & Duyuru',
    emoji: '📝',
    title: 'Ücretsiz İlan / Duyuru / Etkinlik Ver',
    meta: 'Çınarcık ücretsiz ilan, duyuru ve etkinlik gönderim formu',
    url: '/ilan-ver',
    keywords: 'ilan ver ücretsiz ilan duyuru ver etkinlik ekle satılık kiralık iş ilanı eleman arayanlar'
  },
  {
    id: 'sc-fotograflar',
    type: 'photos',
    typeLabel: 'Fotoğraflar',
    emoji: '📷',
    title: 'Sizlerden Gelen Fotoğraflar',
    meta: 'Ziyaretçilerimizin gözünden Çınarcık fotoğraf galerisi ve fotoğraf paylaşımı',
    url: '/sizlerden-gelen',
    keywords: 'sizlerden gelen fotoğraf fotograf galeri resim paylaş çınarcık fotoğrafları'
  },
  {
    id: 'sc-mekanlar',
    type: 'places',
    typeLabel: 'Mekanlar',
    emoji: '📍',
    title: 'Çınarcık Mekanlar Rehberi (Restoran, Kafe, Otel, Plaj)',
    meta: 'Çınarcık restoranları, kafeleri, otelleri, pansiyonları ve plajları',
    url: '/mekanlar',
    keywords: 'mekan mekanlar restoran kafe cafe kahvaltı balık lokanta otel pansiyon konaklama plaj beach'
  },
  {
    id: 'sc-rehber',
    type: 'guide',
    typeLabel: 'Firma Rehberi',
    emoji: '🏢',
    title: 'Çınarcık Firma Rehberi & Esnaflar',
    meta: 'Çınarcık firmaları, market, inşaat, emlak, kuaför ve hizmet rehberi',
    url: '/rehber',
    keywords: 'firma rehberi firmalar esnaf market inşaat emlak gayrimenkul kuaför güzellik sağlık eğitim'
  },
  {
    id: 'sc-gezi',
    type: 'sightseeing',
    typeLabel: 'Gezilecek Yerler',
    emoji: '🧳',
    title: 'Çınarcık Gezilecek Yerler & Doğal Güzellikler',
    meta: 'Delmece Yaylası, Erikli Şelalesi, Dipsiz Göl, Çınarcık sahili ve rotalar',
    url: '/gezilecek-yerler',
    keywords: 'gezilecek yerler gezi rehberi doğa yayla şelale göl piknik kamp yürüyüş'
  },
  {
    id: 'sc-haberler',
    type: 'news',
    typeLabel: 'Haberler',
    emoji: '📰',
    title: 'Çınarcık Güncel Haberler & Son Dakika',
    meta: 'Çınarcık gündem, belediye, yaşam ve spor haberleri',
    url: '/haberler',
    keywords: 'haber haberler son dakika gündem gelişmeler gazetesi'
  },
  {
    id: 'sc-duyurular',
    type: 'announcements',
    typeLabel: 'Duyurular',
    emoji: '📢',
    title: 'Çınarcık Duyuru, İlan ve Etkinlikler',
    meta: 'Güncel belediye duyuruları, vefat ilanları, emlak ve iş ilanları',
    url: '/duyurular',
    keywords: 'duyuru duyurular ilan ilanlar vefat cenaze elektrik su kesintisi'
  },
  {
    id: 'sc-hakkinda',
    type: 'about',
    typeLabel: 'Hakkında',
    emoji: 'ℹ️',
    title: 'Çınarcık Hakkında (Tarihçe, Doğa & Kültür)',
    meta: 'Marmara’nın İncisi Çınarcık hakkında bilgiler',
    url: '/cinarcik-hakkinda',
    keywords: 'çınarcık hakkında tarihçe bilgi nüfus coğrafya marmaranın incisi'
  },
  {
    id: 'sc-uygulama',
    type: 'about',
    typeLabel: 'Uygulama',
    emoji: '📲',
    title: 'Marmaraİncisi Uygulamasını İndir (Android & iPhone)',
    meta: 'Ücretsiz — telefonunuzun ana ekranına ekleyin, seferler ve eczane tek dokunuşla',
    url: '/uygulama',
    keywords: 'uygulama indir app mobil telefon android iphone ios ana ekran yükle kur pwa marmaraincisi'
  },
  {
    id: 'sc-elektrik-kesinti',
    type: 'guide',
    typeLabel: 'Elektrik Kesintisi',
    emoji: '⚡',
    title: 'Çınarcık Planlı Elektrik Kesintileri (UEDAŞ)',
    meta: 'Bugün ve önümüzdeki günlerde Çınarcık mahallelerindeki planlı elektrik kesintileri, saatleri ve sokaklar',
    url: '/#elektrik-kesintileri',
    keywords: 'elektrik kesinti kesintisi kesintiler elektrikler ne zaman gelecek uedaş uedas planlı arıza enerji'
  },
  {
    id: 'sc-acil-telefonlar',
    type: 'guide',
    typeLabel: 'Acil & Önemli Telefonlar',
    emoji: '📞',
    title: 'Çınarcık Acil & Önemli Telefonlar Rehberi (Tek Tıkla Ara)',
    meta: '112 Acil, Devlet Hastanesi (0226 245 48 56), Belediye (0226 245 10 04), Zabıta (153), UEDAŞ Elektrik Arıza (186), Doğalgaz (187), Emniyet, Jandarma & Sahil Güvenlik (158)',
    url: '/#acil-telefonlar',
    keywords: 'acil telefon telefonlar numaralar 112 ambulans itfaiye hastane devlet hastanesi belediye beyaz masa su arıza zabıta 153 uedaş elektrik arıza 186 armagaz doğalgaz 187 polis emniyet jandarma sahil güvenlik 158'
  },
  {
    id: 'sc-iletisim',
    type: 'contact',
    typeLabel: 'İletişim',
    emoji: '✉️',
    title: 'İletişim — Bize Ulaşın',
    meta: 'Görüş, öneri, haber ihbarı ve iletişim formu',
    url: '/iletisim',
    keywords: 'iletişim iletisim bize ulaşın mesaj gönder telefon e-posta adres'
  }
];

app.get('/api/search', searchLimiter, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2 || q.length > 80) return res.json({ results: [] });
  const fullNormQ = trSearchNorm(q);
  const tokens = fullNormQ.split(' ').filter(Boolean);
  if (!tokens.length) return res.json({ results: [] });

  const { all } = require('./db');
  const scored = [];
  const pushScored = (score, item) => {
    if (score > 0) scored.push(Object.assign({ _score: score }, item));
  };

  try {
    // 1. Nöbetçi Eczaneler (canlı veritabanı tablosu)
    const pharmacies = all("SELECT id, name, address, phone, duty_note FROM pharmacies WHERE status='active'");
    for (const p of pharmacies) {
      const sc = scoreSearchMatch(
        tokens,
        fullNormQ,
        p.name + ' Nöbetçi Eczane',
        'eczane nöbetçi nobetci ilaç ilac ' + (p.address || '') + ' ' + (p.phone || '') + ' ' + (p.duty_note || '')
      );
      if (sc > 0) {
        pushScored(sc + 25, {
          type: 'pharmacy',
          typeLabel: 'Nöbetçi Eczane',
          id: 'pharm-' + p.id,
          emoji: '💊',
          title: p.name + ' (Bugün Nöbetçi)',
          meta: [p.address, p.phone].filter(Boolean).join(' · '),
          url: '/#nobetci-eczaneler'
        });
      }
    }

    // 2. Site içi ana bölümler ve canlı modüller (İDO, Turyol, Otobüs, Deniz, Hava vb.)
    for (const scItem of SITE_SEARCH_SHORTCUTS) {
      const sc = scoreSearchMatch(tokens, fullNormQ, scItem.title, scItem.keywords + ' ' + scItem.meta);
      if (sc > 0) {
        pushScored(sc + 15, {
          type: scItem.type,
          typeLabel: scItem.typeLabel,
          id: scItem.id,
          emoji: scItem.emoji,
          title: scItem.title,
          meta: scItem.meta,
          url: scItem.url
        });
      }
    }

    // 3. Haberler (Türkçe karakter duyarsız, başlık + özet + içerik + kategori)
    const newsRows = all("SELECT id, title, slug, summary, content, category, badge_text, views_count FROM news WHERE status='active' ORDER BY views_count DESC, created_at DESC");
    for (const r of newsRows) {
      const sc = scoreSearchMatch(tokens, fullNormQ, r.title, (r.summary || '') + ' ' + (r.category || '') + ' ' + (r.badge_text || '') + ' ' + (r.content || ''));
      if (sc > 0) {
        pushScored(sc, {
          type: 'news',
          id: r.id,
          emoji: '📰',
          title: r.title,
          meta: r.category || r.badge_text || '',
          url: '/haber/' + (r.slug || r.id)
        });
      }
    }

    // 4. Mekanlar (isim + kategori + mutfak + açıklama + adres + özellikler)
    const placeRows = all("SELECT id, name, slug, category, cuisine_type, description, address, features, phone FROM places WHERE status='active' ORDER BY is_featured DESC, sort_order ASC");
    for (const r of placeRows) {
      const sc = scoreSearchMatch(tokens, fullNormQ, r.name, (r.category || '') + ' ' + (r.cuisine_type || '') + ' ' + (r.address || '') + ' ' + (r.features || '') + ' ' + (r.description || '') + ' ' + (r.phone || ''));
      if (sc > 0) {
        pushScored(sc, {
          type: 'places',
          id: r.id,
          emoji: '📍',
          title: r.name,
          meta: [r.category, r.address].filter(Boolean).join(' · '),
          url: '/mekan/' + (r.slug || r.id)
        });
      }
    }

    // 5. Duyuru, İlan & Etkinlikler (başlık + içerik + kategori)
    const annRows = all("SELECT id, title, slug, content, category, event_date FROM announcements WHERE status='active' ORDER BY created_at DESC");
    for (const r of annRows) {
      const catLabel = r.category === 'ilan' ? 'İlan' : (r.category === 'etkinlik' ? 'Etkinlik' : 'Duyuru');
      const sc = scoreSearchMatch(tokens, fullNormQ, r.title, catLabel + ' ' + (r.content || '') + ' ' + (r.event_date || ''));
      if (sc > 0) {
        pushScored(sc, {
          type: 'announcements',
          id: r.id,
          emoji: r.category === 'etkinlik' ? '📅' : '📢',
          title: r.title,
          meta: catLabel,
          url: '/duyuru/' + (r.slug || r.id)
        });
      }
    }

    // 6. Gezilecek Yerler (başlık + özet + açıklama + konum + kategori)
    const sightRows = all("SELECT id, title, slug, summary, description, location, category FROM sightseeing WHERE status='active' ORDER BY sort_order ASC");
    for (const r of sightRows) {
      const sc = scoreSearchMatch(tokens, fullNormQ, r.title, (r.location || '') + ' ' + (r.category || '') + ' ' + (r.summary || '') + ' ' + (r.description || ''));
      if (sc > 0) {
        pushScored(sc, {
          type: 'sightseeing',
          id: r.id,
          emoji: '🧳',
          title: r.title,
          meta: [r.category, r.location].filter(Boolean).join(' · '),
          url: '/gezilecek-yer/' + (r.slug || r.id)
        });
      }
    }

    // 7. Firma Rehberi (isim + kategori + sektör + açıklama + adres + telefon)
    const compRows = all("SELECT id, name, slug, category, sector, description, address, phone FROM companies WHERE status='active' ORDER BY is_featured DESC, sort_order ASC");
    for (const r of compRows) {
      const sc = scoreSearchMatch(tokens, fullNormQ, r.name, (r.category || '') + ' ' + (r.sector || '') + ' ' + (r.address || '') + ' ' + (r.description || '') + ' ' + (r.phone || ''));
      if (sc > 0) {
        pushScored(sc, {
          type: 'guide',
          id: r.id,
          emoji: '🏢',
          title: r.name,
          meta: [r.category || r.sector, r.address].filter(Boolean).join(' · '),
          url: '/rehber/' + (r.slug || r.id)
        });
      }
    }

    // 8. Sizlerden Gelen Fotoğraflar (başlık + açıklama + paylaşan)
    const photoRows = all("SELECT id, title, description, author_name FROM photo_submissions WHERE status='active' ORDER BY created_at DESC");
    for (const r of photoRows) {
      const sc = scoreSearchMatch(tokens, fullNormQ, r.title, (r.description || '') + ' ' + (r.author_name || ''));
      if (sc > 0) {
        pushScored(sc, {
          type: 'photos',
          id: r.id,
          emoji: '📷',
          title: r.title,
          meta: r.author_name ? ('Paylaşan: ' + r.author_name) : '',
          url: '/sizlerden-gelen'
        });
      }
    }

    // 9. Aktif Anketler (polls + poll_options tablosu)
    const pollRows = all("SELECT id, question FROM polls WHERE status='active' ORDER BY created_at DESC");
    for (const p of pollRows) {
      const opts = all('SELECT label FROM poll_options WHERE poll_id = ? ORDER BY position ASC', [p.id]).map(o => o.label).join(' · ');
      const sc = scoreSearchMatch(tokens, fullNormQ, p.question, 'anket oy ver ' + opts);
      if (sc > 0) {
        pushScored(sc, {
          type: 'poll',
          typeLabel: 'Anket',
          id: 'poll-' + p.id,
          emoji: '📊',
          title: p.question,
          meta: opts,
          url: '/#poll-card'
        });
      }
    }

    // 10. Canlı Ulaşım Hatları & Durakları (city_transport, ido_transport, ferry_schedules tablolarından dinamik)
    const cityTr = getCityTransport();
    if (cityTr && Array.isArray(cityTr.hatlar)) {
      for (const h of cityTr.hatlar) {
        const stops = (h.kalkislar || []).map(k => k.yer).join(' · ');
        const sc = scoreSearchMatch(tokens, fullNormQ, h.ad, (h.aciklama || '') + ' ' + stops);
        if (sc > 0) {
          pushScored(sc + 5, {
            type: 'ulasim',
            typeLabel: 'Ulaşım Hattı',
            id: 'bus-' + h.ad,
            emoji: '🚌',
            title: h.ad,
            meta: stops || h.aciklama || '',
            url: '/ulasim#ulasim-saatler'
          });
        }
      }
    }

    // 11. Çınarcık Hakkında (admin'den düzenlenebilen about_page tablosu)
    const aboutRows = all('SELECT id, banner_subtitle, content, cta_title, cta_text FROM about_page LIMIT 1');
    for (const a of aboutRows) {
      const sc = scoreSearchMatch(tokens, fullNormQ, 'Çınarcık Hakkında', (a.banner_subtitle || '') + ' ' + (a.content || '') + ' ' + (a.cta_title || '') + ' ' + (a.cta_text || ''));
      if (sc > 0 && !scored.some(x => x.url === '/cinarcik-hakkinda')) {
        pushScored(sc, {
          type: 'about',
          typeLabel: 'Hakkında',
          id: 'about-' + a.id,
          emoji: 'ℹ️',
          title: 'Çınarcık Hakkında',
          meta: a.banner_subtitle || '',
          url: '/cinarcik-hakkinda'
        });
      }
    }
  } catch (e) {
    console.error('[search] hata:', e.message);
    return res.json({ results: [] });
  }

  scored.sort((a, b) => b._score - a._score);
  const out = scored.slice(0, 15).map(({ _score, ...rest }) => rest);
  res.json({ results: out });
});

// ---- Harita koordinat çözümleme ----
// map_link (Google kisa link / Google Maps URL / plus code / adres) koordinata
// cevrilir ve cache'lenir; yer key'i varsa cid de uretilir (etiketli pin).
const _mapCoordCache = new Map();

function extractMapCoords(str) {
  if (!str) return null;
  const patterns = [
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/, // Google place URL: tam pin (!3d=enlem, !4d=boylam)
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/, // sadece gorunum/merkez (@ sonrasi z varsa kayabilir)
    /\/search\/(-?\d{1,3}\.\d+),\s*\+?(-?\d{1,3}\.\d+)/,
    /!2d(-?\d{1,3}\.\d+)!3d(-?\d{1,3}\.\d+)/, // Google embed pb: 2d=boylam, 3d=enlem (gorunum merkezi)
    /[?&]center=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
    /[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
    /[?&]ll=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/
  ];
  for (const re of patterns) {
    const m = str.match(re);
    if (m) {
      let lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      // pb formatinda sira lng, lat olabilir (!2d lng !3d lat)
      if (re === patterns[3]) { const tmp = lat; lat = lng; lng = tmp; }
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

function buildAddressVariants(address) {
  const base = String(address || '').trim();
  if (!base) return [];
  const noDaire = base.replace(/,?\s*D:\S+/gi, '').replace(/\s+/g, ' ').trim();
  const noMahalle = noDaire.split(',').slice(1).join(',').trim();
  const sade = noMahalle.replace(/,\s*\d{5}\s*[^,]*/g, '').replace(/,\s*$/, '').trim();
  return [noDaire, noMahalle, sade].filter(function(v) { return v && v.length > 3; });
}

async function nominatimSearch(terms) {
  for (const term of terms) {
    if (!term) continue;
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(term), {
        headers: { 'user-agent': 'cinarcik-portal/1.0' },
        signal: AbortSignal.timeout(6000)
      });
      const arr = await r.json();
      if (Array.isArray(arr) && arr[0]) {
        const lat = parseFloat(arr[0].lat), lng = parseFloat(arr[0].lon);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
      }
    } catch (e) { /* sonraki adaya geç */ }
    await new Promise(res => setTimeout(res, 1100));
  }
  return null;
}

async function resolveMapCoords(mapLink, extraQuery) {
  if (!mapLink) return null;
  const cacheKey = mapLink + '|' + (extraQuery || '');
  if (_mapCoordCache.has(cacheKey)) return _mapCoordCache.get(cacheKey);
  let coords = null;
  let cid = '';
  try {
    const town = 'Çınarcık, Yalova, Türkiye';
    const buildTerms = (q) => {
      const terms = [];
      buildAddressVariants(extraQuery).forEach(function(v) { terms.push(v + ', ' + town); });
      if (q) terms.push(q + ', ' + town);
      terms.push(extraQuery || '', q || '');
      return terms.filter(Boolean);
    };
    if (/^https?:\/\//i.test(mapLink)) {
      const r = await fetch(mapLink, {
        redirect: 'follow',
        headers: { 'user-agent': 'cinarcik-portal/1.0' },
        signal: AbortSignal.timeout(6000)
      });
      cid = extractPlaceCid(r.url);
      coords = extractMapCoords(r.url);
      if (!coords) {
        const body = await r.text();
        if (!cid) cid = extractPlaceCid(body);
        coords = extractMapCoords(body);
      }
      // share.google / google search linkleri koordinat icermiyor; q parametresinden
      // firma adi alinir ve adres varyantlariyla Nominatim'den konum cozulur.
      if (!coords) {
        let q = '';
        try { q = new URL(r.url).searchParams.get('q') || ''; } catch (e) { q = ''; }
        coords = await nominatimSearch(buildTerms(q));
      }
    } else {
      coords = await nominatimSearch(buildTerms(mapLink));
    }
  } catch (e) { coords = null; }
  if (coords && cid) coords.cid = cid;
  _mapCoordCache.set(cacheKey, coords);
  return coords;
}

// Google place URL / embed pb icindeki place key (0x...:0x...) ondalik cid'ye cevrilir.
// ?cid=...&output=embed bicimi etiketli yer pin'i basar (koordinatli q= embed'inde pin gorunmez).
function extractPlaceCid(str) {
  if (!str) return '';
  let s = String(str);
  try { s = decodeURIComponent(s); } catch (e) { /* bozuk escape - ham haliyle dene */ }
  const m = s.match(/!1s(0x[0-9a-f]+):(0x[0-9a-f]+)/i);
  if (!m) return '';
  try { return BigInt(m[2]).toString(); } catch (e) { return ''; }
}

function buildMapEmbedUrl(coords, cid) {
  const placeCid = cid || (coords && coords.cid) || '';
  if (placeCid) return 'https://www.google.com/maps?cid=' + placeCid + '&output=embed';
  if (!coords) return '';
  const { lat, lng } = coords;
  // Dropped pin (yer key'i olmayan koordinatlar): klasik maps.google.com embed'i
  // kirmizi pin basar; www.google.com/maps?q= biciminde pin gorunmuyordu.
  return 'https://maps.google.com/maps?q=' + lat + ',' + lng + '&hl=tr&z=17&output=embed';
}

async function getMapEmbedUrl(mapLink, extraQuery) {
  if (!mapLink) return '';
  return buildMapEmbedUrl(await resolveMapCoords(mapLink, extraQuery));
}

// Firma konumu: harita embed + Google yol tarifi icin koordinatli link.
// share.google linkleri Google tarafindan CAPTCHA/engel ile karsilastirilabildigi
// icin, koordinat cozulmusse direkt google.com/maps/dir linki kullanilir.
async function getMapInfo(mapLink, extraQuery) {
  const info = { embedUrl: '', directionsUrl: '' };
  if (!mapLink) return info;
  const coords = await resolveMapCoords(mapLink, extraQuery);
  if (coords) {
    info.embedUrl = buildMapEmbedUrl(coords);
    // cid varsa yol tarifi tam yer pin'ine gider (koordinat merkezi degil).
    info.directionsUrl = coords.cid
      ? 'https://www.google.com/maps/dir/?api=1&destination=cid:' + coords.cid
      : 'https://www.google.com/maps/dir/?api=1&destination=' + coords.lat + ',' + coords.lng;
  } else {
    info.directionsUrl = mapLink;
  }
  return info;
}

// ---- Nöbetçi Eczane Otomatik Senkronizasyon ----
// Kaynak: İstanbul Eczacı Odası nöbetçi eczane sistemi (Yalova / Çınarcık)
const NOBETCI_BASE = 'https://www.istanbuleczaciodasi.org.tr/nobetci-eczane/';
const NOBETCI_IL = '77'; // Yalova
const NOBETCI_ILCE = 'çınarcık';
const NOBETCI_SYNC_MS = 30 * 60 * 1000; // 30 dakikada bir

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?strong>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function syncNobetciEczaneler() {
  const { run } = require('./db');

  const sessRes = await fetch('https://www.istanbuleczaciodasi.org.tr/api/nobetci-eczane-web/?action=session', {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': NOBETCI_BASE
    }
  });
  const sessData = await sessRes.json();
  if (!sessData || !sessData.success || !sessData.data || !sessData.data.token) {
    throw new Error('nöbetçi eczane: doğrulama oturumu açılamadı');
  }
  const token = sessData.data.token;

  const distRes = await fetch('https://www.istanbuleczaciodasi.org.tr/api/nobetci-eczane-web/?action=district&id=44', {
    headers: {
      'Accept': 'application/json',
      'X-Web-Token': token,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': NOBETCI_BASE
    }
  });
  const dist = await distRes.json();
  if (!dist || !dist.success || !Array.isArray(dist.data)) {
    throw new Error('nöbetçi eczane: eczane listesi alınamadı');
  }

  if (dist.data.length === 0) {
    console.log('[nöbetçi eczane] Çınarcık: nöbetçi eczane listesi boş döndü');
    return 0;
  }

  run('DELETE FROM pharmacies');
  let count = 0;
  for (const e of dist.data) {
    const name = stripHtml(e.ad);
    if (!name) continue;
    let phoneFmt = '';
    if (e.sicil && e.phoneTicket) {
      try {
        await new Promise(r => setTimeout(r, 1200));
        const phoneRes = await fetch('https://www.istanbuleczaciodasi.org.tr/api/nobetci-eczane-web/?action=phone', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Web-Token': token,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': NOBETCI_BASE
          },
          body: JSON.stringify({ regionId: e.regionId, sicil: String(e.sicil), ticket: e.phoneTicket })
        });
        const pData = await phoneRes.json();
        if (pData && pData.success && pData.data && pData.data.tel) {
          let rawPhone = String(pData.data.tel).replace(/\D/g, '');
          if (rawPhone.length === 10) rawPhone = '0' + rawPhone;
          phoneFmt = rawPhone.length === 11
            ? rawPhone.slice(0, 4) + ' ' + rawPhone.slice(4, 7) + ' ' + rawPhone.slice(7, 9) + ' ' + rawPhone.slice(9, 11)
            : pData.data.tel;
        }
      } catch (err) {
        console.warn('[nöbetçi eczane] telefon alınamadı:', err.message);
      }
    }

    const note = (e.nobetBaslangic && e.nobetBitis)
      ? `${e.nobetBaslangic} - ${e.nobetBitis}`
      : (e.dutyEndsAt ? String(e.dutyEndsAt).slice(11, 16) : 'Ertesi gün 08:30');

    run('INSERT INTO pharmacies (name, address, phone, duty_note, status) VALUES (?,?,?,?,?)', [
      name,
      stripHtml(e.adres || '').replace(/^Adres:\s*/i, '').trim(),
      phoneFmt,
      note,
      'active'
    ]);
    count++;
  }
  console.log('[nöbetçi eczane] Çınarcık: ' + count + ' eczane güncellendi');
  return count;
}

async function safeSyncNobetci() {
  try {
    await syncNobetciEczaneler();
  } catch (e) {
    console.error('[nöbetçi eczane] senkronizasyon hatası:', e.message);
  }
}

// ---- Sefer Saatleri Otomatik Senkronizasyon ----
// Kaynak: Turyol (Çınarcık <-> Eminönü gidiş-dönüş sefer tarifeleri)
const FERRY_SOURCE = 'https://www.turyol.com/Home/Tarifeler';
const FERRY_HAT = { hatTuruId: '102', langId: '1' }; // Çınarcık-Kocadere-Esenköy hattı
const FERRY_SYNC_MS = 60 * 60 * 1000; // 1 saatte bir
const FERRY_DIRECTIONS = [
  { // Gidiş: Çınarcık -> Eminönü
    origin: 'Çınarcık İskele',
    tarifeKalkisId: '2_102_14_114',
    kalkisId: '114',
    keep: ['101'] // Eminönü İskele
  },
  { // Dönüş: Eminönü -> Çınarcık
    origin: 'Eminönü İskele',
    tarifeKalkisId: '2_102_1_101',
    kalkisId: '101',
    keep: ['114'] // Çınarcık İskele
  }
];

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTarifeTable(html) {
  const tableMatch = html.match(/<table id="datatable-responsive"[\s\S]*?<\/table>/);
  if (!tableMatch) return null;

  const labels = [];
  const thRe = /<th(?=[\s>])[^>]*>([\s\S]*?)<\/th>/g;
  let m;
  while ((m = thRe.exec(tableMatch[0])) !== null) {
    const label = decodeEntities(String(m[1]).replace(/<[^>]+>/g, ' '));
    if (label) labels.push(label);
  }

  const tbody = (tableMatch[0].match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  while ((m = trRe.exec(tbody)) !== null) {
    const cells = [];
    const tdRe = /<td(?=[\s>])[^>]*>([\s\S]*?)<\/td>/g;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) cells.push(decodeEntities(String(c[1]).replace(/<[^>]+>/g, ' ')));
    if (cells.some(Boolean)) rows.push(cells);
  }
  if (!labels.length || !rows.length) return null;

  return labels.map((label, i) => ({
    label,
    times: rows.map(r => r[i] || '').filter(Boolean)
  }));
}

// Aynı yanıt gövdesindeki fiyat rozetleri: <div id="fiyatDiv"> ... Tam : 400 TL ...
function parseFerryPrices(html) {
  const m = String(html || '').match(/<div id="fiyatDiv"[\s\S]*?<\/div>/);
  if (!m) return [];
  const items = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let x;
  while ((x = liRe.exec(m[0])) !== null) {
    const txt = decodeEntities(String(x[1]).replace(/<[^>]+>/g, ' '));
    if (txt) items.push(txt);
  }
  return items;
}

async function fetchDirection(dir) {
  const ua = { 'User-Agent': 'Mozilla/5.0' };

  const varisler = await fetch('https://www.turyol.com/Tarife/GetVarislar2', {
    method: 'POST',
    headers: { ...ua, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ...FERRY_HAT, kalkisId: dir.kalkisId })
  }).then(r => r.json());

  const list = (Array.isArray(varisler) ? varisler : [])
    .filter(x => x && x.Key && dir.keep.includes(String(x.Key)));
  if (!list.length) throw new Error(dir.origin + ' kalkışlı güzergâh listesi boş');

  const results = [];
  for (const v of list) {
    const html = await fetch(FERRY_SOURCE, {
      method: 'POST',
      headers: { ...ua, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({
        MainHatTuruId: '2',
        TarifeKalkisId: dir.tarifeKalkisId,
        TarifeVarisId: v.Key
      }).toString()
    }).then(r => r.text());

    const columns = parseTarifeTable(html);
    if (!columns) continue;
    results.push({ origin: dir.origin, destination: decodeEntities(v.Value), columns, prices: parseFerryPrices(html) });
  }
  return results;
}

async function syncSeferSaatleri() {
  const { run, all } = require('./db');

  // Turyol bazen fiyat bloğu olmadan sayfa döndürür; önceki fiyatları koru
  const prevPrices = {};
  try {
    all('SELECT origin, destination, prices_json FROM ferry_schedules').forEach(r => {
      try { prevPrices[r.origin + '|' + r.destination] = JSON.parse(r.prices_json || '[]'); } catch (e) {}
    });
  } catch (e) {}

  const results = [];
  for (const dir of FERRY_DIRECTIONS) {
    try {
      results.push(...await fetchDirection(dir));
    } catch (e) {
      console.error('[sefer saatleri] ' + dir.origin + ' yönü alınamadı:', e.message);
    }
  }

  if (!results.length) throw new Error('sefer saatleri: tablo verisi çekilemedi');

  run('DELETE FROM ferry_schedules');
  results.forEach(r => {
    const key = r.origin + '|' + r.destination;
    const prices = (r.prices && r.prices.length) ? r.prices : (prevPrices[key] || []);
    run('INSERT INTO ferry_schedules (origin, destination, data_json, prices_json, updated_at) VALUES (?,?,?,?,datetime(\'now\'))',
      [r.origin, r.destination, JSON.stringify(r.columns), JSON.stringify(prices)]);
  });
  console.log('[sefer saatleri] ' + results.length + ' güzergâh güncellendi');
  return results.length;
}

async function safeSyncSefer() {
  try {
    await syncSeferSaatleri();
  } catch (e) {
    console.error('[sefer saatleri] senkronizasyon hatası:', e.message);
  }
}

// ==================== ÇINARCIK İÇİ ULAŞIM (Belediye) ====================
// Kaynak: Çınarcık Belediyesi ulaşım sayfası. 7 günlük tüm sefer verisi
// sayfanın hydration betiğinde tek JS literal olarak gömülüdür (SSR'da sadece
// bugünün günü görünür); HTML'den çıkarılıp city_transport tablosuna yazılır.
const ULASIM_SOURCE = 'https://cinarcik.bel.tr/cinarcik/ulasim';
const ULASIM_SYNC_MS = 60 * 60 * 1000; // 1 saatte bir

// JS literal'ının JSON olmayan tek farkı anahtarlardaki tırnaktır; dizi ve
// nesne başlangıçlarını (dışarıdayken) izleyip anahtarları tırnaklar.
// String içi metinler korunur; beklenmedik format JSON.parse'ta patlar ve
// önceki veri korunur.
function jsLiteralToJson(literal) {
  let out = '';
  let i = 0;
  let inStr = null;
  while (i < literal.length) {
    const c = literal[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += literal[i + 1] || ''; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; out += c; i++; continue; }
    if (c === '{' || c === ',') {
      out += c;
      i++;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*\s*):/.exec(literal.slice(i, i + 64));
      if (m) {
        out += '"' + m[1].replace(/\s+$/, '') + '":';
        i += m[0].length;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function extractCityTransport(html) {
  const at = html.indexOf('ulasim:');
  if (at === -1) throw new Error('ulasim veri bloğu bulunamadı');
  const start = html.indexOf('{', at);
  if (start === -1) throw new Error('ulasim veri bloğu açılış parantezi yok');
  let depth = 0, inStr = null, esc = false, end = -1;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end === -1) throw new Error('ulasim veri bloğu kapanış parantezi yok');
  const data = JSON.parse(jsLiteralToJson(html.slice(start, end + 1)));
  if (!data || !Array.isArray(data.hatlar) || !data.hatlar.length) throw new Error('ulasim: hat listesi boş');
  if (!Array.isArray(data.ucretler)) data.ucretler = [];
  return data;
}

async function syncUlasim() {
  const { run } = require('./db');
  const res = await fetch(ULASIM_SOURCE, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = extractCityTransport(await res.text());
  run('DELETE FROM city_transport WHERE id = ?', [1]);
  run('INSERT INTO city_transport (id, data_json, source_url, updated_at) VALUES (1,?,?,datetime(\'now\'))',
    [JSON.stringify(data), ULASIM_SOURCE]);
  let sefer = 0;
  data.hatlar.forEach(h => (h.kalkislar || []).forEach(k => sefer += (k.seferler || []).length));
  console.log('[ulasim] ' + data.hatlar.length + ' hat / ' + sefer + ' sefer güncellendi');
  return data;
}

async function safeSyncUlasim() {
  try {
    await syncUlasim();
  } catch (e) {
    console.error('[ulasim] senkronizasyon hatası:', e.message);
  }
}

function getCityTransport() {
  const { get } = require('./db');
  try {
    const row = get('SELECT data_json, updated_at FROM city_transport WHERE id = 1');
    if (!row || !row.data_json) return null;
    const data = JSON.parse(row.data_json);
    if (!data || !Array.isArray(data.hatlar) || !data.hatlar.length) return null;
    data.updatedAt = row.updated_at || '';
    return data;
  } catch (e) {
    console.error('[ulasim] kayıt okunamadı:', e.message);
    return null;
  }
}

// ==================== İDO FERİBOT SEFERLERİ (Yalova ↔ Pendik & Yenikapı) ====================
const IDO_API_BASE = 'https://api.ido.com.tr/idows/v2/ido/voyages';
const IDO_SOURCE_URL = 'https://www.ido.com.tr/sefer-saatleri';
const IDO_SYNC_MS = 60 * 60 * 1000; // 1 saatte bir
const IDO_PORT_YALOVA = '500212-P';
const IDO_PORT_PENDIK = '500115-P';
const IDO_PORT_YENIKAPI = '500114-P';

const DEFAULT_IDO_TRANSPORT = {
  hatlar: [
    {
      ad: 'Yalova – Pendik Hattı',
      aciklama: 'İDO HIZLI FERİBOT (ARAÇLI & YOLCU) · ~45 DK',
      kalkislar: [
        {
          yer: 'Yalova → Pendik',
          seferler: [
            { saat: '07:00', gunler: [1, 2, 3, 4, 5, 6] },
            { saat: '08:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '09:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '10:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '11:00', gunler: [3, 5, 6, 7] },
            { saat: '12:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '13:00', gunler: [3, 6, 7] },
            { saat: '14:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '15:00', gunler: [3, 4, 5, 6, 7] },
            { saat: '16:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '17:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '18:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '19:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '20:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '21:00', gunler: [5, 6, 7] },
            { saat: '22:00', gunler: [7] }
          ]
        },
        {
          yer: 'Pendik → Yalova',
          seferler: [
            { saat: '07:00', gunler: [1, 2, 3, 4, 5, 6] },
            { saat: '08:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '09:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '10:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '11:00', gunler: [3, 5, 6, 7] },
            { saat: '12:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '13:00', gunler: [3, 6, 7] },
            { saat: '14:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '15:00', gunler: [3, 4, 5, 6, 7] },
            { saat: '16:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '17:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '18:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '19:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '20:00', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '21:00', gunler: [5, 6, 7] },
            { saat: '22:00', gunler: [7] }
          ]
        }
      ]
    },
    {
      ad: 'Yalova – Yenikapı Hattı',
      aciklama: 'İDO HIZLI FERİBOT (ARAÇLI & YOLCU) · ~75 DK',
      kalkislar: [
        {
          yer: 'Yalova → Yenikapı',
          seferler: [
            { saat: '07:15', gunler: [1, 2, 3, 4, 5, 6] },
            { saat: '07:45', gunler: [7] },
            { saat: '09:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '11:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '13:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '15:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '17:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '19:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '21:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '23:45', gunler: [7] }
          ]
        },
        {
          yer: 'Yenikapı → Yalova',
          seferler: [
            { saat: '07:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '09:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '11:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '13:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '15:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '17:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '19:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '21:45', gunler: [1, 2, 3, 4, 5, 6, 7] },
            { saat: '23:45', gunler: [7] }
          ]
        }
      ]
    }
  ]
};

function fmtIsoDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function syncIdo() {
  const { run } = require('./db');
  const now = new Date();
  const end = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000);
  const fromDate = fmtIsoDay(now);
  const toDate = fmtIsoDay(end);
  const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };

  const [resDep, resArr] = await Promise.all([
    fetch(`${IDO_API_BASE}?departureLocation=${IDO_PORT_YALOVA}&fromDate=${fromDate}&toDate=${toDate}`, { headers }),
    fetch(`${IDO_API_BASE}?arrivalLocation=${IDO_PORT_YALOVA}&fromDate=${fromDate}&toDate=${toDate}`, { headers })
  ]);
  if (!resDep.ok || !resArr.ok) {
    throw new Error(`HTTP ${resDep.status}/${resArr.status}`);
  }
  const [jsonDep, jsonArr] = await Promise.all([resDep.json(), resArr.json()]);
  const allVoyages = [].concat(jsonDep.voyages || [], jsonArr.voyages || []);

  // 4 yön için saat -> Set(gunler 1..7)
  const routeMap = {
    'YP': new Map(), // Yalova -> Pendik
    'PY': new Map(), // Pendik -> Yalova
    'YY': new Map(), // Yalova -> Yenikapı
    'YYK': new Map() // Yenikapı -> Yalova
  };
  const ROUTE_LABEL = {
    'YP': 'Yalova → Pendik',
    'PY': 'Pendik → Yalova',
    'YY': 'Yalova → Yenikapı',
    'YYK': 'Yenikapı → Yalova'
  };
  const iptaller = [];
  const todayIso = fmtIsoDay(now);

  for (const v of allVoyages) {
    if (!v || !v.departureTime || !v.date || !v.fromLocation || !v.toLocation) continue;
    const st = String(v.statusForWeb || '') + ' ' + String(v.status || '');
    if (/iptal|cancel/i.test(st)) {
      // İptal/işlemeyen seferleri tarifeye almıyoruz; duyuru bandı için kaydediyoruz.
      const saatI = String(v.departureTime).slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(saatI) || String(v.date) < todayIso) continue;
      const fc = String(v.fromLocation.code || '');
      const tc = String(v.toLocation.code || '');
      let ikey = null;
      if (fc === IDO_PORT_YALOVA && tc === IDO_PORT_PENDIK) ikey = 'YP';
      else if (fc === IDO_PORT_PENDIK && tc === IDO_PORT_YALOVA) ikey = 'PY';
      else if (fc === IDO_PORT_YALOVA && tc === IDO_PORT_YENIKAPI) ikey = 'YY';
      else if (fc === IDO_PORT_YENIKAPI && tc === IDO_PORT_YALOVA) ikey = 'YYK';
      if (!ikey) continue;
      iptaller.push({ date: String(v.date), saat: saatI, yon: ROUTE_LABEL[ikey] });
      continue;
    }
    const parts = String(v.date).split('-').map(Number);
    if (parts.length !== 3 || !parts[0]) continue;
    const jsDay = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0)).getUTCDay();
    const gun = jsDay === 0 ? 7 : jsDay; // 1 = Pzt .. 7 = Paz
    const fromCode = v.fromLocation.code;
    const toCode = v.toLocation.code;
    let key = null;
    if (fromCode === IDO_PORT_YALOVA && toCode === IDO_PORT_PENDIK) key = 'YP';
    else if (fromCode === IDO_PORT_PENDIK && toCode === IDO_PORT_YALOVA) key = 'PY';
    else if (fromCode === IDO_PORT_YALOVA && toCode === IDO_PORT_YENIKAPI) key = 'YY';
    else if (fromCode === IDO_PORT_YENIKAPI && toCode === IDO_PORT_YALOVA) key = 'YYK';
    if (!key) continue;

    const saat = String(v.departureTime).slice(0, 5);
    if (!/^\d{2}:\d{2}$/.test(saat)) continue;
    if (!routeMap[key].has(saat)) routeMap[key].set(saat, new Set());
    routeMap[key].get(saat).add(gun);
  }

  const mapToSeferler = (m, fallbackArr) => {
    const times = Array.from(m.keys()).sort();
    if (!times.length) return fallbackArr;
    return times.map(saat => ({
      saat,
      gunler: Array.from(m.get(saat)).sort((a, b) => a - b)
    }));
  };

  const data = {
    iptaller: iptaller.sort((a, b) => (a.date + a.saat).localeCompare(b.date + b.saat)),
    hatlar: [
      {
        ad: 'Yalova – Pendik Hattı',
        aciklama: 'İDO HIZLI FERİBOT (ARAÇLI & YOLCU) · ~45 DK',
        kalkislar: [
          {
            yer: 'Yalova → Pendik',
            seferler: mapToSeferler(routeMap.YP, DEFAULT_IDO_TRANSPORT.hatlar[0].kalkislar[0].seferler)
          },
          {
            yer: 'Pendik → Yalova',
            seferler: mapToSeferler(routeMap.PY, DEFAULT_IDO_TRANSPORT.hatlar[0].kalkislar[1].seferler)
          }
        ]
      },
      {
        ad: 'Yalova – Yenikapı Hattı',
        aciklama: 'İDO HIZLI FERİBOT (ARAÇLI & YOLCU) · ~75 DK',
        kalkislar: [
          {
            yer: 'Yalova → Yenikapı',
            seferler: mapToSeferler(routeMap.YY, DEFAULT_IDO_TRANSPORT.hatlar[1].kalkislar[0].seferler)
          },
          {
            yer: 'Yenikapı → Yalova',
            seferler: mapToSeferler(routeMap.YYK, DEFAULT_IDO_TRANSPORT.hatlar[1].kalkislar[1].seferler)
          }
        ]
      }
    ]
  };

  run('DELETE FROM ido_transport');
  run('INSERT INTO ido_transport (id, data_json, source_url, updated_at) VALUES (1,?,?,datetime(\'now\'))',
    [JSON.stringify(data), IDO_SOURCE_URL]);
  let seferCount = 0;
  data.hatlar.forEach(h => (h.kalkislar || []).forEach(k => seferCount += (k.seferler || []).length));
  console.log('[ido] ' + data.hatlar.length + ' hat / ' + seferCount + ' tarifeli saat / ' + (data.iptaller || []).length + ' iptal güncellendi');
  return data;
}

async function safeSyncIdo() {
  try {
    await syncIdo();
  } catch (e) {
    console.error('[ido] senkronizasyon hatası:', e.message);
  }
}

function getIdoTransport() {
  const { get } = require('./db');
  try {
    const row = get('SELECT data_json, updated_at FROM ido_transport WHERE id = 1');
    if (row && row.data_json) {
      const data = JSON.parse(row.data_json);
      if (data && Array.isArray(data.hatlar) && data.hatlar.length) {
        data.updatedAt = row.updated_at || '';
        return data;
      }
    }
  } catch (e) {
    console.error('[ido] kayıt okunamadı:', e.message);
  }
  return Object.assign({ updatedAt: '' }, DEFAULT_IDO_TRANSPORT);
}

// ⚡ UEDAŞ Planlı Elektrik Kesintileri (Çınarcık ilçesi)
const OUTAGE_SOURCE_URL = 'https://www.uedas.com.tr/tr/kesintiler';
const OUTAGE_API_URL = 'https://www.uedas.com.tr/planli-kesintiler/sec.asp';
const OUTAGE_ILCE_ID = '2021'; // UEDAŞ Yalova / Çınarcık ilçe kimliği
const OUTAGE_SYNC_MS = 60 * 60 * 1000; // 1 saatte bir
const TR_MONTHS = ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'];

function trTitleCase(s) {
  return String(s || '').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ')
    .replace(/(^|[\s.(/-])(\S)/g, (m, p, c) => p + c.toLocaleUpperCase('tr-TR'));
}

function parseOutageDate(label, now) {
  const m = String(label || '').trim().toLocaleLowerCase('tr-TR').match(/^(\d{1,2})\s+(\S+)/);
  if (!m) return null;
  const mon = TR_MONTHS.indexOf(m[2]);
  if (mon < 0) return null;
  let year = now.getFullYear();
  // Aralık'ta Ocak tarihi gelirse bir sonraki yıl; Ocak'ta Aralık gelirse önceki yıl
  if (mon - now.getMonth() < -6) year++;
  else if (mon - now.getMonth() > 6) year--;
  return year + '-' + String(mon + 1).padStart(2, '0') + '-' + String(Number(m[1])).padStart(2, '0');
}

async function syncOutages() {
  const { run } = require('./db');
  const resp = await fetch(OUTAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': OUTAGE_SOURCE_URL,
      'User-Agent': 'Mozilla/5.0 (compatible; MarmaraninIncisi/1.0)'
    },
    body: 'ilce=' + OUTAGE_ILCE_ID,
    signal: AbortSignal.timeout(20000)
  });
  if (!resp.ok) throw new Error('UEDAŞ HTTP ' + resp.status);
  const xml = await resp.text();
  if (xml.indexOf('<kesinti') === -1) throw new Error('UEDAŞ beklenmeyen yanıt');

  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const now = new Date();
  const groups = new Map();
  const blocks = xml.match(/<metinTablo>[\s\S]*?<\/metinTablo>/g) || [];
  for (const b of blocks) {
    const html = unesc(b.replace(/<\/?metinTablo>/g, ''));
    const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
    for (const row of rows) {
      const tds = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map(td => td.replace(/<td[^>]*>|<\/td>/g, ''));
      if (tds.length < 7) continue;
      const ilce = tds[4].trim().toLocaleUpperCase('tr-TR');
      if (ilce.indexOf('ÇINARCIK') === -1) continue; // sadece Çınarcık ilçesi
      const date = parseOutageDate(tds[0], now);
      const tm = tds[1].trim().match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
      if (!date || !tm) continue;
      const reason = trTitleCase(tds[2]);
      const key = date + '|' + tm[1] + '|' + tm[2] + '|' + reason;
      if (!groups.has(key)) {
        groups.set(key, {
          date, dateLabel: trTitleCase(tds[0]), start: tm[1].padStart(5, '0'), end: tm[2].padStart(5, '0'),
          reason, mahalleler: new Map()
        });
      }
      const g = groups.get(key);
      const mah = trTitleCase(tds[5]) || 'Diğer';
      const streets = tds[6].split(/<br\s*\/?>/i).map(s => s.replace(/<[^>]+>/g, '').trim()).filter(Boolean).map(trTitleCase);
      if (!g.mahalleler.has(mah)) g.mahalleler.set(mah, new Set());
      streets.forEach(s => g.mahalleler.get(mah).add(s));
    }
  }

  const items = Array.from(groups.values()).map(g => ({
    date: g.date, dateLabel: g.dateLabel, start: g.start, end: g.end, reason: g.reason,
    mahalleler: Array.from(g.mahalleler.entries())
      .map(([name, set]) => ({ name, streets: Array.from(set) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
  })).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  const data = { items };
  run('DELETE FROM power_outages');
  run('INSERT INTO power_outages (id, data_json, source_url, updated_at) VALUES (1,?,?,datetime(\'now\'))',
    [JSON.stringify(data), OUTAGE_SOURCE_URL]);
  console.log('[kesinti] Çınarcık için ' + items.length + ' planlı elektrik kesintisi güncellendi');
  return data;
}

async function safeSyncOutages() {
  try {
    await syncOutages();
  } catch (e) {
    console.error('[kesinti] senkronizasyon hatası:', e.message);
  }
}

// 💧 Çınarcık Belediyesi su kesintileri (planlı + son 30 gün arıza)
const SU_OUTAGE_SOURCE_URL = 'https://www.cinarcik.bel.tr/hizmetler/su-kesintileri';
const SU_SYNC_MS = 30 * 60 * 1000; // 30 dk

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)));
}

function stripTags(s) {
  return decodeHtmlEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Belediye su kesintileri sayfası SSR HTML: planlı kesinti yoksa .ks-bos bloğu,
// "Son 30 gün" listesi .ks-gecmis > li (ks-g-yer / ks-g-zaman / ks-g-tur).
async function syncSu() {
  const { run } = require('./db');
  const resp = await fetch(SU_OUTAGE_SOURCE_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarmaraninIncisi/1.0)', 'Accept-Language': 'tr' },
    signal: AbortSignal.timeout(20000)
  });
  if (!resp.ok) throw new Error('Belediye HTTP ' + resp.status);
  const html = await resp.text();

  const articleEnd = html.indexOf('<section class="ks-gecmis"');
  const headPart = articleEnd === -1 ? html : html.slice(0, articleEnd);
  const tailPart = articleEnd === -1 ? '' : html.slice(articleEnd);

  const hasEmptyState = headPart.indexOf('ks-bos') !== -1;

  const parseItems = (chunk) => {
    const out = [];
    const liRe = /<li>\s*<span class="ks-g-yer">([\s\S]*?)<\/span>\s*<span class="ks-g-zaman">([\s\S]*?)<\/span>\s*<span class="ks-g-tur">([\s\S]*?)<\/span>\s*<\/li>/g;
    let mm;
    while ((mm = liRe.exec(chunk)) !== null) {
      const placeRaw = mm[1];
      const placeMain = stripTags((placeRaw.match(/<b>([\s\S]*?)<\/b>/) || [])[1] || '');
      const placeStreets = stripTags((placeRaw.match(/<small>([\s\S]*?)<\/small>/) || [])[1] || '');
      if (!placeMain && !placeStreets) continue;
      out.push({
        place: placeMain,
        streets: placeStreets,
        time: stripTags(mm[2]).replace(/\s*·\s*/g, ' · '),
        type: stripTags(mm[3])
      });
    }
    return out;
  };

  // Planlı/aktif duyuru boş değilse: ks-bos yok demektir; "Son 30 gün" öncesi liste
  let planned = [];
  if (!hasEmptyState) {
    planned = parseItems(headPart).filter(it => /planl/i.test(it.type) || !/ar[ıi]za/i.test(it.type));
  }
  const recent = parseItems(tailPart);

  const data = { planned, recent, hasEmptyState };
  run('DELETE FROM su_outages');
  run('INSERT INTO su_outages (id, data_json, source_url, updated_at) VALUES (1,?,?,datetime(\'now\'))',
    [JSON.stringify({ planned, recent }), SU_OUTAGE_SOURCE_URL]);
  console.log('[su] planlı ' + planned.length + ' / son-30-gün ' + recent.length + ' su kesinti kaydı güncellendi');
  return data;
}

async function safeSyncSu() {
  try {
    await syncSu();
  } catch (e) {
    console.error('[su] senkronizasyon hatası:', e.message);
  }
}

function getSuOutages() {
  const { get } = require('./db');
  const out = { planned: [], recent: [], updatedAt: '', sourceUrl: SU_OUTAGE_SOURCE_URL };
  try {
    const row = get('SELECT data_json, updated_at FROM su_outages WHERE id = 1');
    if (!row || !row.data_json) return out;
    const data = JSON.parse(row.data_json);
    out.updatedAt = row.updated_at || '';
    out.planned = data.planned || [];
    out.recent = (data.recent || []).slice(0, 12);
  } catch (e) {
    console.error('[su] kayıt okunamadı:', e.message);
  }
  return out;
}

// Sadece bitmemiş (bugün ve sonrası) kesintileri döndürür; durum: active | today | upcoming
function getPowerOutages() {
  const { get } = require('./db');
  const out = { items: [], updatedAt: '', sourceUrl: OUTAGE_SOURCE_URL };
  try {
    const row = get('SELECT data_json, updated_at FROM power_outages WHERE id = 1');
    if (!row || !row.data_json) return out;
    const data = JSON.parse(row.data_json);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    const nowHm = pad(now.getHours()) + ':' + pad(now.getMinutes());
    out.updatedAt = row.updated_at || '';
    out.items = (data.items || []).filter(it => it.date > todayStr || (it.date === todayStr && it.end > nowHm)).map(it => {
      let status = 'upcoming';
      if (it.date === todayStr) status = (it.start <= nowHm && nowHm < it.end) ? 'active' : 'today';
      const streetCount = (it.mahalleler || []).reduce((s, m) => s + (m.streets || []).length, 0);
      return Object.assign({ status, streetCount }, it);
    });
  } catch (e) {
    console.error('[kesinti] kayıt okunamadı:', e.message);
  }
  return out;
}


app.use((req, res) => {
  res.locals.robotsMeta = 'noindex, nofollow';
  res.status(404).render('error', { title: 'Sayfa Bulunamadı', message: 'Aradığınız sayfa taşınmış veya kaldırılmış olabilir.', error: null });
});

app.use((err, req, res, next) => {
  console.error('[hata]', err);
  res.locals.robotsMeta = 'noindex, nofollow';
  res.status(500).render('error', { title: 'Sunucu Hatası', message: 'Bir sorun oluştu, lütfen daha sonra tekrar deneyin.', error: null });
});

initDb().then(() => {
  const bcrypt = require('bcryptjs');
  const { get, run } = require('./db');
  const admin = get('SELECT * FROM users WHERE username = ?', ['admin']);
  if (!admin || !admin.username) {
    const initialPassword = process.env.ADMIN_PASSWORD || 'cinarcik2024';
    const hash = bcrypt.hashSync(initialPassword, 10);
    run('INSERT INTO users (username, password) VALUES (?, ?)', ['admin', hash]);
    console.log('Varsayılan admin kullanıcısı oluşturuldu (kullanıcı: admin). Şifre env ADMIN_PASSWORD ile belirlenir; ilk girişte değiştirin.');
  }

  const fs = require('fs');
  const imgPath = path.join(__dirname, 'public', 'img', 'uploads');
  if (!fs.existsSync(imgPath)) fs.mkdirSync(imgPath, { recursive: true });

  safeSyncNobetci();
  setInterval(safeSyncNobetci, NOBETCI_SYNC_MS);
  safeSyncSefer();
  setInterval(safeSyncSefer, FERRY_SYNC_MS);
  safeSyncUlasim();
  setInterval(safeSyncUlasim, ULASIM_SYNC_MS);
  safeSyncIdo();
  setInterval(safeSyncIdo, IDO_SYNC_MS);
  safeSyncOutages();
  setInterval(safeSyncOutages, OUTAGE_SYNC_MS);
  safeSyncSu();
  setInterval(safeSyncSu, SU_SYNC_MS);

  app.listen(PORT, () => {
    console.log(`Marmara'nın İncisi http://localhost:${PORT} adresinde çalışıyor`);
  });
});