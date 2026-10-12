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

## Aktif iş 1 — Gmail alias (iletişim@marmaraninincisi.com'dan gönderim)
Durum: NS'ler Cloudflare'de. `iletisim@`'a gelen mail Gmail'e (cinarcikofficial@gmail.com) yönlü (Cloudflare Email Routing hazır).
SMTP key üretildi (Login: `bd6830001@smtp-brevo.com`, key kullanıcıda/paylaşıldı). Sender `Admin <iletisim@...>` eklenmiş.
Kullanıcı "Authorized IPs → SMTP keys"i Deactivate etti (IP kısıtı kapalı) ve Gmail → Accounts and Import → Send mail as'e eklediğini söyledi.
From alanından gönderme talimatı verildi (Compose → From → iletisim@).
Kalan:
1. **[BEKLIYOR]** Render env: `EMAIL_API_KEY` (Brevo → API keys & MCP) + `EMAIL_FROM=iletisim@marmaraninincisi.com` → redeploy.
2. **[TEST]** Siteden iletişim formu testi → bildirim maili + gönderen iletisim@ kontrolü. Gönderen spam'e düşüyorsa Brevo'da DNS kayıtları Verified mı bakılacak.

## Aktif iş 2 — Haber görüntülenme sıfırlama (YARIM)
Kullanıcı isteği: **her habere ayrı sıfırlama butonu** (her satırda) + mevcut toplu buton çalışmıyor.
İnceleme sonucu:
- Toplu rota var: `POST /admin/haberler/goruntulenme-sifirla` (server.js:980) → `UPDATE news SET views_count = 0` + flush middleware var; kodda bariz hata yok. Neden "yapmıyor" araştırılmadı (olasılıklar: Turso senkronü geri yazıyor, confirm iptal, Render eski kod — Render redeploy edildi mi?).
- Butonlar: `views/admin/news-list.ejs:18` (toplu, views sütunu YOK başlıkta toplam var) ve `views/admin/dashboard.ejs:209` (toplu, satırda views_count sütunu var :285 ama satır bazlı buton yok).
- news-list satır butonları: :82-87 (düzenle/önizle/toggle/sil).
Sonraki adımlar: (1) her iki tabloya satır bazlı `POST /admin/haberler/:id/goruntulenme-sifirla` butonu + rota; (2) toplu butonun gerçekten çalışmadığını canlıda doğrula (kullanıcıya sor).

## Diğer notlar
- `/admin` POST'larında CSRF Origin kontrolü var; admin yazma sonrası Turso `flushSync`.
- Render free plan SMTP portlarını engelliyor → HTTP API öncelikli.
