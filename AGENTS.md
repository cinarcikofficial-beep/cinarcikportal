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
1. **[YAPILDI — push bekliyor]** `render.yaml`: `EMAIL_API_KEY` value olarak girildi (repo `.env`'deki Brevo key — `.env` zaten track'li) + `EMAIL_FROM` düzeltildi → `iletisim@marmaraninincisi.com` (önceki değer `cinarcikofficial@gmail.com`'du, blueprint sync bunu ezerdi).
2. **[TEST]** Push + redeploy sonrası siteden iletişim formu testi → bildirim maili + gönderen iletisim@ kontrolü. Gönderen spam'e düşüyorsa Brevo'da DNS kayıtları Verified mı bakılacak.

## Aktif iş 2 — Haber + duyuru görüntülenme sıfırlama (TAMAM, push/canlı test bekliyor)
Kullanıcı isteği: (a) her habere ayrı sıfırlama butonu + toplu buton "yapmıyordu"; (b) duyuru/ilan tablosuna da görüntülenme sayacı + admin'de gösterim + sıfırlama.
**Kök neden:** `db/index.js` `VOLATILE_COLS` birleşimi `views_count` için iki taraftan **max** alıyordu → sıfırlama yerelde yapılsa bile Turso'daki/repo db dosyasındaki eski yüksek değer sonraki sync/restart'ta geri geliyordu (toplu buton anlık çalışıyor gibi görünüyordu).
**Yapılan fix:**
- `news.views_reset_at` kolonu (migration + CREATE TABLE). Sıfırlama rotaları `views_count=0, views_reset_at=datetime('now')` yazıyor.
- Merge: `views_reset_at` epoch'u daha yeni taraftan sayaç alınır; aynı epokta max kuralı korunur (`RESET_EPOCH_COLS`, `VOLATILE_RESET_COL` — dikkat: rcol adı `_reset_at` ekiyle türetilmiyor, `views_count` → `views_reset_at`).
- `ensureSyncSchema`: `_sync_au` trigger'ı DROP+CREATE (eski sütun listesi IF NOT EXISTS ile kalmasın).
- Rotalar: bulk `POST /admin/haberler/goruntulenme-sifirla` güncellendi; yeni satır bazlı `POST /admin/haberler/:id/goruntulenme-sifirla` (Referer korumalı redirect).
- Butonlar: dashboard views hücresine 🔄 + news-list'e "👁 Görüntelenme" sütunu eklendi (boş satır colspan'leri 7 yapıldı).
- **Duyuru/ilan:** `announcements` + `views_count`/`views_reset_at` (migration + CREATE). `/duyuru/:id` detayda `views_count+1`. Dashboard Duyuru sekmesi: 👁 sütunu + satır 🔄 + header'da toplu buton (`POST /admin/duyurular/goruntulenme-sifirla` → redirect `/admin?tab=announcements`; satır bazlı `/admin/duyurular/:id/...` Referer korumalı). `VOLATILE_COLS`/`VOLATILE_RESET_COL` announcements'a eklendi. NOT: announcements tablosunda `updated_at` kolonu YOK — reset SQL'inde kullanma (trigger `views_reset_at` sayesinde `sync_updated_at`'i tazeliyor).
- 8 senaryolu merge smoke testi geçti (news N1-N3 + announcements A1-A4, aynı kök neden senaryoları dahil).
**Kalan:** Render redeploy + canlıda test. NOT: Turso ile senkron çalışan **eski koddaki** her instance (ör. lokal çalışan eski server) sıfırlamayı diriltmeye devam eder — lokal sunucu da yeni kodla restart edilmeli.

## Diğer notlar
- `/admin` POST'larında CSRF Origin kontrolü var; admin yazma sonrası Turso `flushSync`.
- Render free plan SMTP portlarını engelliyor → HTTP API öncelikli.
