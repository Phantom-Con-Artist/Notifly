import { AbstractInputSuggest, ItemView, MarkdownRenderer, Menu, Modal, Notice, TFile, WorkspaceLeaf, debounce, getAllTags, moment, setIcon } from 'obsidian';
import type Notifly from '../main';
import { renderSettings } from './settings';
import type { SortKey, Visit } from './settings';
import { capturedAt, thoughts } from '../core/storage';
import { CaptureModal } from './capture';
import { iconFor } from '../core/templates';
import { drawMedia, fileChip, isVisual, resolveMedia } from './preview';
import { attachmentsOf, fileKind, matches, parseQuery } from '../core/search';
import { byUse, NewCategoryModal } from './categories';
import { ICON_ID } from '../core/icon';
import { createNote, saveAttachment } from '../core/storage';
import { fileName } from '../editor/livepreview';
export { CaptureModal };
export const VIEW_TYPE = 'notifly-thoughts';

const SORTS: { key: SortKey; label: string; icon: string }[] = [
 { key: 'created-desc', label: 'Newest first', icon: 'arrow-down-wide-narrow' },
 { key: 'created-asc', label: 'Oldest first', icon: 'arrow-up-narrow-wide' },
 { key: 'modified-desc', label: 'Recently edited', icon: 'pencil' },
 { key: 'title-asc', label: 'Title A to Z', icon: 'a-large-small' },
 { key: 'links-desc', label: 'Most connected', icon: 'network' },
 { key: 'category-asc', label: 'Category', icon: 'layout-grid' },
 { key: 'visited-desc', label: 'Recently opened', icon: 'history' },
 { key: 'visits-desc', label: 'Most opened', icon: 'eye' },
];

interface Entry { file: TFile; created: number; body: string; type: string; tags: string[]; files: string[]; out: number; back: number; visit?: Visit }
interface Suggestion { kind: 'tag' | 'category' | 'file' | 'title' | 'type'; label: string; insert: string; count?: number }

/** One of six quiet accent colours for a category, the same everywhere so it is easy to recognise. */
export function hueOf(id: string): number { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 6; }
const quoted = (value: string) => (/\s/.test(value) ? `"${value}"` : value);
const TYPES = ['pdf', 'image', 'audio', 'video', 'file'];

