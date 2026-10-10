require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDb } = require('./db');
const { tx, txFields, txArray, txJsonArrayField } = require('./translator');

const app = express();
app.set('trust proxy', 1);
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
const helmet = require('helmet');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
const PORT = process.env.PORT || 3000;

const engine = require('ejs-mate');
app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', index: false }));
app.use('/images', express.static(path.join(__dirname, 'images'), { maxAge: '30d' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'cinarcik-portal-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));

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
  const m = req.url.match(/^\/(en|ru|ar)(?=\/|$|\?)/);
  req.lang = m ? m[1] : 'tr';
  if (m) {
    req.url = req.url.slice(m[1].length + 1) || '/';
    if (req.url === '') req.url = '/';
  }
  res.locals.isAdmin = req.session.isAdmin || false;
  res.locals.isGoogleAuth = req.session.isGoogleAuth || false;
  res.locals.googleUser = req.session.googleUser || null;
  res.locals.path = req.path;
  res.locals.lang = req.lang;
  res.locals.lp = req.lang === 'tr' ? '' : '/' + req.lang;
  res.locals.dir = 'ltr';
  res.locals.siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  res.locals.t = (key) => i18n.t(req.lang, key);
  res.locals.langs = i18n.LANGS;
  next();
});

function isAuthenticated(req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

async function sendAdmin2FACode(code) {
  const to = process.env.ADMIN_2FA_EMAIL || 'kerimkaplan@yahoo.com';
  const subject = 'Admin doğrulama kodu';
  const text = 'Admin paneli giriş doğrulama kodunuz: ' + code + '\n\nBu kod 10 dakika geçerlidir.';
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
    } else {
      url = 'https://api.sendgrid.com/v3/mail/send';
      headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
      payload = {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: 'text/plain', value: text }]
      };
    }
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!resp.ok) throw new Error(provider + ' HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
    console.log('[2fa] ' + provider + ' ile gönderildi →', to);
    return;
  }

  // 2) Yerel fallback: SMTP
  const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
  const smtpUser = process.env.SMTP_USER || process.env.GMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD;
  if (!smtpHost || !smtpUser || !smtpPass) {
    console.log('[2fa] SMTP ayarı yok — kod konsola yazıldı: ' + code);
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
    subject,
    text
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
    .map(r => ({ label: ferryShortName(r.destination), columns: r.columns }))
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
  const langs = ['', '/en', '/ru', '/ar'];
  const entries = [];

  const addEntry = (path, lastmod) => {
    entries.push({ path, lastmod: lastmod || new Date().toISOString().slice(0, 10) });
  };

  // Statik sayfalar
  ['/', '/haberler', '/duyurular', '/mekanlar', '/gezilecek-yerler', '/rehber', '/iletisim', '/cinarcik-hakkinda']
    .forEach(p => addEntry(p));

  // Haberler (son 500)
  try {
    all("SELECT slug, id, updated_at, created_at FROM news WHERE status='active' ORDER BY created_at DESC LIMIT 500")
      .forEach(n => addEntry('/haber/' + (n.slug || n.id), (n.updated_at || n.created_at || '').slice(0, 10)));
  } catch (e) { console.error('sitemap news:', e.message); }

  // Mekanlar
  try {
    all("SELECT id, created_at FROM places WHERE status='active'")
      .forEach(p => addEntry('/mekan/' + p.id, (p.created_at || '').slice(0, 10)));
  } catch (e) { console.error('sitemap places:', e.message); }

  // Gezilecek yerler
  try {
    all("SELECT id, created_at FROM sightseeing WHERE status='active'")
      .forEach(s => addEntry('/gezilecek-yer/' + s.id, (s.created_at || '').slice(0, 10)));
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

app.get('/', async (req, res) => {
  const { all } = require('./db');
  const announcements = all('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 4');
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
  const pharmacies = all("SELECT * FROM pharmacies WHERE status = 'active' ORDER BY name ASC");
  const ferryRows = all('SELECT * FROM ferry_schedules ORDER BY id ASC').map(r => {
    let columns = [];
    try { columns = JSON.parse(r.data_json || '[]'); } catch (e) { columns = []; }
    return { origin: r.origin || 'Çınarcık İskele', destination: r.destination, columns, updated_at: r.updated_at };
  });
  const lang = req.lang;
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  await Promise.all([
    txArray(announcements, ['title', 'content'], lang),
    txArray(places, ['description', 'working_hours'], lang),
    txArray(companies, ['description', 'sector'], lang),
    txArray(sightseeing, ['title', 'summary', 'description'], lang)
  ]);
  res.render('home', {
    announcements, places, companies, pharmacies, sightseeing, ferryGroups: buildFerryGroups(ferryRows),
    pageTitle: 'Çınarcık Haber, Mekan ve Gezi Rehberi | ' + i18n.t(req.lang, 'heroTagline'),
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
  const headlines = all("SELECT * FROM news WHERE status='active' AND is_headline=1 AND (expires_at IS NULL OR expires_at='' OR expires_at > datetime('now')) ORDER BY headline_order ASC, created_at DESC LIMIT 10");
  const regularNews = all("SELECT * FROM news WHERE status='active' AND (is_headline=0 OR is_headline IS NULL) AND (expires_at IS NULL OR expires_at='' OR expires_at > datetime('now')) ORDER BY created_at DESC");
  await Promise.all([
    txArray(headlines, ['title', 'summary'], req.lang),
    txArray(regularNews, ['title', 'summary'], req.lang)
  ]);
  res.render('news', { headlines, regularNews });
});

app.get('/haber/:slug', async (req, res) => {
  const { get, all, run } = require('./db');
  const article = get("SELECT * FROM news WHERE slug = ? OR id = ?", [req.params.slug, isNaN(parseInt(req.params.slug)) ? -1 : req.params.slug]);
  if (!article || !article.id) return res.redirect('/haberler');
  run("UPDATE news SET views_count = views_count + 1 WHERE id = ?", [article.id]);
  const recent = all("SELECT id, slug, title, main_image_url, created_at FROM news WHERE id != ? AND status='active' ORDER BY created_at DESC LIMIT 4", [article.id]);
  await Promise.all([
    txFields(article, ['title', 'summary', 'content', 'category', 'badge_text'], req.lang),
    txArray(recent, ['title'], req.lang)
  ]);
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  const absUrl = siteUrl + lp + '/haber/' + (article.slug || article.id);
  res.render('news-detail', {
    article, recent, req,
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
  const news = all(`SELECT id, slug, title, badge_text, summary, main_image_url, headline_order, views_count, created_at, expires_at
    FROM news
    WHERE status='active'
      AND (expires_at IS NULL OR expires_at='' OR expires_at > datetime('now'))
    ORDER BY headline_order ASC, created_at DESC
    LIMIT ?`, [limit]);
  res.json({ success: true, count: news.length, news });
});

app.get('/api/news/:slug', (req, res) => {
  const { get, run } = require('./db');
  const item = get("SELECT * FROM news WHERE slug = ? OR id = ?", [req.params.slug, isNaN(parseInt(req.params.slug)) ? -1 : req.params.slug]);
  if (!item || !item.id) return res.status(404).json({ success: false, error: 'Haber bulunamadı' });
  run("UPDATE news SET views_count = views_count + 1 WHERE id = ?", [item.id]);
  res.json({ success: true, news: item });
});

app.get('/duyurular', async (req, res) => {
  const { all } = require('./db');
  const announcements = all('SELECT * FROM announcements ORDER BY created_at DESC');
  await txArray(announcements, ['title', 'content'], req.lang);
  res.render('announcements', { announcements });
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
    res.render('places', { places, selectedType: type });
  } catch (error) {
    console.error('Mekanlar hatası:', error);
    res.status(500).send('Sunucu hatası oluştu.');
  }
});

app.get('/mekan/:id', async (req, res) => {
  try {
    const { get, all } = require('./db');
    const placeId = req.params.id;
    const place = get('SELECT * FROM places WHERE id = ?', [placeId]);
    if (!place) {
      return res.status(404).render('place-detail', {
        place: null,
        places: [],
        embedMapUrl: '',
        pageTitle: 'Mekan Bulunamadı'
      });
    }
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
      embedMapUrl = convertGoogleMapsToEmbed(place.map_link);
    }
    const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
    const lp = req.lang === 'tr' ? '' : '/' + req.lang;
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
      "url": siteUrl + lp + '/mekan/' + place.id,
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
  res.render('sightseeing', { items, categories, pageTitle: 'Gezilecek Yerler' });
});

app.get('/gezilecek-yer/:id', async (req, res) => {
  const { get, all, parseGallery } = require('./db');
  const item = get("SELECT * FROM sightseeing WHERE id = ? AND status = 'active'", [req.params.id]);
  if (!item || !item.id) return res.redirect('/gezilecek-yerler');
  item.gallery = parseGallery(item.gallery_images);
  const others = all("SELECT id, title, summary, image, category, location FROM sightseeing WHERE id != ? AND status = 'active' ORDER BY sort_order ASC, created_at DESC", [parseInt(req.params.id) || -1]);
  await Promise.all([
    txFields(item, ['title', 'summary', 'description', 'category'], req.lang),
    txArray(others, ['title', 'summary', 'category'], req.lang)
  ]);
  const siteUrl = (process.env.SITE_URL || 'https://marmaraninincisi.com').replace(/\/$/, '');
  const lp = req.lang === 'tr' ? '' : '/' + req.lang;
  res.render('sightseeing-detail', {
    item, others,
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
          "url": siteUrl + lp + '/gezilecek-yer/' + item.id,
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
  const { all, parseGallery } = require('./db');
  const items = all('SELECT * FROM sightseeing ORDER BY sort_order ASC, created_at DESC');
  items.forEach(i => { i.gallery = parseGallery(i.gallery_images); });
  res.render('admin/sightseeing', { items });
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
    if (err) return next(err);
    const { run, get, parseGallery } = require('./db');
    const { title, summary, description, category, location, map_link, sort_order, status, edit_id, existing_gallery, remove_image } = req.body;
    if (!title || !String(title).trim()) {
      return res.render('admin/sightseeing-form', { edit: null, error: 'Başlık zorunludur' });
    }
    let image = (req.files && req.files.image && req.files.image[0]) ? pubUrl(req.files.image[0]) : '';

    let gallery = [];
    if (existing_gallery) {
      try {
        const parsed = JSON.parse(existing_gallery);
        if (Array.isArray(parsed)) gallery = parsed;
      } catch (e) { gallery = []; }
    }
    if (req.files && req.files.gallery_files) {
      req.files.gallery_files.forEach(f => gallery.push(pubUrl(f)));
    }

    const statusVal = status === 'passive' ? 'passive' : 'active';
    const order = parseInt(sort_order) || 999;
    const values = [
      String(title).trim(),
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
      run(`UPDATE sightseeing SET title=?, summary=?, description=?, category=?, location=?, map_link=?, image=?, gallery_images=?, sort_order=?, status=? WHERE id=?`,
        [...values, edit_id]);
    } else {
      run(`INSERT INTO sightseeing (title, summary, description, category, location, map_link, image, gallery_images, sort_order, status) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        values);
    }
    res.redirect('/admin/gezilecek-yerler');
  });
});

app.post('/admin/gezilecek-yer-sil/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM sightseeing WHERE id = ?', [req.params.id]);
  res.redirect('/admin/gezilecek-yerler');
});

app.post('/admin/gezilecek-yer-toggle/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const row = get('SELECT status FROM sightseeing WHERE id = ?', [req.params.id]);
  const nextStatus = row && row.status === 'active' ? 'passive' : 'active';
  run('UPDATE sightseeing SET status = ? WHERE id = ?', [nextStatus, req.params.id]);
  res.redirect('/admin/gezilecek-yerler');
});

// ---- İletişim (Bize Ulaşın) ----
const RECAPTCHA_SITE_KEY = process.env.RECAPTCHA_SITE_KEY || '';
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY || '';

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

// reCAPTCHA her zaman v2 checkbox ("Ben robot değilim") olarak kullanılır.
// Invisible/v3 karmaşası widget'ın hiç render edilmemesine yol açıyordu.
async function contactView(sent, error, form) {
  return {
    sent, error, form,
    recaptchaSiteKey: RECAPTCHA_SITE_KEY,
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
  let code = o.refreshCaptcha ? null : latestCaptcha(req);
  if (!code) code = issueCaptcha(req);
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

app.post('/iletisim', async (req, res) => {
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

  if (!captchaOk(req, captcha)) {
    return renderContact(req, res, {
      status: 400,
      error: 'Güvenlik kodu hatalı veya süresi doldu. Görseldeki yeni kodu girip tekrar deneyin.',
      form: form,
      refreshCaptcha: true
    });
  }

  let rcToken = req.body['g-recaptcha-response'];
  if (Array.isArray(rcToken)) rcToken = rcToken[0];
  const rc = await verifyRecaptcha(rcToken);
  if (!rc.ok) {
    return renderContact(req, res, { status: 400, error: rc.error, form: form });
  }

  run('INSERT INTO contact_messages (name, email, subject, message) VALUES (?,?,?,?)',
    [name, email, subject, message]);
  req.session.captchaCodes = [];
  res.redirect('/iletisim?sent=1');
});

app.get('/admin/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
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
      loginAttempts.delete(req.ip);
      res.redirect('/admin');
    });
  }
  res.render('admin/login', { error: 'Doğrulama kodu hatalı.', otpStep: true, otpSentTo: process.env.ADMIN_2FA_EMAIL || 'kerimkaplan@yahoo.com' });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/admin', isAuthenticated, async (req, res) => {
  const { all, get } = require('./db');
  const announcements = all('SELECT * FROM announcements ORDER BY created_at DESC');
  const places = all('SELECT * FROM places ORDER BY created_at DESC');
  const news = all("SELECT * FROM news ORDER BY headline_order ASC, created_at DESC");
  const newsCount = get('SELECT COUNT(*) as cnt FROM news');
  const companies = all('SELECT * FROM companies ORDER BY sort_order ASC, created_at DESC');
  const pendingComments = get("SELECT COUNT(*) as cnt FROM comments WHERE status = 'pending'");
  const totalComments = get('SELECT COUNT(*) as cnt FROM comments');
  const unreadMessages = get("SELECT COUNT(*) as cnt FROM contact_messages WHERE status = 'new'");
  const sightseeingCount = get('SELECT COUNT(*) as cnt FROM sightseeing');
  res.render('admin/dashboard', {
    announcements, places, news,
    newsCount: (newsCount && newsCount.cnt) ? newsCount.cnt : 0,
    companies,
    pendingCommentsCount: (pendingComments && pendingComments.cnt) ? pendingComments.cnt : 0,
    totalCommentsCount: (totalComments && totalComments.cnt) ? totalComments.cnt : 0,
    unreadMessagesCount: (unreadMessages && unreadMessages.cnt) ? unreadMessages.cnt : 0,
    sightseeingCount: (sightseeingCount && sightseeingCount.cnt) ? sightseeingCount.cnt : 0
  });
});

app.get('/admin/haberler', isAuthenticated, (req, res) => {
  const { all } = require('./db');
  const news = all('SELECT * FROM news ORDER BY headline_order ASC, created_at DESC');
  res.render('admin/news-list', { news });
});

app.post('/admin/haberler/toggle/:id', isAuthenticated, (req, res) => {
  const { get, run } = require('./db');
  const item = get('SELECT * FROM news WHERE id = ?', [req.params.id]);
  if (item && item.id) {
    run("UPDATE news SET status = ?, updated_at = datetime('now') WHERE id = ?", [item.status === 'active' ? 'passive' : 'active', item.id]);
  }
  res.redirect('/admin/haberler');
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
  if (req.files && req.files.gallery_files && Array.isArray(req.files.gallery_files)) {
    req.files.gallery_files.forEach(function(f) { galleryArr.push(pubUrl(f)); });
  }

  if (!title || !content) {
    const edit = edit_id ? get('SELECT * FROM news WHERE id = ?', [edit_id]) : null;
    return res.render('admin/news-form', { edit, error: 'Başlık ve içerik zorunludur' });
  }

  const expiresValue = (expires_at && expires_at.trim()) ? expires_at.trim() : null;
  const isHeadline = (is_headline === 'on' || is_headline === '1' || is_headline === 'true') ? 1 : 0;
  const statusVal = status === 'passive' ? 'passive' : 'active';
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
  } else {
    const slug = ensureUniqueSlug(slugify(title), null);
    run(`INSERT INTO news (title, slug, badge_text, summary, content, main_image_url, gallery_images, is_headline, headline_order, status, expires_at, category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [title, slug, badge_text || '', summary || '', content, main_image_url, JSON.stringify(galleryArr), isHeadline, order, statusVal, expiresValue, category || 'Gündem']);
  }
  res.redirect('/admin/haberler');
});

app.post('/admin/haber-sil/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM news WHERE id = ?', [req.params.id]);
  res.redirect('/admin/haberler');
});

const multer = require('multer');
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'public', 'img', 'uploads'),
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') && file.mimetype !== 'image/svg+xml') return cb(null, true);
    cb(null, false);
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
  if (R2) return '/uploads/' + file.filename;
  return '/img/uploads/' + file.filename;
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

function withUpload(mw) {
  return function(req, res, next) {
    mw(req, res, function(err) {
      if (err) return next(err);
      finishUploads(req, res, next);
    });
  };
}

app.get('/uploads/:file', async (req, res) => {
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
});

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
  const { run } = require('./db');
  const { title, content, category, edit_id, existing_image } = req.body;
  let image = existing_image || '';
  const safeTitle = title || '';
  const safeContent = content || '';
  if (req.file) image = pubUrl(req.file);
  if (edit_id) {
    run('UPDATE announcements SET title=?, content=?, category=?, image=? WHERE id=?', [safeTitle, safeContent, category || 'duyuru', image, edit_id]);
  } else {
    run('INSERT INTO announcements (title, content, category, image) VALUES (?,?,?,?)', [safeTitle, safeContent, category || 'duyuru', image]);
  }
  res.redirect('/admin');
});

app.post('/admin/duyuru-sil/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  res.redirect('/admin');
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
  run('UPDATE about_page SET banner_subtitle=?, content=?, cta_title=?, cta_text=?, updated_at=datetime(\'now\') WHERE id=1',
    [banner_subtitle || '', content, cta_title || '', cta_text || '']);
  res.redirect('/admin/hakkinda?saved=1');
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
  if (req.files && req.files.gallery_images && Array.isArray(req.files.gallery_images)) {
    req.files.gallery_images.forEach(function(f) { galleryArr.push(pubUrl(f)); });
  }

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
    return res.redirect('/admin?updated=1&tab=places');
  } else {
    const slug = ensureUniqueSlug(slugify(name), null, 'places');
    run(`INSERT INTO places (name, slug, category, cuisine_type, establishment_type, meal_type, address, phone, working_hours, map_link, features, main_image_url, gallery_images, description, is_featured, status, display_until, sort_order, google_reviews_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, slug, category, cuisine_type || '', JSON.stringify(estTypeArr), JSON.stringify(mealTypeArr), address || '', phone || '', working_hours || '', map_link || '', JSON.stringify(features), main_image_url, JSON.stringify(galleryArr), description || '', isFeatured, statusVal, display_until || null, parseInt(sort_order) || 0, google_reviews_url || '']);
    return res.redirect('/admin?created=1&tab=places');
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

  const fs = require('fs');
  const uploadsDir = path.join(__dirname, 'public', 'img', 'uploads');
  const safeName = path.basename(String(image_url || ''));
  const filePath = path.join(uploadsDir, safeName);
  if (filePath.startsWith(uploadsDir) && fs.existsSync(filePath)) {
    fs.unlink(filePath, () => {});
  }

  res.json({ success: true, gallery: filtered });
});

app.post('/admin/mekan-sil/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM places WHERE id = ?', [req.params.id]);
  res.redirect('/admin');
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
  res.render('rehber', { companies, selectedType: type });
});

app.get('/rehber/:slug', async (req, res) => {
  const { get, all } = require('./db');
  const company = get("SELECT * FROM companies WHERE slug = ? OR id = ?", [req.params.slug, isNaN(parseInt(req.params.slug)) ? -1 : req.params.slug]);
  if (!company || !company.id) return res.redirect('/rehber');
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
  if (company.map_link) {
    embedMapUrl = convertGoogleMapsToEmbed(company.map_link);
  }
  res.render('rehber-detail', { company, embedMapUrl, pageTitle: company.name });
});

// Admin firma yönetimi
app.get('/admin/firmalar', isAuthenticated, (req, res) => {
  const { all } = require('./db');
  const companies = all('SELECT * FROM companies ORDER BY sort_order ASC, created_at DESC');
  res.render('admin/company-list', { companies });
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
  const { name, category, sector, address, phone, website, email, working_hours, map_link, google_reviews_url, description, status, is_featured, sort_order, edit_id } = req.body;

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
  if (req.files && req.files.gallery_images && Array.isArray(req.files.gallery_images)) {
    req.files.gallery_images.forEach(function(f) { galleryArr.push(pubUrl(f)); });
  }

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
    run(`UPDATE companies SET name=?, slug=?, category=?, sector=?, address=?, phone=?, website=?, email=?, working_hours=?, map_link=?, google_reviews_url=?, description=?, logo_url=?, gallery_images=?, features=?, is_featured=?, status=?, sort_order=? WHERE id=?`,
      [name, slug, category || 'Genel', sector || '', address || '', phone || '', website || '', email || '', working_hours || '', map_link || '', google_reviews_url || '', description || '', logo_url, JSON.stringify(galleryArr), JSON.stringify(features), isFeatured, statusVal, parseInt(sort_order) || 0, edit_id]);
    return res.redirect('/admin/firmalar?updated=1');
  } else {
    const slug = ensureUniqueSlug(slugify(name), null, 'companies');
    run(`INSERT INTO companies (name, slug, category, sector, address, phone, website, email, working_hours, map_link, google_reviews_url, description, logo_url, gallery_images, features, is_featured, status, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, slug, category || 'Genel', sector || '', address || '', phone || '', website || '', email || '', working_hours || '', map_link || '', google_reviews_url || '', description || '', logo_url, JSON.stringify(galleryArr), JSON.stringify(features), isFeatured, statusVal, parseInt(sort_order) || 0]);
    return res.redirect('/admin/firmalar?created=1');
  }
});

app.post('/admin/firma-sil/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM companies WHERE id = ?', [req.params.id]);
  res.redirect('/admin/firmalar');
});

