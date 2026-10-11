import fs from 'fs';
const P = (f) => fs.readFileSync('src/' + f, 'utf8');
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const version = process.env.VERSION || ('2.0.' + Date.now().toString(36));
let out = P('backend.js');
const shared = P('shared.js');
const rep = {
  '__SHARED__': () => shared,
  '__SHARED_STR__': () => '`' + esc(shared) + '`',
  '__HTML__': () => esc(P('index.html')),
  '__CSS__': () => esc(P('app.css')),
  '__APPJS__': () => esc(fs.readdirSync('src').filter(f=>/^app-\d.*\.js$/.test(f)).sort().map(f=>P(f)).join('\n')),
  '__SW__': () => esc(P('sw.js')),
  '__DOCS__': () => esc(P('docs.html')),
};
for (const k of Object.keys(rep)) out = out.split(k).join('\u0000' + k + '\u0000');
for (const k of Object.keys(rep)) out = out.split('\u0000' + k + '\u0000').join(rep[k]());
out = out.split('__VERSION__').join(version);
fs.writeFileSync('worker.js', out);
console.log('worker.js', out.length, 'bytes, version', version);
