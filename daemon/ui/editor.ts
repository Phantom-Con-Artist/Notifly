import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { fileHandling, fileName, insertSnippet, linkClicks, livePreview, markdownBase, sourcePreview } from '../../src/editor/livepreview';
import { MAX_SECONDS, micProblem, Recorder, voiceName } from '../../src/editor/recorder';
import { Template, expand, finalize, glyph, isBlank } from '../../src/editor/template-utils';

// The capture window runs outside Obsidian, so it has no createSpan(). Give the shared editor code the one it uses.
(globalThis as unknown as { createSpan: (o?: { cls?: string; text?: string; attr?: Record<string, string> }) => HTMLSpanElement }).createSpan = o => {
 const s = document.createElement('span');
 if (o?.cls) s.className = o.cls;
 if (o?.text) s.textContent = o.text;
 for (const [k, v] of Object.entries(o?.attr ?? {})) s.setAttribute(k, v);
 return s;
};

interface Boot {
 notes: string[]; theme: Record<string, string>; templates: Template[]; numbers: Record<string, number>;
 autosave: boolean; preview: boolean; defaultTemplate: string; folder: string;
 restore: { template: string; text: string; file: string | null } | null; recent?: string[]; error?: string | null;
}
declare global { interface Window { __nativeRecord?: boolean; notiflyRecordFailed: (m: string) => void; ipc: { postMessage(m: string): void }; notiflyShow: (b: Boot) => void; notiflyError: (m: string) => void; notiflyInsert: (name: string) => void } }
const send = (kind: string, body = '') => window.ipc.postMessage(kind + '\n' + body);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let notes: string[] = [];
let templates: Template[] = [];
let numbers: Record<string, number> = {};
let current: Template = { id: 'thought', name: 'Thought', icon: '', body: '', placeholder: '', prefix: 'Thought' };
let restoredFile: string | null = null;
let autosave = true;
let live = true;
let busy = false;
let saved = false;
let timer = 0;
// Nothing is persisted until the window has been shown once, so startup can never overwrite an earlier capture.
let ready = false;
const saveBtn = $<HTMLButtonElement>('save');

const modeC = new Compartment();
const hintC = new Compartment();
const hintFor = (t: Template) => placeholder(t.placeholder || 'Write a thought. Markdown and [[wikilinks]] work.');
const prefixOf = (t: Template) => t.prefix || t.name || 'Thought';

function title() { return restoredFile ?? `${prefixOf(current)} ${numbers[prefixOf(current)] ?? 1}`; }
function payload(text: string) { return JSON.stringify({ template: current.id, text }); }

let pendingName = '';
/** The small line at the top right: files being added win over the word count. */
function statusText(doc: string) {
 if (pending) return pendingName ? `Adding ${pendingName}…` : 'Adding files…';
 const words = isBlank(doc) ? 0 : doc.replace(/^(?:- \[[ x]\]|>|—)\s?/gm, '').trim().split(/\s+/).length;
 return words ? `${words} ${words === 1 ? 'word' : 'words'}${autosave ? (saved ? ' · autosaved' : '') : ' · draft kept'}` : '';
}
function update() {
 const doc = view.state.doc.toString();
 const blank = isBlank(doc);
 saveBtn.disabled = blank || busy;
 $('status').textContent = statusText(doc);
 $('title').textContent = title();
 window.clearTimeout(timer);
 if (!ready) return;
 if (autosave) {
  saved = false;
  timer = window.setTimeout(() => { send('autosave', payload(blank ? '' : finalize(doc))); saved = !blank; $('status').textContent = statusText(view.state.doc.toString()); }, 700);
 } else timer = window.setTimeout(() => send('draft', payload(blank ? '' : doc)), 400);
}

