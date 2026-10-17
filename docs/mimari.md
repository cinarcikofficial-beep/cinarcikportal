# Marmara'nın İncisi — Sistem Mimari Dokümanı

Son güncelleme: Ekim 2026

## 1. Genel Bakış

Çınarcık yerel portalı; haber, duyuru (liste + içerik sayfası), mekân rehberi,
gezi noktaları, firma rehberi, vapur/saat bilgisi, hava durumu ve döviz/altın
ticker'ı içeren çok dilli (TR/EN/RU/AR) bir Express uygulaması. Ayrıca
OpenStreetMap tabanlı haritalar ve admin tarafında trafik raporları
   ziyaretçi IP) bulunur. Tamamı ücretsiz/ucuz (free tier + $20/yıl hosting)
   servislerle çalışır.

```
Ziyaretçi
   │  HTTPS
   ▼
Cloudflare (DNS + proxy + edge cache: /uploads/*, /css/*)
   │  HTTP → origin (SSL mode: Full)
   ▼
Spaceship Shared Hosting — Essential (cPanel + Passenger, Node 20, Express + EJS)
   ├── Sunucu: server59.shared.spaceship.host (IP 66.29.148.182)
   ├── App root: /home/svclrphtsu/marmaraninincisi.com
   ├── SQLite dosyası: db/cinarcik.db   (yerel fallback, asıl veri Turso)
   ├── Yüklenen görseller: R2'ye gider (local mirror silinir)
   └── Harici API'ler: Brevo (2FA mail), Google OAuth, reCAPTCHA
```

> **Taşınma (16 Eki 2026):** Render free bandwidth kotası dolduğu için servis
> askıya alınmıştı (ay sonuna kadar 503) → Spaceship Essential'a manuel zip
> deploy ile geçildi. Render artık kullanılmıyor; `render.yaml` ve
> `keep-awake` workflow'u 16 Eki akşamı temizlendi (Render hesabı silinecek).
> Detay: `AGENTS.md` "16 Eki (taşınma)".

## 2. Kod Deposu ve Deploy

| Öğe | Değer |
|---|---|
| Repo | `github.com/cinarcikofficial-beep/cinarcikportal` |
| Branch | `main` |
| Deploy | **Manuel**: `scripts/deploy-spaceship.ps1` → zip → cPanel Upload + Extract → (gerekirse) NPM Install → Restart |
| Build | `npm install` (cPanel Node.js panelinde "Run NPM Install") |
| Start | `node server.js` (Passenger, cPanel Node.js App paneli) |
| App root | `/home/svclrphtsu/marmaraninincisi.com` |
| Health check | `GET /` |

Env değişkenleri tek yerden yönetilir:

- **`.env`** (app root'ta; dotenv ile yüklenir; repo'ya girmez)
- cPanel → Setup Node.js App → environment variables (opsiyonel alternatif;
  `.env` varken gerekmedi)

## 3. Altyapı

### 3.1 Spaceship Shared Hosting (Essential plan)

