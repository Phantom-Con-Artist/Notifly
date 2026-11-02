import { Modal, Notice, Setting, SuggestModal, setIcon } from 'obsidian';
import type Notifly from '../main';
import { categoryStats } from '../core/storage';
import { clone, DEFAULT_TEMPLATES, iconFor, PRESETS, prefixFromName, Template } from '../core/templates';

/** Categories ordered by how much they are used, then by name, so the useful ones come first however many exist. */
export function byUse(plugin: Notifly, list: Template[] = plugin.settings.templates): Template[] {
 const stats = categoryStats(plugin);
 return list.slice().sort((a, b) => (stats.get(b.id)?.count ?? 0) - (stats.get(a.id)?.count ?? 0) || (stats.get(b.id)?.last ?? 0) - (stats.get(a.id)?.last ?? 0) || a.name.localeCompare(b.name));
}

interface PickItem { kind: 'category' | 'create'; template?: Template; name: string; count: number }

/**
 * Find a category by typing, or make a new one from the name you typed. It stays fast with thousands of categories:
 * only the best matches are drawn.
 */
export class CategoryPicker extends SuggestModal<PickItem> {
 private readonly stats = categoryStats(this.plugin);
 private ordered = byUse(this.plugin);
 constructor(private plugin: Notifly, private onPick: (t: Template) => void, private opts: { allowCreate: boolean; placeholder?: string; label?: (t: Template) => string } = { allowCreate: true }) {
  super(plugin.app);
  this.setPlaceholder(opts.placeholder ?? (opts.allowCreate ? 'Find a category, or type a new name…' : 'Find a category…'));
  this.limit = 50;
  this.emptyStateText = 'No category matches.';
  this.setInstructions([{ command: '↑↓', purpose: 'to move' }, { command: '↵', purpose: 'to choose' }, { command: 'esc', purpose: 'to close' }]);
 }
 getSuggestions(query: string): PickItem[] {
  const q = query.replace(/\s+/g, ' ').trim().toLowerCase();
  const label = (t: Template) => this.opts.label?.(t) ?? t.name;
  const found = (q ? this.ordered.filter(t => label(t).toLowerCase().includes(q)) : this.ordered)
   .sort((a, b) => (q ? Number(label(b).toLowerCase().startsWith(q)) - Number(label(a).toLowerCase().startsWith(q)) : 0))
   .slice(0, 50)
   .map((template): PickItem => ({ kind: 'category', template, name: label(template), count: this.stats.get(template.id)?.count ?? 0 }));
  const exact = this.plugin.settings.templates.some(t => t.name.toLowerCase() === q);
  if (this.opts.allowCreate && q && !exact) found.push({ kind: 'create', name: query.replace(/\s+/g, ' ').trim(), count: 0 });
  return found;
 }
 renderSuggestion(item: PickItem, el: HTMLElement) {
  el.addClass('notifly-pick');
  if (item.kind === 'create') {
   setIcon(el.createSpan({ cls: 'notifly-pick-icon' }), 'plus');
   el.createSpan({ text: `New category “${item.name}”` });
   return;
  }
  setIcon(el.createSpan({ cls: 'notifly-pick-icon' }), iconFor(item.template ?? { id: '' }));
  el.createSpan({ cls: 'notifly-pick-name', text: item.name });
  if (item.count) el.createSpan({ cls: 'notifly-pick-count', text: String(item.count) });
 }
 onChooseSuggestion(item: PickItem) {
  void (async () => {
   try { this.onPick(item.kind === 'create' ? await this.plugin.createCategory(item.name) : (item.template as Template)); }
   catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
  })();
 }
}

/** The big, obvious way to make a category: name it, press Enter. */
export class NewCategoryModal extends Modal {
 constructor(private plugin: Notifly, private onMade: (t: Template) => void) { super(plugin.app); }
 onOpen() {
  this.modalEl.addClass('notifly-new-category');
  this.titleEl.setText('New category');
  this.contentEl.createEl('p', { cls: 'setting-item-description', text: 'A category groups similar thoughts. It shows up as a pill in the capture window and in your inbox.' });
  const input = this.contentEl.createEl('input', { type: 'text', cls: 'notifly-new-category-name', attr: { placeholder: 'Category name', 'aria-label': 'Category name', maxlength: '80' } });
  const bar = this.contentEl.createDiv({ cls: 'modal-button-container' });
  bar.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
  const make = bar.createEl('button', { text: 'Create', cls: 'mod-cta' });
  make.disabled = true;
  const submit = async () => {
   if (!input.value.trim()) return;
   try { const made = await this.plugin.createCategory(input.value); this.close(); this.onMade(made); }
   catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
  };
  input.addEventListener('input', () => { make.disabled = !input.value.trim(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } });
  make.addEventListener('click', () => { void submit(); });
  input.focus();
 }
 onClose() { this.contentEl.empty(); }
}

const PAGE = 40;