function err(message: string) { const e = $('error'); e.textContent = message; e.hidden = !message; busy = false; saveBtn.disabled = isBlank(view.state.doc.toString()); }
function save() {
 const doc = view.state.doc.toString();
 if (isBlank(doc) || busy) return;
 busy = true; saveBtn.disabled = true;
 window.clearTimeout(timer);
 send('save', payload(finalize(doc)));
}
/** Cancel / Discard throws the capture away. Esc only hides the window and keeps everything. */
function cancel() { stopRecordingQuietly(); window.clearTimeout(timer); send('cancel'); }
function hideKeep() {
 stopRecordingQuietly();
 window.clearTimeout(timer);
 if (ready) {
  const doc = view.state.doc.toString();
  const blank = isBlank(doc);
  send(autosave ? 'autosave' : 'draft', payload(blank ? '' : autosave ? finalize(doc) : doc));
 }
 send('hide');
}
function applyMode() {
 saveBtn.hidden = autosave;
 $('cancel').textContent = autosave ? 'Discard' : 'Cancel';
 $('hint-auto').hidden = !autosave;
 $('hint-manual').hidden = autosave;
}

function setLive(on: boolean) {
 live = on;
 view.dispatch({ effects: modeC.reconfigure(on ? livePreview : sourcePreview) });
 $('editor').classList.toggle('nf-raw', !on);
 $('preview').setAttribute('aria-pressed', String(on));
}

function choose(t: Template) {
 const previous = expand(current).text;
 const doc = view.state.doc.toString();
 current = t;
 restoredFile = null;
 view.dispatch({ effects: hintC.reconfigure(hintFor(t)) });
 // Untouched scaffolding is swapped for the new template; anything the user wrote stays.
 if (isBlank(doc) || doc === previous) {
  const { text, cursor } = expand(t);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: cursor } });
 }
 renderPicker();
 update();
 view.focus();
}

// ---- Categories: a few pills for what you use most, a box to find any of thousands, and a way to make a new one.
const SHOWN = 12;
let pickerIndex = 0;
let matches: Template[] = [];
let canCreate = '';
let recent: string[] = [];
const picker = $('picker');
const finder = $<HTMLInputElement>('cat-find');
const pickerOpen = () => !picker.hidden;
const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, 80);
const safePrefix = (name: string) => cleanName(name).replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/^\.+/, '') || 'Note';
function ranked(query: string): Template[] {
 const q = query.trim().toLowerCase();
 const rank = (t: Template) => { const i = recent.indexOf(t.id); return i < 0 ? 1e6 - (numbers[prefixOf(t)] ?? 0) : i; };
 const list = q ? templates.filter(t => t.name.toLowerCase().includes(q)) : templates.slice();
 return list.sort((a, b) => (q ? Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) : 0) || rank(a) - rank(b) || a.name.localeCompare(b.name));
}
function renderPicker() {
 const query = finder.value;
 const all = ranked(query);
 matches = all.slice(0, SHOWN);
 const exact = templates.some(t => t.name.toLowerCase() === cleanName(query).toLowerCase());
 canCreate = cleanName(query) && !exact ? cleanName(query) : '';
 const count = matches.length + (canCreate ? 1 : 0);
 pickerIndex = Math.min(pickerIndex, Math.max(0, count - 1));
 picker.querySelector('#cat-pills')!.replaceChildren();
 const host = $('cat-pills');
 matches.forEach((t, i) => {
  const b = document.createElement('button');
  b.type = 'button'; b.setAttribute('role', 'option'); b.className = 'tpl';
  b.setAttribute('aria-selected', String(i === pickerIndex));
  b.dataset.active = String(t.id === current.id);
  const g = document.createElement('span'); g.className = 'glyph'; g.textContent = glyph(t);
  const n = document.createElement('span'); n.textContent = t.name;
  b.append(g, n);
  b.addEventListener('mousedown', e => e.preventDefault());
  b.addEventListener('click', () => { closePicker(); choose(t); });
  host.append(b);
 });
 if (canCreate) {
  const b = document.createElement('button');
  b.type = 'button'; b.setAttribute('role', 'option'); b.className = 'tpl create';
  b.setAttribute('aria-selected', String(pickerIndex === matches.length));
  b.textContent = '+ New category “' + canCreate + '”';
  b.addEventListener('mousedown', e => e.preventDefault());
  b.addEventListener('click', () => makeCategory(canCreate));
  host.append(b);
 }
 const more = all.length - matches.length;
 $('cat-note').textContent = more > 0 ? `${more.toLocaleString()} more. Keep typing to narrow it down.` : templates.length > SHOWN ? `${templates.length.toLocaleString()} categories` : '';
}
function openPicker() {
 finder.value = '';
 pickerIndex = 0;
 picker.hidden = false; $('chip').setAttribute('aria-expanded', 'true');
 renderPicker();
 finder.focus();
}
function closePicker() { picker.hidden = true; $('chip').setAttribute('aria-expanded', 'false'); view.focus(); }
const togglePicker = () => (pickerOpen() ? closePicker() : openPicker());
/** A new name typed in the box becomes a category. If the name already exists, that one is used. */
function makeCategory(name: string) {
 const clean = cleanName(name);
 if (!clean) return;
 const existing = templates.find(t => t.name.toLowerCase() === clean.toLowerCase());
 closePicker();
 if (existing) { choose(existing); return; }
 const id = 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
 const made: Template = { id, name: clean, prefix: safePrefix(clean), body: '', placeholder: '', icon: '' };
 templates.push(made);
 send('category-create', JSON.stringify({ id, name: clean }));
 choose(made);
}
function pickHighlighted(forceCreate: boolean) {
 if (forceCreate && cleanName(finder.value)) { makeCategory(finder.value); return; }
 if (pickerIndex < matches.length) { const t = matches[pickerIndex]; if (t) { closePicker(); choose(t); } }
 else if (canCreate) makeCategory(canCreate);
}
finder.addEventListener('input', () => { pickerIndex = 0; renderPicker(); });