app.post('/admin/firma-toggle/:id', isAuthenticated, (req, res) => {
  const { get, run } = require('./db');
  const item = get('SELECT * FROM companies WHERE id = ?', [req.params.id]);
  if (item && item.id) {
    run("UPDATE companies SET status = ? WHERE id = ?", [item.status === 'active' ? 'passive' : 'active', item.id]);
  }
  res.redirect('/admin/firmalar');
});

// ==================== GOOGLE OAuth & YORUM SİSTEMİ ====================

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';

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
console.log('\x1b[36m→ GOOGLE_CALLBACK_URL:\x1b[0m', GOOGLE_CALLBACK_URL);

// Alan adı uyuşmazlığı koruması: callback URL, SITE_URL alan adıyla aynı olmalı.
// Farklıysa Google girişi sonrası kullanıcı geçersiz/eksik SSL'li domain'e
// yönlendirilir → tarayıcı "This connection is not private" uyarısı gösterir.
(function validateCallbackHost() {
  try {
    const siteHost = new URL(process.env.SITE_URL || 'https://marmaraninincisi.com').host;
    const cbHost = new URL(GOOGLE_CALLBACK_URL).host;
    if (cbHost !== siteHost && cbHost !== 'localhost:3000' && cbHost !== 'localhost') {
      console.warn('\x1b[31m✗ GOOGLE_CALLBACK_URL alan adı SITE_URL ile uyuşmuyor!\x1b[0m');
      console.warn('   SITE_URL host:    ' + siteHost);
      console.warn('   CALLBACK host:    ' + cbHost);
      console.warn('   → Google girişi "This connection is not private" hatası verir.');
      console.warn('   → Render env: GOOGLE_CALLBACK_URL=https://' + siteHost + '/auth/google/callback');
    }
  } catch (e) { /* geçersiz URL — üstteki log yeterli */ }
})();

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
    redirect_uri: GOOGLE_CALLBACK_URL,
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
        redirect_uri: GOOGLE_CALLBACK_URL,
        grant_type: 'authorization_code'
      })
    });
    
    const tokenData = await tokenResponse.json();
    
    if (tokenData.error) {
      console.error('Token hatası:', tokenData.error, tokenData.error_description);
      console.error('Gönderilen parametreler: client_id=' + GOOGLE_CLIENT_ID.substring(0, 15) + '..., redirect_uri=' + GOOGLE_CALLBACK_URL);
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
  res.redirect('/');
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
  const comments = all("SELECT id, user_name, user_avatar, content, created_at FROM comments WHERE news_id = ? AND status = 'approved' ORDER BY created_at DESC", [req.params.newsId]);
  res.json({ success: true, comments });
});