- Panel: Spaceship Hosting Manager → **cPanel** (full erişim + token'lı erişim)
- Sunucu: `server59.shared.spaceship.host`, shared IP **`66.29.148.182`** (US)
- Runtime: cPanel **Setup Node.js App** (CloudLinux + Passenger), **Node 20**,
  mode: production, startup file: `server.js`
- Depolama/ bandwidth: 20 GB SSD, **unmetered bandwidth** (Render kota sorununun
  yapısal çözümü)
- Sertifika: cPanel **AutoSSL** (Sectigo DV) — `marmaraninincisi.com`
- Trial: 30 gün $0 → **15 Kasım 2026'da $19.88/yıl** yenileme (Auto-renew Açık;
  iptal edilecekse 14 Kasım'dan önce karar ver)
- Eski: Render Free (`cinarcikportal.onrender.com`) — 16 Eki'de taşındı,
  kullanılmıyor.

### 3.2 Cloudflare (DNS + proxy + cache)

Alan adı: `marmaraninincisi.com` (dikkat: ortada `ni` var)

| Kayıt | Tip | Hedef | Not |
|---|---|---|---|
| `@` | A | `66.29.148.182` | Spaceship, **Proxied (turuncu)** |
| `www` | CNAME | `marmaraninincisi.com` | Proxied (turuncu) |

- SSL/TLS encryption mode: **Full** (strict değil — origin sertifikası AutoSSL'den)
- Mail kayıtları (Brevo DKIM/SPF, Cloudflare Email Routing MX) **DNS only** kalmalı
- **NEEDS DNS SETUP** rozeti (Spaceship): A kaydı doğru IP + DNS-only iken
  "Verify DNS changes" ile geçiyor, sonra proxy geri açılabilir.
- Cache: `/uploads/*` (immutable, 1 yıl) + `/css/*` edge'te — MISS→HIT doğrulandı;
  HTML dinamik (DYNAMIC) kalıyor.
- Eski Render kayıtları (`216.24.57.16/18`, `cinarcikportal.onrender.com`)
  silindi.
- **Güvenlik (16 Eki):** cPanel Passenger **docroot = app root** olduğu için
  `server.js`/`db/index.js`/`package.json`/`db/cinarcik.db` (canlı DB kopyası)
  ham web'den servis ediliyordu (`.env` 403 korumalı, `server.js` CF'te
  cache'li). Kalıcı çözüm: cPanel Node.js App → docroot `public`. Repo'daki
  `.htaccess` (RedirectMatch ile kod/db yolları 404) yedek katman — yeni zip
  Extract edilince devreye girer. Doğrulama: `/server.js`, `/db/cinarcik.db` →
  404; `/`, `/img/uploads/*`, `/images/*` → 200 kalmalı. Yedek katman olarak
  Cloudflare WAF custom rule (path block) kurulabilir.

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
Eskiden Render, Free plan'da giden SMTP portlarını (25/465/587) engelliyordu;
bu yüzden 2FA e-postası SMTP yerine **Brevo HTTP API** (port 443) ile
gönderiliyordu. Taşınmadan sonra SMTP teknik olarak mümkün olsa da kod
**HTTP API öncelikli** olduğu için olduğu gibi bırakıldı (daha güvenilir +
Render'a bağımlılık yok). Öncelik sırası `server.js → sendPortalMail()`:

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
   (sunucu UTC çalıştığı için `toLocaleTimeString('tr-TR')` 3 saat geri görünüyordu).

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
   - Yerel disk artık kalıcı (shared hosting); yine de asıl veri kaynağı
     Turso'dur, lokal dosya sadece fallback'tir.
2. **Process yaşam döngüsü**: Passenger uygulamayı belirli aralıklarla yeniden
   başlatabilir (deploy/restart'ta session'lar düşer). Uptime kontrolü
   **UptimeRobot**'da (5 dk HTTP monitor + mail alert); `keep-awake`
   workflow'u taşınma sonrası kaldırıldı (hosting artık always-on).
3. **Oturum kaybı**: session bellekte; restart/deploy anında tüm oturumlar düşer.
4. **Doğrudan SMTP yok**: yalnız Brevo/HTTP API üzerinden mail gönderilebilir.
5. **Eşzamanlılık**: disk + SQLite nedeniyle tek instance ile çalışmalı
   (autoscale/çoklu instance desteklenmez).
6. **Trafik logları / gizlilik**: `page_views` tablosu **90 gün** sonra otomatik
   temizlenir. IP adresleri kişisel veridir (KVKK); yalnızca korumalı admin
   raporları altında tutulur, kamuya gösterilmez (bkz. §9).

## 7. Ortam Değişkenleri

Tümü **`.env`** dosyasında (app root'ta; `.gitignore`'da; repo'ya girmez).
Eski Render blueprint'i (`render.yaml`) 16 Eki'de repo'dan silindi.

| Anahtar | Nerede | Açıklama |
|---|---|---|
| `NODE_ENV` | cPanel Node.js App (mode: production) | Üretim modu |
| `PORT` | cPanel Passenger belirler | `.env`'deki 3000 yerel içindir |
| `SITE_URL` | `.env` | `https://marmaraninincisi.com` |
| `GOOGLE_CLIENT_ID` | `.env` | OAuth client ID |
| `GOOGLE_CALLBACK_URL` | `.env` | `https://marmaraninincisi.com/auth/google/callback` |
| `GOOGLE_CLIENT_SECRET` | `.env` | OAuth client secret |
| `RECAPTCHA_SITE_KEY` | `.env` | reCAPTCHA site key |
| `RECAPTCHA_SECRET_KEY` | `.env` | reCAPTCHA secret |
| `ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS` | `.env` | Basic auth — **aktif değil** (ölü kod, bkz. §4.2) |
| `ADMIN_PASSWORD` | `.env` | İlk admin kullanıcısı şifresi |
| `ADMIN_2FA_EMAIL` | `.env` | 2FA kodunun gideceği adres |
| `EMAIL_API_KEY` | `.env` | Brevo API key (`xkeysib-...`) |
| `EMAIL_FROM` | `.env` | Gönderici: `iletisim@marmaraninincisi.com` |
| `SMTP_*`, `GMAIL_*` | `.env` | Yalnızca yerel fallback |
| `SESSION_SECRET` | `.env` | Oturum imzası |
| `TURSO_URL` | `.env` | `libsql://...turso.io` |
| `TURSO_TOKEN` | `.env` | Turso auth token |
| `R2_ACCOUNT_ID` | `.env` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | `.env` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | `.env` | R2 API token secret |
| `R2_BUCKET` | `.env` | `cinarcik-portal-uploads` |
| `R2_PUBLIC_URL` | `.env` | `https://pub-....r2.dev` (artık kullanılmıyor, bkz. §3.3) |

> `.env` dosyası `.gitignore` içindedir, repo'ya girmez; yerel geliştirme içindir.

## 8. Sık Yapılan İşlemler

- **Deploy** (manuel, 16 Eki'den beri):
  1. `powershell -File scripts/deploy-spaceship.ps1` → `%TEMP%\opencode\cinarcik-deploy.zip` üretir
  2. cPanel **File Manager** → `/home/svclrphtsu/marmaraninincisi.com` → Upload + Extract
  3. `package.json` değiştiyse → Node.js App paneli → **Run NPM Install**
  4. Node.js App paneli → **Restart**
  5. `https://marmaraninincisi.com` + 1-2 sayfa smoke test
- **Env güncelle**: app root'taki `.env`'i File Manager ile düzenle → Restart
- **Log / hata**: cPanel Node.js App panelinde "Logs" (error log)
- **Mail testi**: admin 2FA dene, `[2fa]` logu panelde
- **EJS şablon kontrolü**: `npm run lint:ejs`
- **Tailwind yeniden derleme**: `npm run build:css` (değiştiyse zip'e girer)

## 9. Trafik Raporları (Admin)

Ziyaretçi trafiği loglanır ve korumalı bir admin sayfasında gösterilir.

- **Loglama** (`server.js`): `GET` istekleri `res.on('finish')` ile kaydedilir.
  Statik dosyalar `express.static`'te kısa yoldan döner (loglanmaz); `/admin/*`
  trafiği bilinçli olarak hariç tutulur. `trust proxy` sayesinde `req.ip`
  Cloudflare proxy'sinin ardından gerçek istemci IP'sini verir.
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
