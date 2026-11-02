import { Notice, Plugin, TFolder, addIcon, debounce } from 'obsidian';
import { ICON_ID, ICON_SVG } from './core/icon';
import { RELEASES_URL } from './core/links';
import { DEFAULT_SETTINGS, NotiflySettings, Settings } from './ui/settings';
import { Daemon } from './core/daemon';
import { ensureFolder, addThoughtClass, renameLegacy, validFolder } from './core/storage';
import { CaptureModal, ThoughtsView, VIEW_TYPE } from './ui/view';
import { CategoriesModal } from './ui/categories';
import { clone, DEFAULT_TEMPLATES, prefixFromName, Template } from './core/templates';
export default class Notifly extends Plugin {
 settings!: Settings;
 daemon!: Daemon;
 async onload() {
  this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() as Partial<Settings> };
  if (!this.settings.templates?.length) this.settings.templates = clone(DEFAULT_TEMPLATES);
  this.daemon = new Daemon(this);
  this.registerView(VIEW_TYPE, leaf => new ThoughtsView(leaf, this));
  addIcon(ICON_ID, ICON_SVG);
  this.addRibbonIcon(ICON_ID, 'Open Notifly inbox', () => { void this.openThoughts(); });
  this.addCommand({ id: 'open-thoughts', name: 'Open inbox', callback: () => { void this.openThoughts(); } });
  this.addCommand({ id: 'capture-thought', name: 'Capture a thought', callback: () => new CaptureModal(this).open() });
  this.addSettingTab(new NotiflySettings(this.app, this));
  // The popup mirrors the active Obsidian theme, so refresh its snapshot whenever the theme changes.
  const syncTheme = debounce(() => { void this.daemon.config().catch(() => {}); }, 500, true);
  this.registerEvent(this.app.workspace.on('css-change', syncTheme));
  // Note names feed the popup's [[ suggestions.
  this.registerEvent(this.app.vault.on('create', syncTheme));
  this.registerEvent(this.app.vault.on('delete', syncTheme));
  this.registerEvent(this.app.vault.on('rename', syncTheme));
  this.app.workspace.onLayoutReady(() => {
   void (async () => {
    try { await renameLegacy(this); await addThoughtClass(this); await this.daemon.adoptCategories(); } catch (e) { console.error('Notifly: could not tidy older thoughts', e); }
    syncTheme();
   })();
  });
  this.registerEvent(this.app.workspace.on('file-open', f => { if (f && this.isThought(f.path)) this.visit(f.path); }));
  this.registerEvent(this.app.vault.on('delete', f => { if (this.settings.visits[f.path]) { delete this.settings.visits[f.path]; this.saveVisits(); } }));
  this.registerEvent(this.app.vault.on('rename', (file, old) => {
   const moved = this.settings.visits[old];
   if (moved) { delete this.settings.visits[old]; this.settings.visits[file.path] = moved; this.saveVisits(); }
   if (file instanceof TFolder && (this.settings.folder === old || this.settings.folder.startsWith(old + '/'))) {
    this.settings.folder = file.path + this.settings.folder.slice(old.length);
    void (async () => {
     try { await this.saveSettings(); await this.daemon.config(); } catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
    })();
   }
  }));
 }
 async saveSettings() { await this.saveData(this.settings); }
 private saveVisits = debounce(() => { void this.saveSettings(); }, 1500, true);
 private isThought(path: string) { return path.endsWith('.md') && path.startsWith(this.settings.folder + '/'); }
 /** Counts one open of a thought. */
 visit(path: string) {
  const v = this.settings.visits[path] ?? { last: 0, count: 0 };
  this.settings.visits[path] = { last: Date.now(), count: v.count + 1 };
  this.saveVisits();
 }
 /** Pushes templates, theme and note names to the helper. */
 syncConfig = debounce(() => { void this.daemon.config().catch(() => {}); }, 300, true);
 /** Autosave and the unsaved-draft store never hold the same capture; flipping the switch converts a pending one. */
 /** Saves a new quick capture key and, if quick capture is on, restarts it so the key works right away. */
 async changeShortcut(value: string) {
  this.settings.shortcut = value;
  await this.saveSettings();
  try {
   await this.daemon.config();
   await this.daemon.restart();
   await new Promise(r => window.setTimeout(r, 1500));
   const actual = /·\s*(.+)$/.exec(await this.daemon.status())?.[1];
   if (actual && actual.toLowerCase() !== value.toLowerCase()) new Notice(`Your computer picked ${actual} for quick capture. You can change it in your system's keyboard settings.`);
   else new Notice(`Quick capture now opens with ${value}.`);
  } catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
 }
 /** Makes a category from a name. A name that already exists (in any capitals) gives back that category. */
 async createCategory(name: string): Promise<Template> {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80);
  const existing = this.settings.templates.find(t => t.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const made: Template = { id: 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: clean, prefix: prefixFromName(clean), body: '', placeholder: '', icon: '' };
  this.settings.templates.push(made);
  await this.saveSettings();
  this.syncConfig();
  return made;
 }
 /** Opens the page where quick capture is published, in the browser. The plugin itself downloads nothing. */
 openReleases() { window.open(RELEASES_URL); }
 openCategories() {
  new CategoriesModal(this, () => { this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => { if (l.view instanceof ThoughtsView) l.view.refresh(); }); }).open();
 }
 async setAutosave(on: boolean) {
  this.settings.autosave = on;
  await this.saveSettings();
  this.syncConfig();
 }
 async moveFolder(value: string) {
  const next = validFolder(value);
  if (next === this.settings.folder) return;
  const old = this.app.vault.getAbstractFileByPath(this.settings.folder);
  if (this.app.vault.getAbstractFileByPath(next)) throw new Error('The destination already exists. Choose a new folder name.');
  const parent = next.split('/').slice(0,-1).join('/');
  if (parent && !this.app.vault.getAbstractFileByPath(parent)) await this.app.vault.createFolder(parent);
  if (old) await this.app.fileManager.renameFile(old, next);
  this.settings.folder = next;
  await ensureFolder(this);
  await this.saveSettings();
  await this.daemon.config();
  new Notice('Thoughts folder updated.');
 }
 async openThoughts() {
  let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
  if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({type:VIEW_TYPE,active:true}); }
  await this.app.workspace.revealLeaf(leaf);
 }
}
