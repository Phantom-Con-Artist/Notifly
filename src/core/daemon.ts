import { FileSystemAdapter } from 'obsidian';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type Notifly from '../main';
import { ensureFolder } from './storage';
import { prefixFromName } from './templates';
const THEME_VARS = ['--background-primary', '--background-secondary', '--background-modifier-border', '--background-modifier-hover', '--text-normal', '--text-muted', '--text-faint', '--text-accent', '--interactive-accent', '--interactive-accent-hover', '--text-on-accent', '--text-error', '--code-background', '--tag-color', '--tag-background', '--font-text', '--font-interface', '--font-monospace', '--font-text-size', '--radius-s', '--radius-m'];
/** Snapshot of the active Obsidian theme, so the popup matches light/dark and community themes. */
export function themeVars(): Record<string, string> {
 const style = getComputedStyle(document.body);
 const out: Record<string, string> = {};
 for (const name of THEME_VARS) { const v = style.getPropertyValue(name).trim(); if (v) out[name] = v; }
 return out;
}
export class Daemon {
 constructor(private plugin: Notifly) {}
 root() {
  const adapter = this.plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) throw new Error('Quick capture only works with a vault stored on this computer.');
  return adapter.getBasePath();
 }
 dir() { return path.join(this.root(), this.plugin.app.vault.configDir, 'plugins', this.plugin.manifest.id, 'helper'); }
 /**
  * The quick capture app the person saved themselves: the location they chose, or the first file in the Notifly
  * folder whose name starts with notifly-daemon (preferring the one that names this system).
  */
 async executable(): Promise<string | null> {
  const custom = this.plugin.settings.helperPath.trim();
  if (custom) {
   try { await fs.access(custom); return custom; } catch { return null; }
  }
  let names: string[] = [];
  try { names = await fs.readdir(this.dir()); } catch { return null; }
  const windows = process.platform === 'win32';
  const system = windows ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const found = names.filter(n => n.startsWith('notifly-daemon') && !/\.(log|txt|json|sha256|zip|tmp|part)$/i.test(n) && (!windows || n.endsWith('.exe')));
  const score = (n: string) => (n === 'notifly-daemon' || n === 'notifly-daemon.exe' ? 3 : n.includes(system) ? 2 : 1);
  found.sort((a, b) => score(b) - score(a));
  return found[0] ? path.join(this.dir(), found[0]) : null;
 }
 /** Opens the folder where the quick capture app goes. */
 async showFolder() {
  await fs.mkdir(this.dir(), { recursive: true });
  const { shell } = (window as unknown as { require: (id: string) => { shell: { openPath(p: string): Promise<string> } } }).require('electron');
  await shell.openPath(this.dir());
 }
 async config() {
  await fs.mkdir(this.dir(), { recursive: true });
  await this.adoptCategories().catch(() => false);
  const config = { vault: this.root(), folder: this.plugin.settings.folder, theme: themeVars(), notes: this.notes(), templates: this.plugin.settings.templates, shortcut: this.plugin.settings.shortcut, autosave: this.plugin.settings.autosave, preview: this.plugin.settings.livePreview };
  const temporary = path.join(this.dir(), 'config-' + randomUUID() + '.tmp');
  await fs.writeFile(temporary, JSON.stringify(config));
  await fs.rename(temporary, path.join(this.dir(), 'config.json'));
 }
 notes() { return [...new Set(this.plugin.app.vault.getMarkdownFiles().map(f => f.basename))].slice(0, 5000); }
 /** The template used last, shared with the capture window; Thought until something else is used. */
 async lastTemplate() { return (await fs.readFile(path.join(this.dir(), 'last-template'), 'utf8').catch(() => '')).trim() || 'thought'; }
 async setLastTemplate(id: string) { await fs.mkdir(this.dir(), { recursive: true }); await fs.writeFile(path.join(this.dir(), 'last-template'), id); }
 /**
  * Categories made in the capture window wait in categories.json. This moves them into the plugin's own list
  * (so they can be renamed or removed) and empties the file. Returns true if any were new.
  */
 async adoptCategories(): Promise<boolean> {
  const file = path.join(this.dir(), 'categories.json');
  let before: string;
  try { before = await fs.readFile(file, 'utf8'); } catch { return false; }
  let pending: unknown;
  try { pending = JSON.parse(before); } catch { return false; }
  if (!Array.isArray(pending) || !pending.length) return false;
  const known = this.plugin.settings.templates;
  let added = false;
  for (const raw of pending as Array<Record<string, unknown>>) {
   const id = typeof raw['id'] === 'string' ? raw['id'].replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) : '';
   const name = typeof raw['name'] === 'string' ? raw['name'].replace(/\s+/g, ' ').trim().slice(0, 80) : '';
   if (!id || !name || known.some(k => k.id === id || k.name.toLowerCase() === name.toLowerCase())) continue;
   known.push({ id, name, prefix: prefixFromName(name), body: '', placeholder: '', icon: '' });
   added = true;
  }
  // Only clear the file if the helper has not added another one in the meantime.
  if ((await fs.readFile(file, 'utf8').catch(() => before)) === before) await fs.writeFile(file, '[]');
  if (added) await this.plugin.saveSettings();
  return added;
 }
 async installed() { return (await this.executable()) !== null; }
 async status(): Promise<string> {
  try {
   const state = JSON.parse(await fs.readFile(path.join(this.dir(), 'status.json'), 'utf8')) as { updated: number; error?: string; shortcut?: string };
   if (Date.now() - state.updated > 5000) return 'Stopped';
   return state.error ? 'Needs attention: ' + state.error : 'Running · ' + (state.shortcut || 'Alt+C');
  } catch { return 'Stopped'; }
 }
 async start() {
  if ((await this.status()) !== 'Stopped') return;
  const executable = await this.executable();
  if (!executable) throw new Error('Quick capture is not set up yet. Choose Get quick capture first.');
  // A file saved from a browser usually is not marked as a program yet.
  if (process.platform !== 'win32') await fs.chmod(executable, 0o755).catch(() => {});
  await ensureFolder(this.plugin);
  await this.config();
  await fs.unlink(path.join(this.dir(), 'stop')).catch(() => {});
  const log = await fs.open(path.join(this.dir(), 'helper.log'), 'a');
  try {
   const child = spawn(executable, [path.join(this.dir(), 'config.json')], { detached: true, stdio: ['ignore', log.fd, log.fd] });
   await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
   child.unref();
  } finally { await log.close(); }
 }
 /** Applies a new quick capture key to a running helper by turning it off and on again. */
 async restart() {
  if ((await this.status()) === 'Stopped') return;
  await this.stop();
  for (let i = 0; i < 40 && (await this.status()) !== 'Stopped'; i++) await new Promise(r => window.setTimeout(r, 250));
  await this.start();
 }
 async stop() { await fs.mkdir(this.dir(), {recursive:true}); await fs.writeFile(path.join(this.dir(), 'stop'), 'stop'); }
}
