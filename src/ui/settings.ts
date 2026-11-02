import { App, Notice, PluginSettingTab, Scope, Setting } from 'obsidian';
import type Notifly from '../main';
import { clone, DEFAULT_TEMPLATES, Template } from '../core/templates';
export type SortKey = 'created-desc' | 'created-asc' | 'modified-desc' | 'title-asc' | 'links-desc' | 'category-asc' | 'visited-desc' | 'visits-desc';
/** A capture that autosave has already written to the vault. */
export interface Session { path: string; id: string; created: string; template: string }
export interface Visit { last: number; count: number }
export interface Settings {
 folder: string; helperPath: string; sort: SortKey; /** Bento is the default look; normal is plain uniform cards. */ layout: 'bento' | 'normal';
 autosave: boolean; livePreview: boolean; shortcut: string; templates: Template[];
 /** Unsaved text kept when autosave is off. Autosave uses `session` instead; only one is ever set. */
 draft: { template: string; text: string } | null;
 session: Session | null;
 /** How often and when each thought was opened in Obsidian, for the two "opened" sorts. */
 visits: Record<string, Visit>;
 /** Occasional friendly counts on the Inbox. `at` is when one was last shown, `n` rotates the wording. */
 gentleStats: boolean;
 statsShown: { at: number; n: number };
}
export const DEFAULT_SETTINGS: Settings = {
 folder: 'notifly-captured-thoughts', helperPath: '', sort: 'created-desc', layout: 'bento',
 autosave: true, livePreview: true, shortcut: 'Alt+C', templates: clone(DEFAULT_TEMPLATES), draft: null, session: null,
 visits: {}, gentleStats: true, statsShown: { at: 0, n: 0 },
};
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'];
/** Turns a key press into text like "Ctrl+Shift+K", or says why it cannot be used. */
export function shortcutFrom(e: KeyboardEvent): { value?: string; problem?: string } {
 const m = /^Key([A-Z])$/.exec(e.code) ?? /^Digit(\d)$/.exec(e.code);
 const key = m?.[1] ?? (/^F([1-9]|1\d|2[0-4])$/.test(e.code) ? e.code : e.code === 'Space' ? 'Space' : null);
 if (!key) return { problem: 'That key can\'t be used. Try a letter, a number, Space or F1 to F12.' };
 if (!(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) return { problem: 'Hold Ctrl, Alt, Shift or Meta while you press the key.' };
 return { value: [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', key].filter(Boolean).join('+') };
}
/** Draws every Notifly option. Used by Obsidian's settings tab and by the options window inside the inbox. */
export function renderSettings(containerEl: HTMLElement, plugin: Notifly): () => void {
  const { settings } = plugin;
  containerEl.empty();
  let folder: string | undefined;
  const keyRow = new Setting(containerEl).setName('Quick capture key').setDesc('The keys that open the capture window from anywhere. Click the button, then press the keys you want.');
  let button: HTMLButtonElement | undefined;
  let listening: Scope | undefined;
  // Obsidian's own key handling would grab Esc and shortcuts like Ctrl+O first, so the picker takes over the keyboard the same way Obsidian's hotkey screen does.
  const stopListening = () => {
   if (listening) plugin.app.keymap.popScope(listening);
   listening = undefined;
   button?.removeClass('mod-warning');
   button?.setText(settings.shortcut);
  };
  const applyShortcut = async (value: string) => {
   await plugin.changeShortcut(value);
   button?.setText(settings.shortcut);
  };
  const onKey = (e: KeyboardEvent) => {
   if (MODIFIERS.includes(e.key)) return; // wait for the real key
   if (e.key === 'Escape') { stopListening(); return; }
   const r = shortcutFrom(e);
   if (r.problem || !r.value) { new Notice(r.problem ?? 'That key can\'t be used.'); return; }
   stopListening();
   void applyShortcut(r.value);
  };
  keyRow.addButton(b => {
   button = b.buttonEl;
   b.setButtonText(settings.shortcut).setTooltip('Click, then press new keys. Esc to cancel.').onClick(() => {
    if (listening) { stopListening(); return; }
    b.buttonEl.addClass('mod-warning');
    b.setButtonText('Press your keys…');
    listening = new Scope();
    listening.register(null, null, e => { onKey(e); return false; });
    plugin.app.keymap.pushScope(listening);
   });
  });
  keyRow.addExtraButton(b => b.setIcon('rotate-ccw').setTooltip('Go back to Alt+C').onClick(() => { stopListening(); void applyShortcut('Alt+C'); }));

  new Setting(containerEl).setName('Saving').setHeading();
  new Setting(containerEl).setName('Save as you type').setDesc('Your thought is saved while you write, so you never lose it. Turn this off to keep unsaved text as a draft that you save yourself.')
   .addToggle(t => t.setValue(settings.autosave).onChange(async v => { await plugin.setAutosave(v); }));
  new Setting(containerEl).setName('Show formatting as you type').setDesc('Headings, checkboxes and links look right while you write. Turn this off to see plain text. You can also press Alt+P in the capture window.')
   .addToggle(t => t.setValue(settings.livePreview).onChange(async v => { settings.livePreview = v; await plugin.saveSettings(); plugin.syncConfig(); }));
  new Setting(containerEl).setName('Show small progress notes').setDesc('Now and then, a quiet note in your inbox about how many thoughts you captured.')
   .addToggle(t => t.setValue(settings.gentleStats).onChange(async v => { settings.gentleStats = v; await plugin.saveSettings(); }));

  new Setting(containerEl).setName('Categories').setHeading();
  new Setting(containerEl).setName('Categories').setDesc('Three categories come ready. Make as many of your own as you like. Each one shows up as a pill in the capture window and the inbox.')
   .addButton(b => b.setButtonText('Manage categories').onClick(() => plugin.openCategories()));

  new Setting(containerEl).setName('Where thoughts go').setHeading();
  new Setting(containerEl).setName('Thoughts folder').setDesc('Moving the folder keeps your links working. You can also rename it in the file list.')
   .addText(t => t.setValue(settings.folder).onChange(v => { folder = v; }))
   .addButton(b => b.setButtonText('Move folder').onClick(() => { void plugin.moveFolder(folder ?? settings.folder).catch(e => new Notice(e instanceof Error ? e.message : String(e))); }));

  new Setting(containerEl).setName('Quick capture app').setHeading();
  const app = new Setting(containerEl).setName('Quick capture app').setDesc('Checking…');
  void (async () => {
   const found = await plugin.daemon.executable().catch(() => null);
   app.setDesc(found ? 'Found: ' + (found.split(/[\\/]/).pop() ?? found) : 'Not set up yet. Get it, save the file in the Notifly folder, then turn quick capture on.');
  })();
  app.addButton(b => b.setButtonText('Get quick capture').setCta().onClick(() => plugin.openReleases()))
   .addButton(b => b.setButtonText('Show folder').onClick(() => { void plugin.daemon.showFolder().catch(e => new Notice(e instanceof Error ? e.message : String(e))); }));
  new Setting(containerEl).setName('App location').setDesc('Optional. If you saved quick capture somewhere else, type where. Leave empty to use the Notifly folder.')
   .addText(t => t.setPlaceholder('Notifly folder').setValue(settings.helperPath).onChange(async v => { settings.helperPath = v.trim(); await plugin.saveSettings(); }));
  return stopListening;
}
export class NotiflySettings extends PluginSettingTab {
 private cleanup?: () => void;
 constructor(app: App, private plugin: Notifly) { super(app, plugin); }
 display() { this.cleanup?.(); this.cleanup = renderSettings(this.containerEl, this.plugin); }
 hide() { this.cleanup?.(); this.cleanup = undefined; }
}
