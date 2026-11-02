import esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
const js = (await esbuild.build({ entryPoints: [here + 'editor.ts'], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false })).outputFiles[0].text;
const html = readFileSync(here + 'index.html', 'utf8')
 .replace('/*CSS*/', () => readFileSync(here + 'live.css', 'utf8') + readFileSync(here + 'popup.css', 'utf8'))
 .replace('/*JS*/', () => js.replace(/<\/script/gi, '<\\/script'));
writeFileSync(here + 'popup.html', html);
console.log('popup.html', html.length, 'bytes');
// The plugin's own stylesheet shares the live-preview rules with the popup.
const root = here + '../../';
writeFileSync(root + 'styles.css', readFileSync(root + 'styles.base.css', 'utf8') + '\n' + readFileSync(here + 'live.css', 'utf8'));
