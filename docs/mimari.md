# Marmara'nın İncisi — Sistem Mimari Dokümanı

Son güncelleme: Ekim 2026

## 1. Genel Bakış

Çınarcık yerel portalı; haber, duyuru (liste + içerik sayfası), mekân rehberi,
gezi noktaları, firma rehberi, vapur/saat bilgisi, hava durumu ve döviz/altın
ticker'ı içeren çok dilli (TR/EN/RU/AR) bir Express uygulaması. Ayrıca
OpenStreetMap tabanlı haritalar ve admin tarafında trafik raporları
(sayfa görüntülenme + ziyaretçi IP) bulunur. Tamamı ücretsiz (free tier)
servislerle çalışır.

```
Ziyaretçi
   │  HTTPS
   ▼
Cloudflare (DNS + opsiyonel proxy)
   │
   ▼
Render.com — Free Web Service (Node 20, Express + EJS)
   ├── SQLite dosyası: db/cinarcik.db   (kalıcı değil, bkz. §6)
   ├── Yüklenen görseller: public/img/uploads (kalıcı değil)
   └── Harici API'ler: Brevo (2FA mail), Google OAuth, reCAPTCHA
```

## 2. Kod Deposu ve Deploy

| Öğe | Değer |
|---|---|
| Repo | `github.com/cinarcikofficial-beep/cinarcikportal` |
| Branch | `main` |
| Deploy | `main`'e push → Render otomatik deploy |
| Build | `npm install` |
| Start | `node server.js` |
| Health check | `GET /` |
| Blueprint | `render.yaml` (repo kökünde) |

Env değişkenleri iki yerden yönetilir:

- `render.yaml` → Blueprint ile senkronize olan değerler (koda gömülü olanlar)
- Render Dashboard → **Environment** → `sync: false` alanlar (secret'lar repo'ya girmez)

## 3. Altyapı

### 3.1 Render.com (Free plan)

