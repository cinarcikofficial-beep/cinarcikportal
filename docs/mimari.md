# Marmara'nın İncisi — Sistem Mimari Dokümanı

Son güncelleme: Ekim 2026

## 1. Genel Bakış

Çınarcık yerel portalı; haber, duyuru, mekân rehberi, gezi noktaları, vapur/saat
bilgisi, hava durumu ve döviz/altın ticker'ı içeren çok dilli (TR/EN/RU/AR)
bir Express uygulaması. Tamamı ücretsiz (free tier) servislerle çalışır.

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

## 4. Uygulama Yapısı

| Katman | Teknoloji |
|---|---|
| Web framework | Express 4 |
| Şablon | EJS + `ejs-mate` (layout: `views/partials/layout.ejs`) |
| Veritabanı | SQLite via `sql.js` (WASM), `db/index.js` |
| Oturum | `express-session` (in-memory store) |
| Güvenlik | `helmet`, basic auth, bcrypt, login rate-limit, admin POST Origin kontrolü |
| Dosya yükleme | `multer` → `public/img/uploads` |
| Stil | Tailwind (`npm run build:css`) |

### 4.1 Dil sistemi
- URL prefix: `/en/haberler`, `/ru/...`, `/ar/...` (TR prefix'siz)
- Middleware `server.js` içinde prefix'i strip eder, `req.lang` atar
- Header'daki bayraklı `<select id="lang-select">` seçimi aynı sayfanın dil
  sürümüne yönlendirir

### 4.2 Admin güvenliği
1. Basic auth (tarayıcı popup) — `ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS`
2. Kullanıcı adı + bcrypt şifre
3. 2FA: 6 haneli kod e-posta ile gönderilir (`ADMIN_2FA_EMAIL`)
4. Kod doğrulanınca session yenilenir (`regenerate`) → `/admin`

## 5. Harici Servisler

| Servis | Amaç | Ücretsiz kota |
|---|---|---|
| **Brevo** (`api.brevo.com`, HTTPS) | 2FA doğrulama kodu maili | 300 mail/gün, süresiz |
| **Google OAuth Console** | Yorum için Gmail ile giriş | sınırsız |
| **Google reCAPTCHA v2** | İletişim formu spam koruması | 50.000 doğrulama/ay |
| Open-Meteo / döviz / RSS | Ticker ve hava durumu | açık API'ler |

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
Google Cloud Console'da **kullanulan client** (`...qjsohqmh4a09v9740jqfhr25skak6c5k...`)
için tanımlı olmalı. Uygulama yalnızca `@gmail.com` adreslerine yorum izni verir.

## 6. Bilinen Sınırlamalar ve Riskler

1. **Veri kalıcılığı yok (Free plan disk desteklemez)**
   - `db/cinarcik.db` ve `public/img/uploads` her deploy/restart'ta sıfırlanır.
   - Geçici çözüm: admin içerik girişi sonrası `db/cinarcik.db` commit'lenmeli.
   - Kalıcı çözüm: Render **Starter ($7/ay)** + persistent disk (`DB_PATH=/data/...`).
2. **Instance uykusu**: 15 dakika hareketsizlikte uyur, sonraki istekte ~1 dk uyanır.
3. **Oturum kaybı**: session bellekte; deploy anında tüm oturumlar düşer.
4. **Doğrudan SMTP yok**: yalnız Brevo/HTTP API üzerinden mail gönderilebilir.
5. **Eşzamanlılık**: disk + SQLite nedeniyle tek instance ile çalışmalı
   (autoscale/çoklu instance desteklenmez).

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
| `ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS` | render.yaml / secret | Basic auth |
| `ADMIN_PASSWORD` | Dashboard (secret) | İlk admin kullanıcısı şifresi |
| `ADMIN_2FA_EMAIL` | render.yaml | 2FA kodunun gideceği adres |
| `EMAIL_API_KEY` | Dashboard (secret) | Brevo API key (`xkeysib-...`) |
| `EMAIL_FROM` | render.yaml | Gönderici: `cinarcikofficial@gmail.com` |
| `SMTP_*`, `GMAIL_*` | Dashboard | Yalnızca yerel fallback |
| `SESSION_SECRET` | render.yaml (`generateValue`) | Oturum imzası |
| `DB_PATH` | (opsiyonel) | Disk eklendiğinde SQLite yolu |

> `.env` dosyası `.gitignore` içindedir, repo'ya girmez; yerel geliştirme içindir.

## 8. Sık Yapılan İşlemler

- **Deploy**: `git push origin main`
- **Env güncelle**: Render → servis → Environment → Save (otomatik redeploy)
- **Mail testi**: Render → Logs → `[2fa]` satırı
- **EJS şablon kontrolü**: `npm run lint:ejs`
- **Tailwind yeniden derleme**: `npm run build:css`