/** Rename, add and remove categories. Search, sort and paging keep it usable with thousands. */
export class CategoriesModal extends Modal {
 private list: Template[];
 private query = '';
 private sort: 'name' | 'used' = 'used';
 private limit = PAGE;
 private expanded = new Set<string>();
 /** Categories just made in this window stay at the top, so you can name them straight away. */
 private fresh: string[] = [];
 private rows!: HTMLElement;
 private readonly stats = categoryStats(this.plugin);
 constructor(private plugin: Notifly, private done: () => void) { super(plugin.app); this.list = clone(plugin.settings.templates); }
 onOpen() {
  this.modalEl.addClass('notifly-templates');
  this.titleEl.setText('Categories');
  const el = this.contentEl;
  el.createEl('p', { cls: 'setting-item-description', text: 'A category groups similar thoughts. Each one is a pill in the capture window and the inbox. Notes in a category you remove stay in your vault.' });
  const tools = el.createDiv({ cls: 'notifly-template-tools' });
  const find = tools.createEl('input', { type: 'search', cls: 'notifly-cat-search', attr: { placeholder: `Search ${this.list.length.toLocaleString()} categories…`, 'aria-label': 'Search categories' } });
  find.addEventListener('input', () => { this.query = find.value; this.limit = PAGE; this.draw(); });
  const sort = tools.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'Sort categories' } });
  sort.createEl('option', { text: 'Most used', value: 'used' });
  sort.createEl('option', { text: 'Name', value: 'name' });
  sort.addEventListener('change', () => { this.sort = sort.value === 'name' ? 'name' : 'used'; this.limit = PAGE; this.draw(); });
  tools.createEl('button', { text: 'New category', cls: 'mod-cta' }).addEventListener('click', () => {
   const made: Template = { id: 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: 'New category', prefix: 'New category', icon: '', body: '', placeholder: '' };
   this.list.unshift(made);
   this.expanded.add(made.id);
   this.fresh.unshift(made.id);
   this.query = ''; find.value = '';
   this.draw(made.id);
  });
  const presets = tools.createDiv({ cls: 'notifly-template-presets' });
  for (const p of PRESETS) if (!this.list.some(t => t.id === p.id)) presets.createEl('button', { text: 'Add ' + p.name.toLowerCase() }).addEventListener('click', () => { this.list.push({ ...p }); presets.empty(); this.draw(); });
  this.rows = el.createDiv({ cls: 'notifly-cat-rows' });
  new Setting(el).addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
   .addButton(b => b.setButtonText('Save').setCta().onClick(() => { void this.save(); }));
  this.draw();
 }
 private count(t: Template) { return this.stats.get(t.id)?.count ?? 0; }
 private draw(focusId?: string) {
  const q = this.query.trim().toLowerCase();
  const pin = (t: Template) => { const i = this.fresh.indexOf(t.id); return i < 0 ? 1e6 : i; };
  const all = this.list
   .filter(t => !q || t.name.toLowerCase().includes(q) || this.fresh.includes(t.id))
   .sort((a, b) => pin(a) - pin(b) || (this.sort === 'used' ? this.count(b) - this.count(a) : 0) || a.name.localeCompare(b.name));
  this.rows.empty();
  for (const t of all.slice(0, this.limit)) {
   const row = this.rows.createDiv({ cls: 'notifly-template-row' });
   const head = row.createDiv({ cls: 'notifly-template-head' });
   setIcon(head.createSpan({ cls: 'notifly-template-icon' }), iconFor(t));
   const name = head.createEl('input', { type: 'text', value: t.name, attr: { 'aria-label': 'Category name', maxlength: '80' } });
   name.addEventListener('input', () => { t.name = name.value; if (!DEFAULT_TEMPLATES.some(d => d.id === t.id)) t.prefix = prefixFromName(name.value); });
   if (this.count(t)) head.createSpan({ cls: 'notifly-template-count', text: `${this.count(t)} ${this.count(t) === 1 ? 'note' : 'notes'}` });
   const edit = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Starting text' } });
   setIcon(edit, 'file-pen');
   edit.addEventListener('click', () => { if (this.expanded.has(t.id)) this.expanded.delete(t.id); else this.expanded.add(t.id); this.draw(); });
   const del = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Remove category' } });
   setIcon(del, 'trash-2');
   del.disabled = this.list.length <= 1 || t.id === 'thought';
   del.addEventListener('click', () => { this.list = this.list.filter(x => x.id !== t.id); this.draw(); });
   if (this.expanded.has(t.id)) {
    const body = row.createEl('textarea', { text: t.body, attr: { rows: '3', 'aria-label': 'Starting text', spellcheck: 'false', placeholder: 'Empty: a blank Markdown note. Use {{cursor}} to set where the cursor starts.' } });
    body.addEventListener('input', () => { t.body = body.value; });
   }
   if (t.id === focusId) window.setTimeout(() => { name.focus(); name.select(); }, 0);
  }
  if (all.length > this.limit) this.rows.createEl('button', { cls: 'notifly-cat-more', text: `Show ${Math.min(PAGE, all.length - this.limit)} more (${(all.length - this.limit).toLocaleString()} left)` }).addEventListener('click', () => { this.limit += PAGE; this.draw(); });
  if (!all.length) this.rows.createDiv({ cls: 'notifly-empty-hint', text: 'No category matches.' });
 }
 private async save() {
  const names = new Set<string>();
  for (const t of this.list) {
   t.name = t.name.replace(/\s+/g, ' ').trim() || 'Category';
   if (names.has(t.name.toLowerCase())) { new Notice(`Two categories are called “${t.name}”. Give each its own name.`); return; }
   names.add(t.name.toLowerCase());
  }
  this.plugin.settings.templates = this.list;
  await this.plugin.saveSettings();
  this.plugin.syncConfig();
  this.done();
  this.close();
 }
 onClose() { this.contentEl.empty(); }
}