// Google auth middleware
function requireGoogleAuth(req, res, next) {
  if (req.session.isGoogleAuth && req.session.googleUser) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'Google ile giriş yapmanız gerekiyor' });
}

// Yeni yorum ekle (sadece Google auth ile)
app.post('/api/comments', requireGoogleAuth, (req, res) => {
  const { run } = require('./db');
  const { news_id, content } = req.body;
  const user = req.session.googleUser;

  if (!news_id || !content) {
    return res.status(400).json({ success: false, error: 'Yorum içeriği gerekli' });
  }

  if (content.length > 1000) {
    return res.status(400).json({ success: false, error: 'Yorum 1000 karakteri aşamaz' });
  }

  run("INSERT INTO comments (news_id, user_name, user_email, user_avatar, content, status) VALUES (?,?,?,?,?,?)",
    [news_id, user.name, user.email, user.avatar, content, 'pending']);

  res.json({ success: true, message: 'Yorumunuz alındı, onaylandıktan sonra yayınlanacaktır' });
});

// Admin yorum yönetimi
app.get('/admin/comments', isAuthenticated, (req, res) => {
  const { all } = require('./db');
  const pendingComments = all("SELECT c.*, n.title as news_title, n.slug as news_slug FROM comments c LEFT JOIN news n ON c.news_id = n.id WHERE c.status = 'pending' ORDER BY c.created_at DESC");
  const approvedComments = all("SELECT c.*, n.title as news_title, n.slug as news_slug FROM comments c LEFT JOIN news n ON c.news_id = n.id WHERE c.status = 'approved' ORDER BY c.created_at DESC");
  const hiddenComments = all("SELECT c.*, n.title as news_title, n.slug as news_slug FROM comments c LEFT JOIN news n ON c.news_id = n.id WHERE c.status = 'hidden' ORDER BY c.created_at DESC");
  res.render('admin/comments', { pendingComments, approvedComments, hiddenComments });
});

