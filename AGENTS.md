# Çınarcık Portal — Çalışma Notları

## Genel
- Stack: Express + EJS (server-side render), sql.js + Turso sync, Tailwind CDN.
- Canlı: https://marmaraninincisi.com (Render free plan)
- Git remote: https://github.com/cinarcikofficial-beep/cinarcikportal.git (branch: main)
- İletişim dili: Türkçe. commit/push sadece kullanıcı açıkça isteyince; commit mesajları İngilizce/ASCII olabilir.

## Kritik konvansiyonlar
- Her EJS/JS değişikliği sonrası: `npm run lint:ejs` (FAIL olmamalı).
- `db/cinarcik.db` repo'da version'lanıyor; şema migration'ları `db/index.js`'te `PRAGMA table_info` + `ALTER TABLE` ile.
- `initDb()` async — scriptlerde `await initDb()` gerekir.
- Mail altyapısı: `sendPortalMail()` (server.js) — önce Brevo/SendGrid HTTP API (`EMAIL_API_KEY`), fallback Gmail SMTP (`SMTP_USER`/`SMTP_PASS`), yoksa konsol.
- Admin girişi OTP'li ayrı session (`isAdmin`); Google girişi yorum/ilan için (`isGoogleAuth`/`googleUser`), sadece @gmail.com.
- Public listeleme sorgularında `status='active'` filtresi şart (news, places, announcements).

## Tamamlananlar
- Firma rehberi: kartlar contain-logo, ad + bold sektör; `/rehber/:slug` detay sayfası; `map_embed` alanı (admin form + DB) ile Google harita; yol tarifi kaldırıldı.
- Kullanıcı ilan/duyuru akışı: `/ilan-ver` (Google girişli form) → `status='pending'` → admin panelde Onayla/Reddet (`/admin/duyuru-onay|reddet/:id`). Bekleyenler public'te görünmüyor. 4 dil etiketleri eklendi.
- İletişim formu: `POST /iletisim` artık `ADMIN_2FA_EMAIL`'e fire-and-forget bildirim maili atıyor (reply-to = ziyaretçi).

## Aktif iş / sonraki adımlar (iletişim@marmaraninincisi.com)
Durum: NS'ler Cloudflare'de. `iletisim@`'a gelen mail Gmail'e (cinarcikofficial@gmail.com) yönlü (Cloudflare Email Routing hazır).
Kullanıcı `iletisim@`'dan gönderebilsin diye:
1. **[BEKLIYOR]** Brevo → Senders & IP → Sender Domains → `marmaraninincisi.com` → CNAME/TXT kayıtları Cloudflare DNS'e (CNAME'ler DNS only) → Verify → Senders → iletisim@ ekle → Gmail'e gelen doğrulama linki.
2. **[BEKLIYOR]** Brevo → SMTP & API → SMTP Key üret.
3. **[BEKLIYOR]** Gmail → Settings → Accounts and Import → Send mail as → `iletisim@` + `smtp-relay.brevo.com:587` + Brevo hesabı e-postası + SMTP key.
4. **[BEKLIYOR]** Render env: `EMAIL_API_KEY` (Brevo API key, yoksa) + `EMAIL_FROM=iletisim@marmaraninincisi.com` → redeploy.

## Diğer notlar
- `/admin` POST'larında CSRF Origin kontrolü var; admin yazma sonrası Turso `flushSync`.
- Render free plan SMTP portlarını engelliyor → HTTP API öncelikli.