- Servis: `cinarcik-portal`
- Adresler: `https://cinarcikportal.onrender.com` + `https://marmaraninincisi.com`
- Compute: 0.1 CPU / 512 MB RAM, ücretsiz kota 750 saat/ay
- Özel domain için sertifika Render tarafından otomatik sağlanır (Let's Encrypt)

### 3.2 Cloudflare (DNS)

Alan adı: `marmaraninincisi.com` (dikkat: ortada `ni` var)

| Kayıt | Tip | Hedef | Not |
|---|---|---|---|
| `@` | A | `216.24.57.16`, `216.24.57.18` | Render, DNS only (gri bulut) |
| `www` | CNAME | `cinarcikportal.onrender.com` | Proxied (turuncu) |

- SSL/TLS encryption mode: **Full**
- `AAAA` (IPv6) kaydı **bulunmamalı** — Render IPv6 desteklemiyor
- Render tarafında **Settings → Custom Domains** üzerinden domain eklenip Verify edilir

### 3.3 Cloudflare R2 (kalıcı görsel deposu)

- Bucket: `cinarcik-portal-uploads` (hesap: `0fc67f5590ae3c46017f396d1f46e5be`)
- 10 GB ücretsiz depolama, **egress $0**, 1 M yazma + 10 M okuma/ay
- `server.js` içindeki `finishUploads()` multer dosyalarını S3 API ile
  `uploads/<dosyaadı>` anahtarına yükler; `pubUrl()` bunu **`/uploads/<dosyaadı>`**
  olarak döndürür.
- `GET /uploads/:file` yolu objeyi R2'den imzalı GET ile okuyup döner
  (404 olursa `public/img/uploads`'tan yerel fallback).
- Neden `r2.dev` veya custom domain değil: `r2.dev` bazı ISP'lerce engelleniyor,
  R2 custom domain bağlama ise hesap/dialog kısıtlarıyla sorunlu — kendi
  domain'inden proxy hem erişilebilir hem de hesap derdi yok.
- 87 mevcut görsel R2'ye taşındı; `public/img/uploads` klasörü (git'te) fallback
  olarak duruyor. Ayrıca mojibake/bos-lu dosya adları temizlendi (15 nesne
  yeniden adlandırıldı; `scripts/migrate-r2-names.js`, eski anahtarlar yedek
  olarak silinmedi).
- Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
  (`R2_PUBLIC_URL` artık kullanılmıyor).

## 4. Uygulama Yapısı

| Katman | Teknoloji |
|---|---|
| Web framework | Express 4 |
| Şablon | EJS + `ejs-mate` (layout: `views/partials/layout.ejs`) |
| Veritabanı | SQLite via `sql.js` (WASM), `db/index.js` |
| Oturum | `express-session` (in-memory store) |
| Güvenlik | `helmet`, basic auth, bcrypt, login rate-limit, admin POST Origin kontrolü |
| Dosya yükleme | `multer` → R2 (`/uploads/*`), fallback `public/img/uploads` |
| Stil | Tailwind (`npm run build:css`) |

### 4.1 Dil sistemi
- URL prefix: `/en/haberler`, `/ru/...`, `/ar/...` (TR prefix'siz)
- Middleware `server.js` içinde prefix'i strip eder, `req.lang` atar
- Header'daki bayraklı `<select id="lang-select">` seçimi aynı sayfanın dil
  sürümüne yönlendirir

### 4.2 Admin güvenliği
1. Kullanıcı adı + bcrypt şifre (`users` tablosu)
2. 2FA: 6 haneli kod e-posta ile gönderilir (`ADMIN_2FA_EMAIL`)
3. Kod doğrulanınca session yenilenir (`regenerate`) → `req.session.isAdmin`

> **Not:** `server.js` içinde `adminBasicAuth` (HTTP Basic, `ADMIN_BASIC_*`)
> tanımlı ama hiçbir yere mount edilmediği için **aktif değildir** (ölü kod).
> Asıl koruma session + bcrypt + 2FA katmanlarıdır; `ADMIN_BASIC_USER/PASS`
> env değişkenleri şu an etkisizdir.

## 5. Harici Servisler

| Servis | Amaç | Ücretsiz kota |
|---|---|---|
| **Brevo** (`api.brevo.com`, HTTPS) | 2FA doğrulama kodu maili | 300 mail/gün, süresiz |
| **Google OAuth Console** | Yorum için Gmail ile giriş | sınırsız |
| **Google reCAPTCHA v2** | İletişim formu spam koruması | 50.000 doğrulama/ay |
| **Cloudflare R2** | Kalıcı görsel deposu (`/uploads/*`) | 10 GB, egress $0 |
| Open-Meteo / wttr.in | Ticker hava durumu | açık API'ler |
| Yahoo Finance (query1/query2) | USD, EUR, gram altın, BIST 100 | açık (ana kaynak) |
| er-api.com | Döviz yedek kaynak | açık (fallback) |
| Google News RSS | "Diğer haberler" akışı | açık API |
| **OpenStreetMap** (`openstreetmap.org/export/embed.html`) | Mekân/firma/iletişim harita embed'i (Google keyless embed engellendiği için) | açık, anahtarsız |
| **Nominatim** (`nominatim.openstreetmap.org`) | Harita koordinat çözümleme (adres/plus code → lat/lng) | açık (düşük hacim) |

### 5.1 Neden SMTP değil?
Render, **Free plan'da giden SMTP portlarını (25/465/587) engelliyor**
(26 Eylül 2025'ten beri). Bu yüzden 2FA e-postası SMTP yerine **Brevo HTTP
API** (port 443) ile gönderiliyor. Kod `server.js → sendAdmin2FACode()` içinde:

- `EMAIL_API_KEY` varsa → Brevo (`xkeysib-` prefix) veya SendGrid HTTP API
- yoksa → yerelde SMTP fallback (yalnız geliştirme ortamında çalışır)

### 5.2 Google OAuth redirect URI
```
https://marmaraninincisi.com/auth/google/callback
```
Google Cloud Console'da **kullanılan client** (`...qjsohqmh4a09v9740jqfhr25skak6c5k...`)
için tanımlı olmalı. Uygulama yalnızca `@gmail.com` adreslerine yorum izni verir.

### 5.3 Ticker veri akışı (`GET /api/ticker-data`)

`server.js → fetchTickerData()`: hava + USD + EUR + gram/çeyrek altın + BIST 100.

- **Sıralı çekim** (eski `Promise.all` 4 eşzamanlı istek Yahoo'da 429/403
  tetikliyordu) + her istekte **2 deneme** (700 ms arayla) + tarayıcı `User-Agent`.
- **Yedek kaynaklar**: USD/EUR → `open.er-api.com`, hava → `wttr.in`,
  Yahoo'da `query1` başarısızsa `query2` mirror'u.
- **Gram altın doğru TL hesabı**: GC=F (ons USD) / 31,1035 × USDTRY.
  (Eski hata: USD gelmeyince çarpan 1 kalıyor, gram USD fiyatıyla
  gösteriliyordu — şimdi USD de yedekten gelir.)
- **Eksik alanlar önceki başarılı cache'ten tamamlanır** → ticker `--` göstermez.
- **Cache**: tüm alanlar doluysa 5 dk; eksik varsa 60 sn (hızlı yeniden deneme).
- **Saat**: `updated` alanı `Europe/Istanbul` zaman diliminde üretilir
  (Render UTC çalıştığı için `toLocaleTimeString('tr-TR')` 3 saat geri görünüyordu).

### 5.4 Haritalar (OpenStreetMap)

Mekân, firma ve iletişim sayfalarındaki konum haritaları **OpenStreetMap
embed** ile gösterilir. Eskiden Google Maps keyless `output=embed` kullanılıyordu;
Google bu anahtarsız embed'i engellediği için "www.google.com refused to connect"
hatası alınıyordu (ayrıca mekân `map_link`'leri `maps.app.goo.gl` kısa linkiydi,
ham haliyle iframe'e konunca reddediliyordu).

- `server.js → getMapEmbedUrl(map_link)`: `map_link`'i koordinata çevirip
  `openstreetmap.org/export/embed.html?bbox=...&marker=lat,lng` URL'i üretir.
- **Koordinat çözümleme** (`resolveMapCoords`, in-memory cache'li):
  - URL ise → redirect takibi + `@lat,lng` / `/search/lat,lng` / `!3d..!4d`
    kalıplarından koordinat çıkarımı.
  - Plus code / adres ise → **Nominatim** geocoding.
- Koordinat çözülemezse harita gizlenir (kırık iframe kalmaz).
- İletişim sayfası (`views/contact.ejs`) sabit Çınarcık koordinatlı OSM embed
  kullanır. Harita olan sayfalar: mekân (`place-detail`), firma (`rehber-detail`),
  iletişim (`contact`). Gezilecek yerler sayfası harita yerine yalnızca bağlantı gösterir.

## 6. Bilinen Sınırlamalar ve Riskler

1. **Veri kalıcılığı — çözüldü**
   - DB: **Turso (libSQL)** `db/index.js` üzerinden snapshot senkronu
     (açılışta indirme, yazmalarda debounce ile upload) — bkz. `TURSO_*` env.
   - Dayanıklılık sertleştirmeleri: `flushSync` in-flight sync'i bekler;
     `/admin` POST middleware `res.redirect`'i flush tamamlanmadan göndermez;
     sinyal (SIGINT/SIGTERM/SIGHUP) yakalayıcıları ~8 sn flush verir;
     `mergeRows` bulut/yerel çakışmasında kazananı doğru seçer.
   - Görseller: **Cloudflare R2** (bkz. 3.3).
   - Geriye kalan: Render diski yalnızca yerel fallback; her deploy'ta sıfırlanır,
     anlamlı veri kaybı yoktur.
2. **Instance uykusu**: 15 dakika hareketsizlikte uyur, sonraki istekte ~1 dk uyanır.
3. **Oturum kaybı**: session bellekte; deploy anında tüm oturumlar düşer.
4. **Doğrudan SMTP yok**: yalnız Brevo/HTTP API üzerinden mail gönderilebilir.
5. **Eşzamanlılık**: disk + SQLite nedeniyle tek instance ile çalışmalı
   (autoscale/çoklu instance desteklenmez).
6. **Trafik logları / gizlilik**: `page_views` tablosu **90 gün** sonra otomatik
   temizlenir. IP adresleri kişisel veridir (KVKK); yalnızca korumalı admin
   raporları altında tutulur, kamuya gösterilmez (bkz. §9).

## 7. Ortam Değişkenleri

| Anahtar | Nerede | Açıklama |
|---|---|---|
| `NODE_VERSION`, `NODE_ENV` | render.yaml | Node 20, production |
| `SITE_URL` | render.yaml | `https://marmaraninincisi.com` |
| `GOOGLE_CLIENT_ID` | render.yaml | OAuth client ID |
| `GOOGLE_CALLBACK_URL` | render.yaml | `https://marmaraninincisi.com/auth/google/callback` |
| `GOOGLE_CLIENT_SECRET` | Dashboard (secret) | OAuth client secret |
| `RECAPTCHA_SITE_KEY` | render.yaml | reCAPTCHA site key |
| `RECAPTCHA_SECRET_KEY` | Dashboard (secret) | reCAPTCHA secret |
| `ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS` | render.yaml / secret | Basic auth — **aktif değil** (ölü kod, bkz. §4.2) |
| `ADMIN_PASSWORD` | Dashboard (secret) | İlk admin kullanıcısı şifresi |
| `ADMIN_2FA_EMAIL` | render.yaml | 2FA kodunun gideceği adres |
| `EMAIL_API_KEY` | Dashboard (secret) | Brevo API key (`xkeysib-...`) |
| `EMAIL_FROM` | render.yaml | Gönderici: `cinarcikofficial@gmail.com` |
| `SMTP_*`, `GMAIL_*` | Dashboard | Yalnızca yerel fallback |
| `SESSION_SECRET` | render.yaml (`generateValue`) | Oturum imzası |
| `TURSO_URL` | render.yaml | `libsql://...turso.io` |
| `TURSO_TOKEN` | Dashboard (secret) | Turso auth token |
| `R2_ACCOUNT_ID` | Dashboard (secret) | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | Dashboard (secret) | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | Dashboard (secret) | R2 API token secret |
| `R2_BUCKET` | render.yaml | `cinarcik-portal-uploads` |
| `DB_PATH` | (opsiyonel) | Disk eklendiğinde SQLite yolu |

> `.env` dosyası `.gitignore` içindedir, repo'ya girmez; yerel geliştirme içindir.

## 8. Sık Yapılan İşlemler

- **Deploy**: `git push origin main`
- **Env güncelle**: Render → servis → Environment → Save (otomatik redeploy)
- **Mail testi**: Render → Logs → `[2fa]` satırı
- **EJS şablon kontrolü**: `npm run lint:ejs`
- **Tailwind yeniden derleme**: `npm run build:css`

## 9. Trafik Raporları (Admin)

Ziyaretçi trafiği loglanır ve korumalı bir admin sayfasında gösterilir.

- **Loglama** (`server.js`): `GET` istekleri `res.on('finish')` ile kaydedilir.
  Statik dosyalar `express.static`'te kısa yoldan döner (loglanmaz); `/admin/*`
  trafiği bilinçli olarak hariç tutulur. `trust proxy` sayesinde `req.ip`
  Render proxy'sinin ardından gerçek istemci IP'sini verir.
- **Veri**: `page_views` tablosu (`db/index.js`) — `path`, `method`, `status`,
  `ip`, `user_agent`, `referrer`, `created_at`.
- **Performans**: `logPageView` buffer'lı çalışır (50 satırda veya ~20 sn'de bir
  `saveDb()`); her istekte tam DB yazması önlenir.
- **Saklama**: `sweepPageViews` **90 günde bir** `created_at`'i 90 günden eski
  satırları siler (tombstone patlamasını önlemek için ham `db.run` kullanır).
- **Rapor sayfası**: `GET /admin/raporlar` (`isAuthenticated` korumalı) — özet
  kartları (bugün/7/30 gün/toplam görüntülenme + benzersiz IP), Chart.js ile son
  30 günlük grafik, en çok ziyaret edilen sayfalar ve son ziyaretler tabloları.
  Dashboard'a 📊 "Raporlar" kartı ile erişilir.