// Yorum onayla
app.post('/admin/comments/approve/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run("UPDATE comments SET status = 'approved' WHERE id = ?", [req.params.id]);
  res.redirect('/admin/comments');
});

// Yorum görünürlük değiştir (approved<->hidden)
app.post('/admin/comments/toggle/:id', isAuthenticated, (req, res) => {
  const { run, get } = require('./db');
  const comment = get("SELECT status FROM comments WHERE id = ?", [req.params.id]);
  if (!comment) return res.redirect('/admin/comments');
  const newStatus = comment.status === 'approved' ? 'hidden' : 'approved';
  run("UPDATE comments SET status = ? WHERE id = ?", [newStatus, req.params.id]);
  res.redirect('/admin/comments');
});

// Yorum düzenle (admin)
app.post('/admin/comments/edit/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  const { content } = req.body;
  if (!content || content.trim().length === 0) return res.redirect('/admin/comments');
  run("UPDATE comments SET content = ? WHERE id = ?", [content.trim().substring(0, 1000), req.params.id]);
  res.redirect('/admin/comments');
});

// Yorum sil
app.post('/admin/comments/delete/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM comments WHERE id = ?', [req.params.id]);
  res.redirect('/admin/comments');
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
  res.redirect('/admin/iletisim');
});

app.post('/admin/iletisim/delete/:id', isAuthenticated, (req, res) => {
  const { run } = require('./db');
  run('DELETE FROM contact_messages WHERE id = ?', [req.params.id]);
  res.redirect('/admin/iletisim');
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
    const w = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=40.6475&longitude=29.0736&current=temperature_2m,weather_code&timezone=Europe/Istanbul');
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
const FORECAST_CACHE_MS = 30 * 60 * 1000;

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

app.get('/api/weather-forecast', (req, res) => {
  if (forecastCache.data && (Date.now() - forecastCache.ts) < FORECAST_CACHE_MS) {
    return res.json({ success: true, forecast: forecastCache.data });
  }

  // Bugünün tarihi ve ayın son günü
  const now = new Date();
  const todayStr = fmtDateLocal(now);
  const year = now.getFullYear();
  const month = now.getMonth();
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
  const todayDay = now.getDate();
  const remainingDays = lastDayOfMonth - todayDay;

  // 16 günlük tahmin
  const forecastUrl = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=40.6475&longitude=29.0736'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max'
    + '&timezone=Europe/Istanbul&forecast_days=16';

  fetch(forecastUrl, { signal: AbortSignal.timeout(10000) })
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
      res.json({ success: true, forecast });
    })
    .catch(err => {
      console.log('Forecast fetch error:', err.message);
      if (forecastCache.data) {
        return res.json({ success: true, forecast: forecastCache.data });
      }
      res.json({ success: false, forecast: [], error: err.message });
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

function convertGoogleMapsToEmbed(url) {
  if (!url) return '';

  // Plus Code detection (e.g. "J4W8+6M Çınarcık, Yalova" or "J4W8+6M" or "J4W8+6M, Yalova")
  const plusCodeMatch = url.match(/^([A-Z0-9]{4,5}\+[A-Z0-9]{2,3})[,\s]+(.+)$/i);
  const purePlusCode = url.match(/^([A-Z0-9]{4,5}\+[A-Z0-9]{2,3})$/i);
  if (plusCodeMatch) {
    const query = plusCodeMatch[1] + ' ' + plusCodeMatch[2].trim();
    return 'https://www.google.com/maps?q=' + encodeURIComponent(query) + '&output=embed';
  }
  if (purePlusCode) {
    return 'https://www.google.com/maps?q=' + encodeURIComponent(purePlusCode[1]) + '&output=embed';
  }

  // Try to extract daddr (destination address) from URL
  try {
    const urlObj = new URL(url);
    const daddr = urlObj.searchParams.get('daddr');
    if (daddr) {
      return 'https://www.google.com/maps?q=' + encodeURIComponent(daddr) + '&output=embed';
    }
  } catch (e) {}

  // Fallback: use q parameter or address extraction
  let embedUrl = url;

  // If it's a Google Maps URL, try to extract the address and create a clean embed
  if (url.includes('google.com/maps')) {
    // Try to get daddr from the URL string
    const daddrMatch = url.match(/[?&]daddr=([^&]+)/);
    if (daddrMatch) {
      const address = decodeURIComponent(daddrMatch[1]);
      return 'https://www.google.com/maps?q=' + encodeURIComponent(address) + '&output=embed';
    }
    // Try to get q parameter
    const qMatch = url.match(/[?&]q=([^&]+)/);
    if (qMatch) {
      const query = decodeURIComponent(qMatch[1]);
      return 'https://www.google.com/maps?q=' + encodeURIComponent(query) + '&output=embed';
    }
  }

  return embedUrl;
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

  const page = await fetch(NOBETCI_BASE, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text());
  const token = (page.match(/id="h"[^>]*value="([^"]+)"/) || [])[1];
  if (!token) throw new Error('nöbetçi eczane: doğrulama anahtarı bulunamadı');

  const post = (params) => fetch(NOBETCI_BASE + 'index.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: new URLSearchParams(params).toString()
  }).then(r => r.json());

  const ilceData = await post({ jx: '1', islem: 'get_ilce', il: NOBETCI_IL, h: token });
  if (!ilceData || ilceData.error !== 0 || !Array.isArray(ilceData.ilceler)) {
    throw new Error('nöbetçi eczane: ilçe listesi alınamadı');
  }
  const ilce = ilceData.ilceler.map(x => x.ilce).find(x => String(x).toLocaleLowerCase('tr') === NOBETCI_ILCE);
  if (!ilce) throw new Error('nöbetçi eczane: Çınarcık ilçesi bulunamadı');

  const data = await post({ jx: '1', islem: 'get_ilce_eczane', ilce, h: token });
  if (!data || data.error !== 0 || !Array.isArray(data.eczaneler)) {
    throw new Error('nöbetçi eczane: eczane listesi alınamadı');
  }

  run('DELETE FROM pharmacies');
  let count = 0;
  data.eczaneler.forEach(e => {
    const name = stripHtml(e.eczane_ad);
    if (!name) return;
    let phone = String(e.eczane_tel || '').replace(/\D/g, '');
    if (phone.length === 10) phone = '0' + phone;
    if (phone.length > 10) phone = phone.slice(0, 11);
    const phoneFmt = phone.length === 11
      ? phone.slice(0, 4) + ' ' + phone.slice(4, 7) + ' ' + phone.slice(7, 9) + ' ' + phone.slice(9, 11)
      : (e.eczane_tel || '');
    run('INSERT INTO pharmacies (name, address, phone, duty_note, status) VALUES (?,?,?,?,?)', [
      name,
      stripHtml(e.adres).replace(/^Adres:\s*/i, '').replace(/\s*,\s*,/g, ',').replace(/,\s*$/, '').trim(),
      phoneFmt,
      stripHtml(e.nobet_bitis),
      'active'
    ]);
    count++;
  });
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
    results.push({ origin: dir.origin, destination: decodeEntities(v.Value), columns });
  }
  return results;
}

async function syncSeferSaatleri() {
  const { run } = require('./db');

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
    run('INSERT INTO ferry_schedules (origin, destination, data_json, updated_at) VALUES (?,?,?,datetime(\'now\'))',
      [r.origin, r.destination, JSON.stringify(r.columns)]);
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


app.use((req, res) => {
  res.status(404).render('error', { title: 'Sayfa Bulunamadı', message: 'Aradığınız sayfa taşınmış veya kaldırılmış olabilir.', error: null });
});

app.use((err, req, res, next) => {
  console.error('[hata]', err);
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

  app.listen(PORT, () => {
    console.log(`Marmara'nın İncisi http://localhost:${PORT} adresinde çalışıyor`);
  });
});