/** Suggests what can be typed in the search box: tags, categories, attachment names, types and titles. */
class SearchSuggest extends AbstractInputSuggest<Suggestion> {
 constructor(private view: ThoughtsView, private input: HTMLInputElement, private onPick: (value: string) => void) { super(view.app, input); }
 getSuggestions(query: string): Suggestion[] {
  const token = /(\S+)$/.exec(query)?.[1]?.toLowerCase() ?? '';
  if (!token || this.view.overview) return [];
  const entries = this.view.entries;
  const tags = () => { const seen = new Map<string, number>(); for (const e of entries) for (const t of e.tags) seen.set(t, (seen.get(t) ?? 0) + 1); return seen; };
  const cats = () => { const seen = new Map<string, number>(); for (const e of entries) { const n = this.view.categoryName(e.type); seen.set(n, (seen.get(n) ?? 0) + 1); } return seen; };
  const files = () => { const seen = new Map<string, number>(); for (const e of entries) for (const f of e.files) seen.set(f, (seen.get(f) ?? 0) + 1); return seen; };
  const top = (m: Map<string, number>, needle: string, n: number) => [...m.entries()].filter(([k]) => k.toLowerCase().includes(needle)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
  const tag = (n: number, needle: string): Suggestion[] => top(tags(), needle, n).map(([value, count]) => ({ kind: 'tag', label: value.replace(/^#/, ''), insert: value, count }));
  const cat = (n: number, needle: string): Suggestion[] => top(cats(), needle, n).map(([value, count]) => ({ kind: 'category', label: value, insert: 'cat:' + quoted(value), count }));
  const file = (n: number, needle: string): Suggestion[] => top(files(), needle, n).map(([value, count]) => ({ kind: 'file', label: value, insert: 'file:' + quoted(value), count }));
  if (token.startsWith('#')) return tag(8, token);
  let m = /^(?:cat|category):"?(.*?)"?$/.exec(token);
  if (m) return cat(10, m[1] ?? '');
  m = /^(?:file|files|attachment):"?(.*?)"?$/.exec(token);
  if (m) return file(10, m[1] ?? '');
  m = /^type:(.*)$/.exec(token);
  if (m) return TYPES.filter(t => t.includes(m?.[1] ?? '')).map((t): Suggestion => ({ kind: 'type', label: t === 'file' ? 'any file' : t, insert: 'type:' + t }));
  const titles: Suggestion[] = entries.filter(e => e.file.basename.toLowerCase().includes(token)).slice(0, 4).map(e => ({ kind: 'title', label: e.file.basename, insert: quoted(e.file.basename) }));
  return [...cat(3, token), ...tag(3, token), ...file(3, token), ...titles];
 }
 renderSuggestion(s: Suggestion, el: HTMLElement) {
  el.addClass('notifly-suggestion');
  const icon = { tag: 'hash', category: 'layout-grid', file: 'paperclip', title: 'file-text', type: 'filter' }[s.kind];
  setIcon(el.createSpan({ cls: 'notifly-suggestion-icon' }), icon);
  el.createSpan({ cls: 'notifly-suggestion-label', text: s.label });
  if (s.kind === 'category') el.createSpan({ cls: 'notifly-suggestion-kind', text: 'category' });
  if (s.kind === 'file') el.createSpan({ cls: 'notifly-suggestion-kind', text: 'file' });
  if (s.count) el.createSpan({ cls: 'notifly-suggestion-count', text: String(s.count) });
 }
 selectSuggestion(s: Suggestion) {
  this.onPick(this.input.value.replace(/\S+$/, '') + s.insert + ' ');
  this.close();
 }
}

export class ThoughtsView extends ItemView {
 entries: Entry[] = [];
 private query = '';
 /** True while the category overview is showing, when the search box finds categories instead of notes. */
 get overview() { return this.mode === 'categories'; }
 private category: string | null = null;
 private limit = 120;
 /** Notes, or the bento overview of every category. */
 private mode: 'notes' | 'categories' = 'notes';
 private catSort: 'used' | 'recent' | 'name' = 'used';
 private catLimit = 60;
 private chips!: HTMLElement;
 private cfgBtn!: HTMLElement;
 private grid!: HTMLElement;
 private count!: HTMLElement;
 private searchEl!: HTMLInputElement;
 private sortBtn!: HTMLElement;
 private layoutBtn!: HTMLElement;
 private daemonBtn!: HTMLElement;
 private daemonState: 'running' | 'stopped' | 'error' = 'stopped';
 private daemonText = '';
 private installed = false;
 private gentleShown?: boolean;
 private gentleIndex = 0;
 private empty?: HTMLElement;
 private busy = false;
 private generation = 0;
 private cards = new Map<string, { mtime: number; el: HTMLElement }>();
 constructor(leaf: WorkspaceLeaf, private plugin: Notifly) { super(leaf); }
 getViewType() { return VIEW_TYPE; }
 getDisplayText() { return 'Notifly Inbox'; }
 getIcon() { return ICON_ID; }

 async onOpen() {
  this.contentEl.empty();
  this.contentEl.addClass('notifly-view');
  const bar = this.contentEl.createDiv({ cls: 'notifly-toolbar' });
  const search = bar.createDiv({ cls: 'search-input-container notifly-search' });
  this.searchEl = search.createEl('input', { attr: { type: 'search', enterkeyhint: 'search', spellcheck: 'false', placeholder: 'Search notes or #tags', 'aria-label': 'Search notes' } });
  const clear = search.createDiv({ cls: 'search-input-clear-button', attr: { 'aria-label': 'Clear search' } });
  const apply = (value: string) => { this.limit = 120; this.searchEl.value = value; this.query = value; search.toggleClass('is-active', !!value); void this.render(); };
  this.searchEl.addEventListener('input', () => apply(this.searchEl.value));
  // In the category overview, Enter opens the first match (or makes the category you typed).
  this.searchEl.addEventListener('keydown', e => {
   if (e.key !== 'Enter' || this.mode !== 'categories') return;
   e.preventDefault();
   (this.grid.querySelector<HTMLElement>('.notifly-tile:not(.is-new)') ?? this.grid.querySelector<HTMLElement>('.notifly-tile.is-new'))?.click();
  });
  clear.addEventListener('click', () => { apply(''); this.searchEl.focus(); });
  new SearchSuggest(this, this.searchEl, apply);
  this.searchEl.setAttribute('placeholder', 'Search words, #tags, categories or files');

  this.sortBtn = bar.createEl('button', { cls: 'clickable-icon notifly-sort', attr: { 'aria-label': 'Sort' } });
  this.sortBtn.addEventListener('click', e => this.sortMenu(e));
  this.layoutBtn = bar.createEl('button', { cls: 'clickable-icon notifly-layout' });
  this.layoutBtn.addEventListener('click', () => { void this.setLayout(this.plugin.settings.layout === 'bento' ? 'normal' : 'bento'); });
  this.daemonBtn = bar.createEl('button', { cls: 'clickable-icon notifly-daemon', attr: { 'aria-label': 'Background capture' } });
  setIcon(this.daemonBtn, 'zap');
  this.daemonBtn.createSpan({ cls: 'notifly-dot' });
  this.daemonBtn.addEventListener('click', e => { void this.daemonMenu(e); });
  this.cfgBtn = bar.createEl('button', { cls: 'clickable-icon notifly-config', attr: { 'aria-label': 'Notifly options' } });
  setIcon(this.cfgBtn, 'settings-2');
  this.cfgBtn.addEventListener('click', e => this.configMenu(e));
  const add = bar.createEl('button', { cls: 'mod-cta notifly-new', attr: { 'aria-label': 'New thought' } });
  setIcon(add.createSpan({ cls: 'notifly-new-icon' }), 'plus');
  add.createSpan({ text: 'New' });
  add.addEventListener('click', () => new CaptureModal(this.plugin).open());

  // Files dropped anywhere on the inbox become a new thought with those files in it.
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  this.contentEl.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); this.contentEl.addClass('is-dropping'); } });
  this.contentEl.addEventListener('dragleave', e => { if (!this.contentEl.contains(e.relatedTarget as Node | null)) this.contentEl.removeClass('is-dropping'); });
  this.contentEl.addEventListener('drop', e => {
   this.contentEl.removeClass('is-dropping');
   const files = Array.from(e.dataTransfer?.files ?? []);
   if (!files.length) return;
   e.preventDefault();
   void this.addDropped(files);
  });
  this.chips = this.contentEl.createDiv({ cls: 'notifly-chips', attr: { role: 'tablist', 'aria-label': 'Categories' } });
  this.count = this.contentEl.createDiv({ cls: 'notifly-count' });
  this.grid = this.contentEl.createDiv({ cls: 'notifly-grid', attr: { 'aria-live': 'polite' } });
  this.grid.addEventListener('click', e => {
   const t = e.target as HTMLElement;
   const link = t.closest('a.internal-link');
   if (link) { e.preventDefault(); e.stopPropagation(); void this.app.workspace.openLinkText(link.getAttribute('data-href') ?? '', '', e.ctrlKey || e.metaKey); return; }
   const tag = t.closest('a.tag');
   if (tag) { e.preventDefault(); e.stopPropagation(); apply((tag.getAttribute('href') ?? '') + ' '); }
  });

  const refresh = debounce(() => { void this.render(); }, 250, true);
  const mine = (path: string) => path.startsWith(this.plugin.settings.folder + '/');
  this.registerEvent(this.app.vault.on('create', f => mine(f.path) && refresh()));
  this.registerEvent(this.app.vault.on('modify', f => mine(f.path) && refresh()));
  this.registerEvent(this.app.vault.on('delete', f => mine(f.path) && refresh()));
  this.registerEvent(this.app.vault.on('rename', (f, old) => (mine(f.path) || mine(old)) && refresh()));
  this.registerEvent(this.app.metadataCache.on('resolved', refresh));
  // Opens are counted elsewhere, so catch up when this view comes back into focus.
  this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => { if (leaf === this.leaf) refresh(); }));
  this.registerInterval(window.setInterval(() => { void this.refreshStatus(); }, 2000));
  this.updateSortIcon();
  this.applyLayout();
  await this.refreshStatus();
  await this.render();
 }
 async onClose() { this.cards.clear(); }
 /** Redraws the inbox, for example after templates change. */
 refresh() { this.category = null; void this.render(); }

 private updateSortIcon() {
  const current = SORTS.find(s => s.key === this.plugin.settings.sort);
  setIcon(this.sortBtn, current?.icon ?? 'arrow-down-wide-narrow');
  this.sortBtn.setAttribute('aria-label', 'Sort: ' + (current?.label ?? 'Newest first'));
 }
 private configMenu(e: MouseEvent) {
  const menu = new Menu();
  const { settings } = this.plugin;
  menu.addItem(i => i.setTitle('Save as you type').setIcon('save').setChecked(settings.autosave).onClick(() => { void this.plugin.setAutosave(!settings.autosave); }));
  menu.addItem(i => i.setTitle('Bento layout').setIcon('layout-dashboard').setChecked(settings.layout !== 'normal').onClick(() => { void this.setLayout(settings.layout === 'normal' ? 'bento' : 'normal'); }));
  menu.addItem(i => i.setTitle('Show gentle progress notes').setIcon('sparkles').setChecked(settings.gentleStats).onClick(() => { settings.gentleStats = !settings.gentleStats; void this.plugin.saveSettings(); void this.render(); }));
  menu.addItem(i => i.setTitle('Show formatting as you type').setIcon('eye').setChecked(settings.livePreview).onClick(() => { settings.livePreview = !settings.livePreview; void this.plugin.saveSettings(); this.plugin.syncConfig(); }));
  menu.addSeparator();
  menu.addItem(i => i.setTitle('Manage categories').setIcon('layout-grid').onClick(() => this.plugin.openCategories()));
  menu.addItem(i => i.setTitle('More options').setIcon('settings').onClick(() => new OptionsModal(this.plugin).open()));
  menu.showAtMouseEvent(e);
 }
 private sortMenu(e: MouseEvent) {
  const menu = new Menu();
  for (const s of SORTS) menu.addItem(i => i.setTitle(s.label).setIcon(s.icon).setChecked(this.plugin.settings.sort === s.key).onClick(() => {
   this.plugin.settings.sort = s.key;
   void this.plugin.saveSettings();
   this.updateSortIcon();
   void this.render();
  }));
  menu.showAtMouseEvent(e);
 }
 private daemonMenu(e: MouseEvent) {
  const menu = new Menu();
  menu.addItem(i => i.setTitle(this.statusLine()).setIcon('zap').setDisabled(true));
  menu.addSeparator();
  const p = this.primaryAction();
  menu.addItem(i => i.setTitle(p.label).setIcon(p.icon).onClick(() => { void p.run(); }));
  if (!this.installed) menu.addItem(i => i.setTitle('Show the Notifly folder').setIcon('folder-open').onClick(() => { void this.plugin.daemon.showFolder().catch(e => new Notice(e instanceof Error ? e.message : String(e))); }));
  menu.addItem(i => i.setTitle('Quick capture options').setIcon('settings').onClick(() => new OptionsModal(this.plugin).open()));
  menu.showAtMouseEvent(e);
 }
 private async action(fn: () => Promise<void>) {
  if (this.busy) return;
  this.busy = true;
  this.daemonBtn.addClass('is-busy');
  try { await fn(); await this.refreshStatus(); }
  catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
  finally { this.busy = false; this.daemonBtn.removeClass('is-busy'); }
 }
 private async refreshStatus() {
  // Categories made in the Alt+C window join the plugin's list while the inbox is open.
  if (await this.plugin.daemon.adoptCategories().catch(() => false)) { this.plugin.syncConfig(); void this.render(); }
  const before = this.daemonState + this.installed;
  this.daemonText = await this.plugin.daemon.status();
  this.installed = await this.plugin.daemon.installed().catch(() => false);
  this.daemonState = this.daemonText.startsWith('Running') ? 'running' : this.daemonText.startsWith('Stopped') ? 'stopped' : 'error';
  this.daemonBtn.dataset.state = this.daemonState;
  const line = this.statusLine();
  this.daemonBtn.setAttribute('aria-label', line);
  // The first-run screen shows the same controls, so keep it in step.
  if (this.empty?.isConnected && before !== this.daemonState + this.installed) this.drawEmpty(this.empty);
 }
 /** One plain-words line describing quick capture. */
 private statusLine() {
  if (this.daemonState === 'running') return 'Quick capture is on. Press ' + (/·\s*(.+)$/.exec(this.daemonText)?.[1] ?? this.plugin.settings.shortcut) + ' anywhere.';
  if (this.daemonState === 'error') return this.daemonText;
  return this.installed ? 'Quick capture is off.' : 'Quick capture is not set up yet.';
 }
 /** Download, turn on or turn off, whichever makes sense right now. */
 private primaryAction() {
  if (!this.installed) return { label: 'Get quick capture', icon: 'external-link', run: () => { this.plugin.openReleases(); return Promise.resolve(); } };
  if (this.daemonState === 'stopped') return { label: 'Turn on quick capture', icon: 'power', run: () => this.action(() => this.plugin.daemon.start()) };
  return { label: 'Turn off quick capture', icon: 'power-off', run: () => this.action(() => this.plugin.daemon.stop()) };
 }

 private async loadEntries(): Promise<Entry[]> {
  const back = new Map<string, number>();
  const resolved = this.app.metadataCache.resolvedLinks;
  for (const src in resolved) for (const dest in resolved[src]) if (src !== dest) back.set(dest, (back.get(dest) ?? 0) + 1);
  const out: Entry[] = [];
  for (const file of thoughts(this.plugin)) {
   const raw = await this.app.vault.cachedRead(file);
   const cache = this.app.metadataCache.getFileCache(file);
   out.push({
    file,
    created: capturedAt(this.plugin, file),
    body: raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim(),
    visit: this.plugin.settings.visits[file.path],
    type: typeof cache?.frontmatter?.['notifly_type'] === 'string' ? cache.frontmatter['notifly_type'] : 'thought',
    tags: cache ? [...new Set(getAllTags(cache) ?? [])] : [],
    files: attachmentsOf(raw),
    out: Object.keys(resolved[file.path] ?? {}).length,
    back: back.get(file.path) ?? 0,
   });
  }
  return out;
 }
 private matches(e: Entry): boolean {
  return matches(parseQuery(this.query), { title: e.file.basename, body: e.body, category: this.categoryName(e.type), categoryId: e.type, tags: e.tags, files: e.files });
 }
 private sorted(list: Entry[]): Entry[] {
  const num = (e: Entry) => parseInt(/\d+/.exec(e.file.basename)?.[0] ?? '0', 10);
  const by: Record<SortKey, (a: Entry, b: Entry) => number> = {
   'created-desc': (a, b) => b.created - a.created,
   'created-asc': (a, b) => a.created - b.created,
   'modified-desc': (a, b) => b.file.stat.mtime - a.file.stat.mtime,
   'title-asc': (a, b) => a.file.basename.localeCompare(b.file.basename, undefined, { numeric: true }) || num(a) - num(b),
   'links-desc': (a, b) => (b.out + b.back) - (a.out + a.back) || b.created - a.created,
   'visited-desc': (a, b) => (b.visit?.last ?? 0) - (a.visit?.last ?? 0) || b.created - a.created,
   'visits-desc': (a, b) => (b.visit?.count ?? 0) - (a.visit?.count ?? 0) || (b.visit?.last ?? 0) - (a.visit?.last ?? 0) || b.created - a.created,
   'category-asc': (a, b) => this.categoryName(a.type).localeCompare(this.categoryName(b.type)) || b.created - a.created,
  };
  return [...list].sort(by[this.plugin.settings.sort]);
 }
 /** The popup calls the empty template "+"; here it reads as plain words. */
 categoryName(id: string) { return id === 'blank' ? 'Markdown' : (this.plugin.settings.templates.find(t => t.id === id)?.name ?? (id.charAt(0).toUpperCase() + id.slice(1))); }
 /**
  * A few pills for the busiest categories, then "More" for the rest and "New" to make one. This stays tidy with
  * thousands of categories because only the busiest few are drawn.
  */
 private renderChips() {
  this.chips.empty();
  const counts = new Map<string, number>();
  for (const e of this.entries) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const make = (id: string | null, label: string, icon: string, n: number | null) => {
   const b = this.chips.createEl('button', { cls: 'notifly-chip', attr: { role: 'tab', 'aria-selected': String(this.category === id) } });
   if (this.category === id) b.addClass('is-active');
   setIcon(b.createSpan({ cls: 'notifly-chip-icon' }), icon);
   b.createSpan({ text: label });
   if (n !== null) b.createSpan({ cls: 'notifly-chip-n', text: n.toLocaleString() });
   return b;
  };
  make(null, 'All', 'layers', this.entries.length).addEventListener('click', () => { this.category = null; this.setMode('notes'); });
  const known = new Map(this.plugin.settings.templates.map(t => [t.id, t]));
  for (const id of counts.keys()) if (!known.has(id)) known.set(id, { id, name: this.categoryName(id), prefix: '', body: '', placeholder: '', icon: '' });
  const ordered = byUse(this.plugin, [...known.values()]);
  const SHOWN = 7;
  const shown = ordered.slice(0, SHOWN);
  const current = this.category ? known.get(this.category) : undefined;
  if (current && !shown.some(t => t.id === current.id)) shown.push(current);
  for (const t of shown) make(t.id, this.categoryName(t.id), iconFor(t), counts.get(t.id) ?? 0).addEventListener('click', () => { this.category = this.category === t.id ? null : t.id; this.setMode('notes'); });
  const rest = ordered.length - shown.length;
  if (rest > 0) {
   const more = make(null, `${rest.toLocaleString()} more`, 'search', null);
   more.setAttribute('aria-label', 'Browse all categories');
   if (this.mode === 'categories') { more.addClass('is-active'); more.setAttribute('aria-selected', 'true'); } else { more.removeClass('is-active'); more.setAttribute('aria-selected', 'false'); }
   more.addEventListener('click', () => this.setMode(this.mode === 'categories' ? 'notes' : 'categories'));
  }
  const add = make(null, 'New', 'plus', null);
  add.removeClass('is-active'); add.setAttribute('aria-selected', 'false'); add.addClass('is-new'); add.setAttribute('aria-label', 'Make a new category');
  add.addEventListener('click', () => new NewCategoryModal(this.plugin, t => new CaptureModal(this.plugin, t.id).open()).open());
 }
 private groupOf(e: Entry): string | null {
  const key = this.plugin.settings.sort;
  if (key === 'category-asc') return this.categoryName(e.type);
  if (key === 'visits-desc') return null;
  if (key === 'visited-desc' && !e.visit) return 'Not opened yet';
  if (key !== 'created-desc' && key !== 'created-asc' && key !== 'modified-desc' && key !== 'visited-desc') return null;
  const t = moment(key === 'modified-desc' ? e.file.stat.mtime : key === 'visited-desc' ? (e.visit?.last ?? 0) : e.created);
  const days = moment().startOf('day').diff(t.clone().startOf('day'), 'days');
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return t.format('MMMM YYYY');
 }

 /** Bento is the default look. "Normal" turns off the varied sizes and the colour, everywhere at once. */
 private async setLayout(layout: 'bento' | 'normal') {
  this.plugin.settings.layout = layout;
  this.applyLayout();
  await this.plugin.saveSettings();
 }
 private applyLayout() {
  const bento = this.plugin.settings.layout !== 'normal';
  this.contentEl.toggleClass('is-normal', !bento);
  setIcon(this.layoutBtn, bento ? 'layout-dashboard' : 'layout-grid');
  this.layoutBtn.setAttribute('aria-label', bento ? 'Layout: bento. Switch to normal' : 'Layout: normal. Switch to bento');
  this.layoutBtn.setAttribute('aria-pressed', String(bento));
 }
 /** Makes a category from the name typed in the search box and starts a capture in it. */
 private async makeAndCapture(name: string) {
  const made = await this.plugin.createCategory(name);
  this.setMode('notes');
  new CaptureModal(this.plugin, made.id).open();
 }
 /** Switches between the notes and the category overview, keeping the search box honest about what it searches. */
 private setMode(mode: 'notes' | 'categories') {
  this.mode = mode;
  this.limit = 120;
  this.catLimit = 60;
  if (mode === 'categories') this.category = null;
  this.query = '';
  this.searchEl.value = '';
  this.searchEl.parentElement?.removeClass('is-active');
  this.searchEl.setAttribute('placeholder', mode === 'categories' ? 'Search categories' : 'Search words, #tags, categories or files');
  void this.render();
 }

 /**
  * Every category as a tile in a bento grid: the busiest are the biggest, each has a quiet accent colour, and it
  * stays tidy with thousands because only a page of tiles is drawn at a time.
  */
 private drawBento() {
  const info = new Map<string, { count: number; last: number; preview: string; at: number }>();
  for (const e of this.entries) {
   const i = info.get(e.type) ?? { count: 0, last: 0, preview: '', at: 0 };
   i.count++;
   i.last = Math.max(i.last, e.created);
   if (e.created >= i.at) { i.at = e.created; i.preview = e.body.replace(/!\[\[[^\]]*\]\]/g, '').replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, name: string, alias?: string) => alias ?? name).replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140); }
   info.set(e.type, i);
  }
  const known = new Map(this.plugin.settings.templates.map(t => [t.id, t.name]));
  for (const id of info.keys()) if (!known.has(id)) known.set(id, this.categoryName(id));
  const all = [...known.entries()].map(([id]) => ({ id, name: this.categoryName(id), ...(info.get(id) ?? { count: 0, last: 0, preview: '', at: 0 }) }));
  const q = this.query.trim().toLowerCase();
  const list = all.filter(c => !q || c.name.toLowerCase().includes(q));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  list.sort((a, b) => (this.catSort === 'name' ? byName(a, b) : this.catSort === 'recent' ? b.last - a.last || byName(a, b) : b.count - a.count || b.last - a.last || byName(a, b)));
  // The busiest category gets a big tile and the next three get wide ones, whatever the sort order.
  const busiest = [...all].filter(c => c.count > 1).sort((a, b) => b.count - a.count || byName(a, b)).slice(0, 4).map(c => c.id);

  this.grid.empty();
  const head = this.grid.createDiv({ cls: 'notifly-bento-head' });
  head.createSpan({ cls: 'notifly-bento-title', text: 'Categories' });
  head.createSpan({ cls: 'notifly-bento-count', text: q ? `${list.length.toLocaleString()} of ${all.length.toLocaleString()}` : all.length.toLocaleString() });
  const sort = head.createEl('select', { cls: 'dropdown notifly-bento-sort', attr: { 'aria-label': 'Sort categories' } });
  for (const [value, label] of [['used', 'Most used'], ['recent', 'Recently used'], ['name', 'Name']] as const) sort.createEl('option', { text: label, value });
  sort.value = this.catSort;
  sort.addEventListener('change', () => { this.catSort = sort.value === 'name' ? 'name' : sort.value === 'recent' ? 'recent' : 'used'; this.catLimit = 60; void this.render(); });
  head.createEl('button', { cls: 'notifly-bento-back', text: 'Show all notes' }).addEventListener('click', () => this.setMode('notes'));

  const grid = this.grid.createDiv({ cls: 'notifly-bento', attr: { role: 'list' } });
  const open = (id: string) => { this.category = id; this.setMode('notes'); };
  // The first tile is always the way to make a new one.
  const exact = all.some(c => c.name.toLowerCase() === q);
  const make = grid.createEl('button', { cls: 'notifly-tile is-new', attr: { role: 'listitem', 'aria-label': 'Make a new category' } });
  setIcon(make.createSpan({ cls: 'notifly-tile-plus' }), 'plus');
  make.createSpan({ cls: 'notifly-tile-name', text: q && !exact ? `New category “${this.query.trim()}”` : 'New category' });
  make.addEventListener('click', () => {
   if (q && !exact) { void this.makeAndCapture(this.query); return; }
   new NewCategoryModal(this.plugin, t => new CaptureModal(this.plugin, t.id).open()).open();
  });
  for (const c of list.slice(0, this.catLimit)) {
   const big = this.catSort === 'used' && !q && c.id === busiest[0];
   const wide = this.catSort === 'used' && !q && busiest.slice(1).includes(c.id);
   const tile = grid.createEl('button', { cls: 'notifly-tile' + (big ? ' is-big' : wide ? ' is-wide' : '') + (c.count ? '' : ' is-empty'), attr: { role: 'listitem', 'data-hue': String(hueOf(c.id)), 'aria-label': `${c.name}, ${c.count} ${c.count === 1 ? 'note' : 'notes'}` } });
   const top = tile.createDiv({ cls: 'notifly-tile-top' });
   top.createSpan({ cls: 'notifly-tile-name', text: c.name });
   top.createSpan({ cls: 'notifly-tile-dot' });
   if (big && c.preview) tile.createDiv({ cls: 'notifly-tile-preview', text: c.preview });
   const foot = tile.createDiv({ cls: 'notifly-tile-foot' });
   foot.createSpan({ cls: 'notifly-tile-count', text: c.count.toLocaleString() });
   foot.createSpan({ cls: 'notifly-tile-unit', text: c.count ? (c.count === 1 ? 'note' : 'notes') : 'no notes yet' });
   if (c.last && (big || wide)) foot.createSpan({ cls: 'notifly-tile-when', text: moment(c.last).fromNow() });
   tile.addEventListener('click', () => open(c.id));
  }
  if (!list.length) this.grid.createDiv({ cls: 'notifly-empty-hint', text: 'No category matches. Press Enter on the first tile to make it.' });
  if (list.length > this.catLimit) {
   const more = this.grid.createEl('button', { cls: 'notifly-show-more', text: `Show ${Math.min(60, list.length - this.catLimit)} more (${(list.length - this.catLimit).toLocaleString()} left)` });
   more.addEventListener('click', () => { this.catLimit += 60; void this.render(); });
  }
  this.count.empty();
  this.count.createSpan({ text: `${all.length.toLocaleString()} ${all.length === 1 ? 'category' : 'categories'}` });
 }

 private async render() {
  const generation = ++this.generation;
  this.entries = await this.loadEntries();
  this.renderChips();
  if (this.mode === 'categories') { if (generation === this.generation) this.drawBento(); return; }
  const shown = this.sorted(this.entries.filter(e => (!this.category || e.type === this.category) && this.matches(e)));
  const fragment = createFragment();
  let group: string | null | undefined;
  let section: HTMLElement | undefined;
  const keep = new Set<string>();
  for (const e of shown.slice(0, this.limit)) {
   const g = this.groupOf(e);
   if (g !== group || !section) {
    group = g;
    if (g) fragment.append(createDiv({ cls: 'notifly-group', text: g, attr: { role: 'heading', 'aria-level': '2' } }));
    section = createDiv({ cls: 'notifly-cards' });
    fragment.append(section);
   }
   keep.add(e.file.path);
   section.append(await this.card(e));
   if (generation !== this.generation) return;
  }
  if (generation !== this.generation) return;
  for (const path of this.cards.keys()) if (!keep.has(path)) this.cards.delete(path);
  this.grid.empty();
  this.grid.append(fragment);
  if (shown.length > this.limit) {
   const more = this.grid.createEl('button', { cls: 'notifly-show-more', text: `Show ${Math.min(120, shown.length - this.limit)} more (${(shown.length - this.limit).toLocaleString()} left)` });
   more.addEventListener('click', () => { this.limit += 120; void this.render(); });
  }
  const total = this.entries.length;
  this.count.empty();
  this.count.createSpan({ text: !total ? '' : this.query || this.category ? `${shown.length} of ${total}` : `${total} ${total === 1 ? 'note' : 'notes'}` });
  if (!this.query && !this.category) this.drawGentle();
  this.empty = undefined;
  if (!shown.length) {
   const empty = this.grid.createDiv({ cls: 'notifly-empty' });
   if (total) {
    setIcon(empty.createDiv({ cls: 'notifly-empty-icon' }), 'search-x');
    empty.createDiv({ cls: 'notifly-empty-title', text: 'Nothing found' });
    empty.createDiv({ cls: 'notifly-empty-hint', text: 'Try a different word, or clear the search.' });
   } else { this.empty = empty; this.drawEmpty(empty); }
  }
 }
 /** First-run screen: what Notifly is for, and the one thing to do next. */
 private drawEmpty(el: HTMLElement) {
  el.empty();
  el.addClass('is-welcome');
  setIcon(el.createDiv({ cls: 'notifly-empty-icon notifly-logo' }), ICON_ID);
  el.createDiv({ cls: 'notifly-empty-title', text: 'Keep capturing your thoughts without interruption' });
  el.createDiv({ cls: 'notifly-empty-hint', text: this.daemonState === 'running' ? `Quick capture is on. Press ${this.plugin.settings.shortcut} anywhere, even when Obsidian is closed, type your thought and it shows up here.` : this.installed ? `Turn on quick capture to jot a thought down from anywhere with ${this.plugin.settings.shortcut}, even when Obsidian is closed. Everything lands here.` : `Quick capture is a small app that works even when Obsidian is closed. Get it, save the file in the Notifly folder, then turn it on and press ${this.plugin.settings.shortcut} anywhere.` });
  const row = el.createDiv({ cls: 'notifly-empty-actions' });
  const p = this.primaryAction();
  if (this.daemonState === 'running') {
   const on = row.createSpan({ cls: 'notifly-pill' });
   on.createSpan({ cls: 'notifly-dot-inline' });
   on.createSpan({ text: 'Quick capture is on' });
  } else {
   const b = row.createEl('button', { cls: 'mod-cta', text: p.label });
   b.addEventListener('click', () => { void p.run(); });
  }
  if (!this.installed) row.createEl('button', { text: 'Show the folder' }).addEventListener('click', () => { void this.plugin.daemon.showFolder().catch(e => new Notice(e instanceof Error ? e.message : String(e))); });
  row.createEl('button', { text: 'Write a thought' }).addEventListener('click', () => new CaptureModal(this.plugin).open());
  if (this.daemonState === 'error') el.createDiv({ cls: 'notifly-empty-hint notifly-error', text: this.daemonText });
 }

 private async addDropped(files: File[]) {
  try {
   const parts: string[] = [];
   for (const f of files) parts.push(await saveAttachment(this.plugin, f, fileName(f)));
   const id = this.plugin.settings.templates.find(t => t.id === 'blank')?.id ?? this.plugin.settings.templates[0]?.id ?? 'thought';
   await createNote(this.plugin, id, parts.join('\n'));
   new Notice(files.length === 1 ? 'Added to your inbox.' : `Added ${files.length} files to your inbox.`);
  } catch (e) { new Notice(e instanceof Error ? e.message : 'Could not add those files.'); }
 }
 /** Removing is gentle: the note goes to Obsidian's trash, where it can still be recovered. */
 private async remove(file: TFile) {
  await this.app.fileManager.trashFile(file);
  new Notice(`Removed ${file.basename}. It's in your trash if you change your mind.`);
 }

 /**
  * A quiet, occasional line such as "You captured 3 thoughts today", with seven small bars for the week.
  * It appears at most once every few hours, never interrupts, and can be dismissed for a day.
  */
 private drawGentle() {
  const { settings } = this.plugin;
  if (!settings.gentleStats || !this.entries.length) return;
  const days = [...Array(7).keys()].map(i => moment().startOf('day').subtract(6 - i, 'days'));
  const per = days.map(d => this.entries.filter(e => moment(e.created).isSame(d, 'day')).length);
  const today = per[6] ?? 0;
  const week = per.reduce((a, b) => a + b, 0);
  let streak = 0;
  for (let i = today ? 6 : 5; i >= 0 && (per[i] ?? 0) > 0; i--) streak++;
  const plural = (n: number) => (n === 1 ? 'thought' : 'thoughts');
  const lines: string[] = [];
  if (today) lines.push(`You captured ${today} ${plural(today)} today`);
  if (week > today) lines.push(`${week} ${plural(week)} in the last 7 days`);
  if (streak >= 3) lines.push(`${streak} days in a row. Nice rhythm`);
  if (!lines.length) return;
  // Decide once per time the inbox is opened, so the line does not flicker as thoughts come and go.
  if (this.gentleShown === undefined) {
   const quiet = Date.now() - settings.statsShown.at < 3 * 3600_000;
   this.gentleShown = !quiet;
   if (!quiet) { this.gentleIndex = settings.statsShown.n; settings.statsShown = { at: Date.now(), n: settings.statsShown.n + 1 }; void this.plugin.saveSettings(); }
  }
  if (!this.gentleShown) return;
  const el = this.count.createDiv({ cls: 'notifly-gentle' });
  const bars = el.createSpan({ cls: 'notifly-bars', attr: { 'aria-hidden': 'true' } });
  const top = Math.max(1, ...per);
  per.forEach((n, i) => bars.createSpan({ cls: 'notifly-bar' + (i === 6 ? ' is-today' : ''), attr: { 'data-level': String(Math.round((n / top) * 6)) } }));
  el.createSpan({ text: lines[this.gentleIndex % lines.length] });
  const x = el.createEl('button', { cls: 'clickable-icon notifly-gentle-x', attr: { 'aria-label': 'Hide for today' } });
  setIcon(x, 'x');
  x.addEventListener('click', () => { settings.statsShown = { at: Date.now() + 21 * 3600_000, n: settings.statsShown.n }; this.gentleShown = false; void this.plugin.saveSettings(); el.remove(); });
 }

 private async card(e: Entry): Promise<HTMLElement> {
  const { file } = e;
  let cached = this.cards.get(file.path);
  if (!cached || cached.mtime !== file.stat.mtime) {
   const el = createDiv({ cls: 'notifly-card', attr: { tabindex: '0', role: 'article' } });
   const head = el.createDiv({ cls: 'notifly-card-head' });
   setIcon(head.createSpan({ cls: 'notifly-card-type' }), iconFor({ id: e.type }));
   head.createDiv({ cls: 'notifly-card-title' });
   const del = head.createEl('button', { cls: 'clickable-icon notifly-card-del', attr: { 'aria-label': 'Remove' } });
   setIcon(del, 'trash-2');
   del.addEventListener('click', ev => { ev.stopPropagation(); void this.remove(file); });
   const content = el.createDiv({ cls: 'notifly-card-content' });
   const body = content.createDiv({ cls: 'notifly-card-body markdown-rendered' });
   await MarkdownRenderer.render(this.app, e.body, body, file.path, this);
   // The files are shown on their own, so the embeds come out of the text.
   body.querySelectorAll('.internal-embed').forEach(n => n.remove());
   body.querySelectorAll('p:empty').forEach(n => n.remove());
   const media = resolveMedia(this.app, e.files, file.path);
   const visual = media.filter(isVisual).length;
   const sound = media.some(m => m.kind === 'audio') ? 1 : 0;
   if (visual + sound) { el.addClass('has-media'); drawMedia(this.app, content.createDiv({ cls: 'notifly-card-media' }), media); }
   el.dataset.visual = String(visual);
   el.dataset.sound = String(sound);
   const chips = el.createDiv({ cls: 'notifly-card-files' });
   for (const name of e.files.slice(0, 4)) chips.append(fileChip(name, fileKind(name)));
   if (e.files.length > 4) chips.createSpan({ cls: 'notifly-card-files-more', text: `+${e.files.length - 4}` });
   const foot = el.createDiv({ cls: 'notifly-card-foot' });
   foot.createSpan({ cls: 'notifly-card-date' });
   foot.createDiv({ cls: 'notifly-card-links' });
   const open = (ev: Event, newTab: boolean) => { ev.preventDefault(); void this.app.workspace.openLinkText(file.path, '', newTab); };
   el.addEventListener('click', ev => open(ev, (ev as MouseEvent).ctrlKey || (ev as MouseEvent).metaKey));
   el.addEventListener('auxclick', ev => { if (ev.button === 1) open(ev, true); });
   el.addEventListener('keydown', ev => {
    if (ev.target !== el) return;
    if (ev.key === 'Enter') open(ev, ev.ctrlKey || ev.metaKey);
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); void this.remove(file); }
   });
   el.addEventListener('contextmenu', ev => {
    const menu = new Menu();
    menu.addItem(i => i.setTitle('Open').setIcon('file-text').onClick(() => { void this.app.workspace.openLinkText(file.path, '', false); }));
    menu.addItem(i => i.setTitle('Open in new tab').setIcon('file-plus').onClick(() => { void this.app.workspace.openLinkText(file.path, '', true); }));
    menu.addSeparator();
    menu.addItem(i => i.setTitle('Remove').setIcon('trash-2').setWarning(true).onClick(() => { void this.remove(file); }));
    menu.showAtMouseEvent(ev);
   });
   cached = { mtime: file.stat.mtime, el };
   this.cards.set(file.path, cached);
  }
  // Title, date and connections change without the body changing (rename, new backlink), so refresh them every render.
  const el = cached.el;
  // Bento sizing: longer notes, lists and files get more room, short ones stay small.
  const visual = Number(el.dataset.visual ?? 0);
  const sound = Number(el.dataset.sound ?? 0);
  const words = e.body.split('\n').filter(l => l.trim() && !/^!?\[\[.*\]\]$/.test(l.trim()));
  const text = words.join('\n').length;
  // Pictures and PDFs make a tile roomy; a lot of them make it a hero. Text alone grows with its length.
  const size = visual >= 3 || (visual >= 2 && text > 150) ? 'hero'
   : visual >= 2 || (visual === 1 && text > 150) ? 'big'
   : visual === 1 ? 'tall'
   : sound ? 'wide'
   : text > 380 || words.length > 7 ? 'big'
   : text > 150 || e.files.length > 1 ? 'wide'
   : words.length >= 4 ? 'tall' : '';
  el.removeClasses(['is-hero', 'is-big', 'is-wide', 'is-tall']);
  if (size) el.addClass('is-' + size);
  el.setAttribute('data-hue', String(hueOf(e.type)));
  el.querySelector('.notifly-card-title')?.setText(file.basename);
  el.querySelector('.notifly-card-type')?.setAttribute('aria-label', this.categoryName(e.type));
  const date = el.querySelector('.notifly-card-date');
  const sort = this.plugin.settings.sort;
  if (sort === 'visits-desc') date?.setText(e.visit ? `${e.visit.count} ${e.visit.count === 1 ? 'open' : 'opens'}` : 'not opened');
  else date?.setText(moment(sort === 'modified-desc' ? file.stat.mtime : sort === 'visited-desc' && e.visit ? e.visit.last : e.created).fromNow());
  date?.setAttribute('aria-label', moment(e.created).format('LLL'));
  const meta = el.querySelector<HTMLElement>('.notifly-card-links');
  if (meta) {
   meta.empty();
   if (e.out) { const s = meta.createSpan({ attr: { 'aria-label': `${e.out} outgoing ${e.out === 1 ? 'link' : 'links'}` } }); setIcon(s.createSpan(), 'arrow-up-right'); s.createSpan({ text: String(e.out) }); }
   if (e.back) { const s = meta.createSpan({ attr: { 'aria-label': `${e.back} ${e.back === 1 ? 'backlink' : 'backlinks'}` } }); setIcon(s.createSpan(), 'arrow-down-left'); s.createSpan({ text: String(e.back) }); }
  }
  return el;
 }
}

/** All of Notifly's options in one window, so nobody has to dig through Obsidian's own settings. */
export class OptionsModal extends Modal {
 private cleanup?: () => void;
 constructor(private plugin: Notifly) { super(plugin.app); }
 onOpen() {
  this.modalEl.addClass('notifly-options');
  this.titleEl.setText('Notifly options');
  this.cleanup = renderSettings(this.contentEl, this.plugin);
 }
 onClose() { this.cleanup?.(); this.contentEl.empty(); }
}
