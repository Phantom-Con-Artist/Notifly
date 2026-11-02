import { Modal, Notice, setIcon } from 'obsidian';
import { Compartment } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { fileHandling, fileName, insertSnippet, linkClicks, livePreview, markdownBase, sourcePreview } from '../editor/livepreview';
import { micProblem, Recorder, voiceName } from '../editor/recorder';
import { expand, finalize, isBlank } from '../editor/template-utils';
import { Prec } from '@codemirror/state';
import type Notifly from '../main';
import type { Session } from './settings';
import { bodyOf, categoryStats, createNote, discardNote, nextNumber, saveAttachment, templateOf, updateNote } from '../core/storage';
import { CategoryPicker } from './categories';
import type { Template } from '../core/templates';

/** In-app twin of the Alt+C window: same templates, same autosave/draft rules, same editor. */
export class CaptureModal extends Modal {
 private editor!: EditorView;
 private current!: Template;
 private session: Session | null = null;
 private timer = 0;
 private finished = false;
 private live = false;
 private chain: Promise<unknown> = Promise.resolve();
 private readonly mode = new Compartment();
 private readonly hint = new Compartment();
 constructor(private plugin: Notifly, private initialId?: string) { super(plugin.app); }

 async onOpen() {
  const { settings } = this.plugin;
  this.modalEl.addClass('notifly-modal');
  this.live = settings.livePreview;
  const templates = settings.templates;
  const last = await this.plugin.daemon.lastTemplate().catch(() => 'thought');
  let text: string | null = null;
  let template = templates.find(t => t.id === (this.initialId ?? last)) ?? templates.find(t => t.id === 'thought') ?? templates[0];

  // Leftovers of an unfinished capture. The two stores never coexist: switching the autosave
  // setting converts whichever one is left, so nothing is saved twice or lost.
  if (settings.session) {
   const file = this.app.vault.getFileByPath(settings.session.path);
   if (file) {
    text = bodyOf(await this.app.vault.read(file));
    if (!this.initialId) template = templates.find(t => t.id === settings.session?.template) ?? template;
    if (settings.autosave) this.session = settings.session;
    else await discardNote(this.plugin, settings.session);
   }
   if (!this.session) { settings.session = null; await this.plugin.saveSettings(); }
  }
  if (text === null && settings.draft) {
   text = settings.draft.text;
   if (!this.initialId) template = templates.find(t => t.id === settings.draft?.template) ?? template;
  }
  if (!template) { new Notice('No templates are available.'); this.close(); return; }
  this.current = template;

  const head = this.contentEl.createDiv({ cls: 'notifly-capture-head' });
  const pills = head.createDiv({ cls: 'notifly-cat-pills', attr: { role: 'tablist', 'aria-label': 'Category' } });
  const status = head.createSpan({ cls: 'notifly-hint notifly-status' });
  const host = this.contentEl.createDiv({ cls: 'notifly-editor nf-live', attr: { 'aria-label': 'Thought in Markdown' } });
  const bar = this.contentEl.createDiv({ cls: 'modal-button-container' });
  const attach = bar.createEl('button', { cls: 'clickable-icon notifly-attach', attr: { 'aria-label': 'Add a file: PDF, picture, sound, video and more' } });
  setIcon(attach, 'paperclip');
  const mic = bar.createEl('button', { cls: 'clickable-icon notifly-mic', attr: { 'aria-label': 'Record a voice note' } });
  setIcon(mic.createSpan({ cls: 'notifly-mic-icon' }), 'mic');
  const micTime = mic.createSpan({ cls: 'notifly-mic-time' });
  const picker = bar.createEl('input', { type: 'file', attr: { multiple: '', hidden: '' } });
  const hintEl = bar.createSpan({ cls: 'notifly-hint', text: settings.autosave ? 'Ctrl/Cmd + Enter to finish · Esc keeps it' : 'Ctrl/Cmd + Enter to save' });
  const previewBtn = bar.createEl('button', { cls: 'clickable-icon notifly-preview', attr: { 'aria-label': 'Toggle live preview' } });
  setIcon(previewBtn, 'eye');
  const autosave = settings.autosave;
  bar.createEl('button', { text: autosave ? 'Discard' : 'Cancel' }).addEventListener('click', () => { void this.discard(); });
  const saveBtn = bar.createEl('button', { text: 'Save', cls: 'mod-cta' });
  saveBtn.hidden = autosave;
  hintEl.addClass('notifly-grow');

  const refresh = () => {
   const doc = this.editor.state.doc.toString();
   const blank = isBlank(doc);
   saveBtn.disabled = blank;
   const t = this.current;
   this.titleEl.setText(this.session ? (this.app.vault.getFileByPath(this.session.path)?.basename ?? t.name) : `${t.prefix || t.name} ${nextNumber(this.plugin, t.prefix || t.name)}`);
   status.setText(blank ? '' : this.plugin.settings.autosave ? 'Autosave on' : 'Draft kept');
   previewBtn.toggleClass('is-active', this.live);
  };
  const setMode = () => {
   this.editor.dispatch({ effects: this.mode.reconfigure(this.live ? livePreview : sourcePreview) });
   host.toggleClass('nf-raw', !this.live);
   refresh();
  };
  // A few pills for the categories you use most, "more" for the rest, "New" to make one: tidy at any size.
  const drawPills = () => {
   pills.empty();
   const stats = categoryStats(this.plugin);
   const use = (t: Template) => stats.get(t.id)?.count ?? 0;
   const top = this.plugin.settings.templates.filter(t => t.id !== this.current.id).sort((a, b) => use(b) - use(a) || a.name.localeCompare(b.name)).slice(0, 5);
   for (const t of [this.current, ...top]) {
    const b = pills.createEl('button', { cls: 'notifly-cat-pill' + (t.id === this.current.id ? ' is-active' : ''), text: t.name, attr: { role: 'tab', 'aria-selected': String(t.id === this.current.id) } });
    if (t.id !== this.current.id) b.addEventListener('click', () => choose(t));
   }
   const rest = this.plugin.settings.templates.length - 6;
   if (rest > 0) pills.createEl('button', { cls: 'notifly-cat-pill is-more', text: `${rest.toLocaleString()} more`, attr: { 'aria-label': 'Find another category' } }).addEventListener('click', () => new CategoryPicker(this.plugin, t => choose(t), { allowCreate: true }).open());
   const add = pills.createEl('button', { cls: 'notifly-cat-pill is-new', attr: { 'aria-label': 'Make a new category' } });
   setIcon(add.createSpan(), 'plus');
   add.createSpan({ text: 'New' });
   add.addEventListener('click', () => new CategoryPicker(this.plugin, t => choose(t), { allowCreate: true, placeholder: 'Type a name to make a new category…' }).open());
  };
  const choose = (t: Template) => {
   const before = expand(this.current).text;
   const doc = this.editor.state.doc.toString();
   this.current = t;
   drawPills();
   this.editor.dispatch({ effects: this.hint.reconfigure(this.hintFor(t)) });
   if (isBlank(doc) || doc === before) {
    const { text: body, cursor } = expand(t);
    this.editor.dispatch({ changes: { from: 0, to: doc.length, insert: body }, selection: { anchor: cursor } });
   }
   this.schedule();
   refresh();
   this.editor.focus();
  };

  const start = text ?? expand(template).text;
  this.editor = new EditorView({
   parent: host,
   doc: start,
   selection: { anchor: text === null ? expand(template).cursor : start.length },
   extensions: [
    history(),
    ...markdownBase(() => this.app.vault.getMarkdownFiles().map(f => f.basename)),
    this.mode.of(this.live ? livePreview : sourcePreview),
    this.hint.of(this.hintFor(template)),
    fileHandling(file => this.addFile(file, fileName(file))),
    linkClicks(url => { window.open(url); }),
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { void this.save(); return true; } }])),
    keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of(u => { if (u.docChanged) { this.schedule(); refresh(); } }),
   ],
  });
  attach.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => { const chosen = Array.from(picker.files ?? []); picker.value = ''; void this.addPicked(chosen); });
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const toggleMic = async () => {
   if (this.recorder.active) {
    mic.removeClass('is-recording'); micTime.setText('');
    const rec = await this.recorder.stop();
    if (rec) { const s = await this.addFile(rec.blob, voiceName(rec.ext)); if (s) insertSnippet(this.editor, s); }
    this.editor.focus();
    return;
   }
   try {
    await this.recorder.start(s => micTime.setText(clock(s)), () => { void toggleMic(); });
    mic.addClass('is-recording');
    mic.setAttribute('aria-label', 'Stop recording');
   } catch (x) { new Notice(micProblem(x)); }
  };
  mic.addEventListener('click', () => { void toggleMic(); });
  this.resetMic = () => { mic.removeClass('is-recording'); micTime.setText(''); };
  // Finish from anywhere in the window, not only while the cursor is in the text.
  this.scope.register(['Mod'], 'Enter', () => { void this.save(); return false; });
  drawPills();
  previewBtn.addEventListener('click', () => { this.live = !this.live; setMode(); this.editor.focus(); });
  saveBtn.addEventListener('click', () => { void this.save(); });
  host.toggleClass('nf-raw', !this.live);
  refresh();
  if (text !== null) this.schedule(); // restored text is persisted by whichever mode is active now
  this.editor.focus();
 }

 private readonly recorder = new Recorder();
 private resetMic: () => void = () => {};
 /** Esc, a click outside or the close button first end a running recording; only then does the window close. */
 close() {
  if (this.recorder.active) { this.recorder.cancel(); this.resetMic(); this.editor.focus(); return; }
  super.close();
 }
 /** Adds files chosen with the paperclip, one after another, at the cursor. */
 private async addPicked(files: File[]) {
  for (const f of files) {
   const snippet = await this.addFile(f, fileName(f));
   if (snippet) insertSnippet(this.editor, snippet);
  }
 }
 /** Saves a file and returns the Markdown for it, or null (with a plain message) if that failed. */
 private async addFile(file: Blob, name: string): Promise<string | null> {
  try { return await saveAttachment(this.plugin, file, name); }
  catch (e) { new Notice(e instanceof Error ? e.message : 'Could not add ' + name + '.'); return null; }
 }
 private hintFor(t: Template) { return placeholder(t.placeholder || 'Write a thought. Markdown and [[wikilinks]] work.'); }
 private text() { return this.editor.state.doc.toString(); }
 /** Runs persistence one step at a time so a quick save cannot race an autosave. */
 private queue(fn: () => Promise<void>) {
  const previous = this.chain;
  const run = async () => {
   await previous;
   try { await fn(); } catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
  };
  this.chain = run();
  return this.chain;
 }
 private schedule() {
  window.clearTimeout(this.timer);
  this.timer = window.setTimeout(() => { void this.persist(); }, 600);
 }
 /** Autosave: keep a real note in step with the text. Autosave off: keep only a draft. */
 private persist() {
  window.clearTimeout(this.timer);
  const doc = this.text();
  const blank = isBlank(doc);
  const { settings } = this.plugin;
  return this.queue(async () => {
   if (settings.autosave) {
    settings.draft = null;
    if (blank) { if (this.session) await discardNote(this.plugin, this.session); this.session = null; }
    else this.session = this.session ? await updateNote(this.plugin, this.session, this.current.id, finalize(doc)) : await createNote(this.plugin, this.current.id, finalize(doc));
    settings.session = this.session;
   } else {
    settings.session = null;
    settings.draft = blank ? null : { template: this.current.id, text: doc };
   }
   await this.plugin.saveSettings();
  });
 }
 private async save() {
  const doc = this.text();
  if (isBlank(doc)) return;
  window.clearTimeout(this.timer);
  this.finished = true;
  await this.queue(async () => {
   const t = templateOf(this.plugin, this.current.id);
   if (this.session) await updateNote(this.plugin, this.session, t.id, finalize(doc));
   else await createNote(this.plugin, t.id, finalize(doc));
   this.session = null;
   this.plugin.settings.session = null;
   this.plugin.settings.draft = null;
   await this.plugin.saveSettings();
   await this.plugin.daemon.setLastTemplate(t.id).catch(() => {});
  });
  this.close();
 }
 /** Cancel throws the capture away, including any note autosave already wrote. */
 private async discard() {
  window.clearTimeout(this.timer);
  this.finished = true;
  await this.queue(async () => {
   if (this.session) await discardNote(this.plugin, this.session);
   this.session = null;
   this.plugin.settings.session = null;
   this.plugin.settings.draft = null;
   await this.plugin.saveSettings();
  });
  this.close();
 }
 onClose() {
  // Closing without Save or Cancel keeps the work: flush it so the next capture picks it up.
  this.recorder.cancel();
  if (!this.finished) void this.persist();
  this.editor?.destroy();
  this.contentEl.empty();
 }
}