// Alt on its own browses categories; Tab does the same on an empty note.
let altClean = false;
window.addEventListener('keydown', e => {
 if (e.key === 'Alt') { if (!e.repeat) altClean = true; return; }
 altClean = false;
 if (e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setLive(!live); return; }
 if (pickerOpen()) {
  const total = matches.length + (canCreate ? 1 : 0);
  const step = (d: number) => { pickerIndex = (pickerIndex + d + total) % Math.max(1, total); renderPicker(); };
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) step(1);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) step(-1);
  else if (e.key === 'Enter') pickHighlighted(e.ctrlKey || e.metaKey);
  else if (e.key === 'Escape') closePicker();
  else return; // letters go into the box
  e.preventDefault(); e.stopPropagation();
 } else if (e.key === 'Tab' && !e.shiftKey && isBlank(view.state.doc.toString())) {
  e.preventDefault(); e.stopPropagation(); openPicker();
 }
}, true);
window.addEventListener('keyup', e => { if (e.key === 'Alt') { if (altClean) togglePicker(); altClean = false; } });


// Files travel to the helper in small pieces, so a large PDF or recording never blocks the window.
const CHUNK = 384 * 1024;
let pending = 0;
const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] ?? ''); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
async function upload(file: Blob, name: string): Promise<null> {
 const id = crypto.randomUUID();
 pending++; pendingName = name; showPending();
 try {
  send('file-start', JSON.stringify({ id, name }));
  for (let at = 0; at < file.size; at += CHUNK) send('file-chunk', id + '\n' + await toBase64(file.slice(at, at + CHUNK)));
  send('file-end', id);
 } catch { send('file-abort', id); pending = Math.max(0, pending - 1); err('Could not add ' + name + '.'); }
 return null; // the helper replies with the Markdown through notiflyInsert once the file is saved
}
function showPending() { if (!pending) pendingName = ''; $('status').textContent = statusText(view.state.doc.toString()); }

