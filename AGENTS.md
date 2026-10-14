# Çınarcık Portal — Çalışma Notları

## Genel
- Stack: Express + EJS (server-side render), sql.js + Turso sync, Tailwind CDN (JIT — arbitrary value'lar (`h-48`, `min-h-[3.5rem]`) çalışıyor).
- Canlı: https://marmaraninincisi.com (Render free plan; push → otomatik redeploy)
- Git remote: https://github.com/cinarcikofficial-beep/cinarcikportal.git (branch: main)
- İletişim dili: Türkçe. commit/push sadece kullanıcı açıkça isteyince; commit mesajları ASCII.
- Görsel deposu: Cloudflare R2 aktif (`uploads/` key'leri; local mirror yükleme sonrası silinir). DB'de URL'ler hep göreli: `/uploads/x` (R2) veya `/img/uploads/x` (lokal fallback).

## Kritik konvansiyonlar
- Her EJS/JS değişikliği sonrası: `npm run lint:ejs` + `node --check server.js` (FAIL olmamalı).
- `db/cinarcik.db` repo'da version'lanıyor; şema migration'ları `db/index.js`'te `PRAGMA table_info` + `ALTER TABLE` ile.
- `initDb()` async — scriptlerde `await initDb()` gerekir.
- Mail altyapısı: `sendPortalMail()` (server.js) — önce Brevo HTTP API (`EMAIL_API_KEY`), fallback Gmail SMTP, yoksa konsol. Admin bildirimleri `ADMIN_2FA_EMAIL`'e, reply-to = ziyaretçi.
- Admin girişi OTP'li ayrı session (`isAdmin`); Google girişi yorum/ilan için (`isGoogleAuth`), sadece @gmail.com. Admin yazma sonrası Turso `flushSync`; `/admin` POST'larında CSRF Origin kontrolü.
- Public listeleme sorgularında `status='active'` filtresi şart (news, places, announcements).
- Sıfırlama/redirect rotalarında Referer koruması: `new URL(req.get('Referer'))` host eşleşmese fallback'e dön.
- `sightseeing`/`announcements` tablolarında `updated_at` YOK — SQL'lerinde kullanma.

## Tamamlananlar (özet — detay git log'da)
- **Google entegrasyonu + SEO (14 Eki):** Search Console doğrulama etiketi + GA4 (`G-HPNR24RP48`) gtag `layout.ejs` `<head>`'inde (b0c4125); Helmet CSP zaten kapalı. SEO düzeltmeleri (594d9b8): `res.locals.robotsMeta` → `/admin` ve 404/500 `noindex, nofollow`, sitemap'e `/ilan-ver` + duyuru detayları (`announcements`'ta `updated_at` YOK → `created_at`), duyuru detayına `metaDescription`/`ogImage`/`Article|Event` JSON-LD, firma detayına `metaDescription`/`ogImage`/`LocalBusiness` JSON-LD; fazla 2 `</head>` temizlendi. `stripHtml()` (server.js) meta özetleri için.
- **Orphan görsel süpürmesi (14 Eki):** DB referansları (lokal + Turso birleşimi, 49 adet) baz alınarak lokalde 47 + R2'de 55 dosya (21.3 MB) silindi; 0 başarısız, 0 kırık referans (404 yok). Yordam: `refs-union.json` üret → `basename` farkı ile sil → kalan her referans lokalde VEYA R2'de var mı doğrula. Dün silinen 3 haberin (id 1,2,3) görselleri de bunlar arasındaydı. Not: R2'de mojibake isimli çiftler vardı (`Ekran gÃ¶rÃ¼ntÃ¼sÃ¼...`), referanslı ASCII çiftleri korundu.
- **Dün (13 Eki) eklenenler (AGENTS.md'ye geç yazıldı):** mekan görüntülenme sayacı (admin sutun + sifirlama, detayda gosterim) f042e13; admin listelere sirala (tasi) butonlari + en cok okunanlar goruntulenmeye gore dfa0ffb; altbilgi yeniden tasarim (baglanti grid, emerald basliklar, ayri telif bandi) d4eac9e; en cok okunanlar manset dahil tum aktif haberlerden 844059a; Haberler sag kolona "Yazar Adayi" blogu (iletisime yonlendirir) 45839f3 + siluet guncelleme b4d5dfa.
- **Görüntülenme sayaçları (haber/duyuru/firma/gezilecek yer):** `views_count` + `views_reset_at` epoch'lu merge (`VOLATILE_COLS`/`RESET_EPOCH_COLS`/`VOLATILE_RESET_COL`); kök neden: MAX birleşimi sıfırlamayı diriltiyordu. Admin'de 👁 sütun + satır/toplu 🔄 (`/admin/<plural>[/ :id]/goruntulenme-sifirla`). Public detaylarda 👁 gösterim. 4 tablo × 4 senaryo merge testi geçti. **Canlıda doğrulandı (sayaçlar çalışıyor).**
- **Duyuru sayfası UI:** görseller sabit `h-64`; kartlar `items-stretch` + başlık `line-clamp-2 min-h-[3.5rem]` ile eşit hizalı; alttaki tekrar subtitle kaldırıldı; İlan Ver butonu eski sade haline döndü + `ilan-flash` (1sn glow). (b6139ec, e60839d)
- **Ticker hava durumu:** emerald gradient pill + `weatherShine` süpürme + `weatherBob` ikon nabzı (`style.css` `.ticker-weather`). (1c746d9)
- **Hero slider CTA akışı:** her slaytta `data-cta` JSON → `hero-ctas` JS ile yeniden basılıyor (Haberler + sırayla Sefer/Nöbetçi Eczane/Mekanlar/Gezilecek Yerler/Firma Rehberi). (b24a61a)
- **İlan Ver akışı:** kategori `ilan|duyuru|etkinlik` (4 dil + amber `tag-etkinlik` rozeti light/dark + admin formu); formda iletişim ile aynı session captcha'sı (`issueCaptcha`/`captchaOk`); başarılı gönderimde admin'e `sendPortalMail` (logTag `ilan-ver`); formdaki "onaydan sonra yayınlanır" uyarısı kaldırıldı (bilgi success mesajında). (fc1a58f + 1 commit daha)
- **Medya temizliği:** `deleteUploadedMedia()` + `galleryJsonUrls()` (server.js, `pubUrl` yanı) — sadece `/uploads/*` ve `/img/uploads/*`; local unlink + R2 DELETE (fire-and-forget). 6 silme rotasına bağlı: haber-sil (main+gallery), duyuru-sil & reddet (image), mekan-sil (main+gallery), firma-sil (logo_url), gezilecek-yer-sil (image+gallery) + `/admin/gallery-delete` R2 fix. Dış URL'lere dokunmaz. Not: geçmiş orphan dosyalar temizlenmedi. (b2054b0)
- **UI dokunuşları:** `/haberler` grid görselleri `h-48 object-cover` (eşit); mekanlar `.btn-inspect` dolu emerald gradient + glow + hover lift. (d03ddcd, 25a1384)
- Firma rehberi detay/map_embed, iletişim formu bildirimi, kullanıcı ilan akışı — önceki oturumlar.

## Açık kalanlar / test bekleyen
1. **Google hesap tarafı (kullanıcı):** Search Console → Settings → Ownership verification → **Verify** (etiketi canlıda, b0c4125+); GA4 `G-HPNR24RP48` → Gerçek Zamanlı kontrol; Search Console → Sitemaps → `sitemap.xml` gönder.
2. **Canlı doğrulama:** görüntülenme sayaçları ✅; R2 silme ✅ (14 Eki süpürmede 55/55); ilan-ver captcha/etkinlik/mail, UI (duyuru eşit kart + flash buton, ticker pill, hero CTA akışı, haberler grid, mekanlar İncele, Yazar Adayı bloğu, altbilgi). CSS cache → hard refresh.
3. **Gmail alias (Aktif iş 1):** render.yaml `EMAIL_FROM` + `EMAIL_API_KEY` push edildi; iletişim formu testi + gönderen spam'e düşerse Brevo DNS Verified kontrolü.
4. ~~Opsiyonel: R2 orphan süpürme~~ ✅ 14 Eki'de elle yapıldı (script commit edilmedi, gerekirse yeniden yazılır); `content_translations` hash-cache süpürmesi hâlâ opsiyonel.
5. Render free plan SMTP portları engelli → HTTP API öncelikli. Lokal eski kodlu instance Turso'ya eski veri basabilir — lokal sunucu yeni koddan restart edilmeli.
6. **Bilinen SEO eksikleri (düşük öncelik):** mekan/gezilecek yer detayları id tabanlı (`places.slug` üretiliyor ama route kullanmıyor); duyuru detayları id tabanlı (`announcements`'ta slug yok); schema kodları hem route içinde hem view'da çift kopya (senkron riski); statik sayfaların `lastmod`'u her gün yenileniyor; `og:locale` `en_EN` (geçersiz, `en_US` olmalı).
