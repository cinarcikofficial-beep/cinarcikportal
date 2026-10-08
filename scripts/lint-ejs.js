const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
let failed = 0;
function walk(d) {
  fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ejs')) {
      try { ejs.compile(fs.readFileSync(p, 'utf8')); console.log('OK ', p); }
      catch (err) { failed++; console.log('ERR', p, '-', err.message.split('\n')[0]); }
    }
  });
}
walk(path.join(__dirname, '..', 'views'));
process.exit(failed ? 1 : 0);