const recorder = new Recorder();
const clock = (s: number) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
// On Linux the helper records through the system's audio tools; elsewhere the page records itself.
const native = !!window.__nativeRecord;
let nativeOn = false;
let nativeTimer = 0;
let nativeStart = 0;
const isRecording = () => (native ? nativeOn : recorder.active);
function recordingUi(on: boolean) {
 $('record').classList.toggle('is-recording', on);
 $('record').setAttribute('aria-label', on ? 'Stop recording' : 'Record a voice note');
 if (!on) $('rec-time').textContent = '';
}
async function toggleRecording() {
 if (native) {
  if (nativeOn) {
   nativeOn = false; window.clearInterval(nativeTimer); recordingUi(false);
   pending++; pendingName = 'voice note'; showPending();
   send('record-stop', voiceName('wav'));
   view.focus();
  } else {
   nativeOn = true; nativeStart = Date.now(); recordingUi(true);
   $('rec-time').textContent = '0:00';
   nativeTimer = window.setInterval(() => { const s = Math.floor((Date.now() - nativeStart) / 1000); $('rec-time').textContent = clock(s); if (s >= MAX_SECONDS) void toggleRecording(); }, 500);
   send('record-start');
  }
  return;
 }
 if (recorder.active) {
  recordingUi(false);
  const rec = await recorder.stop();
  if (rec) void upload(rec.blob, voiceName(rec.ext));
  view.focus();
  return;
 }
 try {
  await recorder.start(s => { $('rec-time').textContent = clock(s); }, () => { void toggleRecording(); });
  recordingUi(true);
 } catch (x) { err(micProblem(x)); }
}
function stopRecordingQuietly() {
 if (native) {
  if (nativeOn) send('record-cancel');
  nativeOn = false; window.clearInterval(nativeTimer);
 } else recorder.cancel();
 recordingUi(false);
}
// The helper could not start or finish a recording.
window.notiflyRecordFailed = message => { nativeOn = false; window.clearInterval(nativeTimer); recordingUi(false); pending = Math.max(0, pending - 1); showPending(); err(message); };

const view = new EditorView({
 parent: $('editor'),
 extensions: [
  history(),
  ...markdownBase(() => notes),
  modeC.of(livePreview),
  hintC.of(hintFor(current)),
  fileHandling(file => upload(file, fileName(file))),
  linkClicks(url => send('open', url)),
  keymap.of([
   { key: 'Mod-Enter', run: () => { save(); return true; } },
   { key: 'Escape', run: () => { if (isRecording()) { stopRecordingQuietly(); return true; } hideKeep(); return true; } },
   ...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab,
  ]),
  EditorView.updateListener.of(u => { if (u.docChanged) { err(''); update(); } }),
  EditorState.tabSize.of(2),
 ],
});

saveBtn.addEventListener('click', save);
$('cancel').addEventListener('click', cancel);
$('chip').addEventListener('click', togglePicker);
$('import').addEventListener('click', () => $<HTMLInputElement>('file').click());
$<HTMLInputElement>('file').addEventListener('change', e => {
 const input = e.target as HTMLInputElement;
 for (const f of Array.from(input.files ?? [])) void upload(f, fileName(f));
 input.value = '';
});
$('record').addEventListener('click', () => { void toggleRecording(); });
$('preview').addEventListener('click', () => { setLive(!live); view.focus(); });
$('bar').addEventListener('mousedown', e => { if (e.button === 0 && (e.target as HTMLElement).closest('button') === null) send('drag'); });
window.notiflyError = err;
window.notiflyInsert = snippet => { insertSnippet(view, snippet); pending = Math.max(0, pending - 1); showPending(); view.focus(); };

// The window stays alive between captures; Rust calls this each time it is shown.
window.notiflyShow = boot => {
 stopRecordingQuietly();
 for (const [k, v] of Object.entries(boot.theme)) document.documentElement.style.setProperty(k, v);
 notes = boot.notes ?? [];
 templates = boot.templates ?? [];
 recent = boot.recent ?? [];
 numbers = boot.numbers ?? {};
 autosave = boot.autosave;
 applyMode();
 $('folder').textContent = boot.folder;
 const byId = (id: string) => templates.find(t => t.id === id);
 const restore = boot.restore;
 current = byId(restore?.template ?? '') ?? byId(boot.defaultTemplate) ?? byId('thought') ?? templates[0] ?? current;
 restoredFile = restore?.file ?? null;
 picker.hidden = true;
 pickerIndex = 0;
 finder.value = '';
 const { text, cursor } = restore ? { text: restore.text, cursor: restore.text.length } : expand(current);
 view.dispatch({ effects: hintC.reconfigure(hintFor(current)), changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: cursor } });
 setLive(boot.preview);
 saved = !!restore?.file;
 ready = true;
 err(boot.error ?? '');
 update();
 view.focus();
};
update();
