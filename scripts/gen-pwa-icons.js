// PWA ikonlarını public/img/logo-circle.png'den üretir: node scripts/gen-pwa-icons.js
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const src = path.join(__dirname, '..', 'public', 'img', 'logo-circle.png');
const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const BG = { r: 9, g: 9, b: 11, alpha: 1 }; // zinc-950

(async () => {
  for (const size of [192, 512]) {
    // "any": şeffaf arka plan, logo tam boy
    await sharp(src).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toFile(path.join(outDir, `icon-${size}.png`));
    // "maskable": koyu zemin + %80 güvenli alan
    const inner = Math.round(size * 0.8);
    const logo = await sharp(src).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
      .composite([{ input: logo, gravity: 'center' }]).png().toFile(path.join(outDir, `maskable-${size}.png`));
  }
  // iOS: şeffaflık desteklemez → koyu zemin
  const logo180 = await sharp(src).resize(160, 160, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({ create: { width: 180, height: 180, channels: 4, background: BG } })
    .composite([{ input: logo180, gravity: 'center' }]).png().toFile(path.join(outDir, 'apple-touch-icon.png'));
  console.log('PWA ikonları üretildi:', fs.readdirSync(outDir).join(', '));
})();

