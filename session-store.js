// express-session icin dosya tabanli store: restart/deploy'ta oturumlar
// bellekte kaybolmasin (admin 2FA + Google giris oturumlari).
// Tek instance (Passenger) ile calisir; yazma 15 sn'de bir debounce edilir.
// DIKKAT: express-session'in base Store sinifindan TUREMELI — yoksa
// createSession/regenerate eksik kalir (OTP ekraninda 500).
const fs = require('fs');
const path = require('path');
const { Store } = require('express-session');

const FLUSH_MS = 15000;

class FileSessionStore extends Store {
  constructor(opts) {
    super();
    opts = opts || {};
    this.dir = opts.dir || path.join(__dirname, 'data');
    this.file = path.join(this.dir, 'sessions.json');
    this.sessions = new Map();
    this.dirty = false;
    this.writeFailed = false;
    this._load();
    this._timer = setInterval(() => this._flush(), FLUSH_MS);
    if (this._timer.unref) this._timer.unref();
    process.on('exit', () => this._flushSync());
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const obj = JSON.parse(raw);
      const now = Date.now();
      for (const k of Object.keys(obj)) {
        const sess = obj[k];
        const exp = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : 0;
        if (exp && exp < now) continue; // suresi dolmus oturumu yukleme
        this.sessions.set(k, sess);
      }
    } catch (e) { /* ilk acilis / bozuk dosya: bos basla */ }
  }

  _persist() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      const obj = {};
      for (const [k, v] of this.sessions) obj[k] = v;
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, this.file); // atomik yazma
      if (this.writeFailed) { this.writeFailed = false; console.log('[session] dosya yazma yeniden calisiyor'); }
    } catch (e) {
      if (!this.writeFailed) { this.writeFailed = true; console.warn('[session] dosyaya yazilamadi:', e.message); }
    }
  }

  _flushSync() {
    try { this._flush(); } catch (e) { /* exit aninda yok say */ }
  }

  _flush() { this._persist(); }

  get(sid, cb) {
    const sess = this.sessions.get(sid);
    if (!sess) return cb(null, null);
    const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : 0;
    if (exp && exp < Date.now()) {
      this.sessions.delete(sid);
      this.dirty = true;
      return cb(null, null);
    }
    cb(null, sess);
  }

  set(sid, sess, cb) {
    this.sessions.set(sid, sess);
    this.dirty = true;
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    this.sessions.delete(sid);
    this.dirty = true;
    if (cb) cb(null);
  }

  touch(sid, sess, cb) {
    this.sessions.set(sid, sess);
    this.dirty = true;
    if (cb) cb(null);
  }
}

module.exports = FileSessionStore;
