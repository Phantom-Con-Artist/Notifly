import { normalizePath, TFile, TFolder } from 'obsidian';
import { randomUUID } from 'crypto';
import type Notifly from '../main';
export function validFolder(value: string): string {
 const path = normalizePath(value.trim());
 if (!path || path === '.' || path.split('/').some(p => p === '..' || p.startsWith('.')) || /[:\\]/.test(path)) throw new Error('Choose a visible folder inside the vault.');
 return path;
}
/** Name of the hidden file that marks the capture folder, so the helper can find it again after a rename. */
const MARKER = '.notifly-folder';
export async function ensureFolder(plugin: Notifly) {
 const { vault } = plugin.app;
 let folder = validFolder(plugin.settings.folder);
 if (!vault.getFolderByPath(folder)) {
  // The folder was renamed outside Notifly: look for the one carrying the marker. Hidden files are not in the
  // vault index, so the marker itself has to be read through the adapter.
  const matches: string[] = [];
  for (const dir of vault.getAllFolders()) {
   if (dir.path.split('/').some(p => p.startsWith('.'))) continue;
   if (await vault.adapter.exists(normalizePath(`${dir.path}/${MARKER}`))) matches.push(dir.path);
  }
  if (matches.length > 1) throw new Error('Multiple capture folders found. Choose the correct folder in settings.');
  if (matches[0]) { folder = matches[0]; plugin.settings.folder = folder; await plugin.saveSettings(); }
 }
 if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
 if (!(vault.getAbstractFileByPath(folder) instanceof TFolder)) throw new Error('The capture path is not a folder.');
 const marker = normalizePath(`${folder}/${MARKER}`);
 if (!(await vault.adapter.exists(marker))) await vault.adapter.write(marker, 'notifly');
 return folder;
}
import type { Session } from '../ui/settings';
import { prefixFromName, Template, THOUGHT } from './templates';
import { snippetFor } from '../editor/template-utils';

export const templateOf = (plugin: Notifly, id: string): Template => plugin.settings.templates.find(t => t.id === id) ?? { ...THOUGHT, id };
const prefixOf = (t: Template) => t.prefix || prefixFromName(t.name);
export function nextNumber(plugin: Notifly, prefix: string): number {
 const folder = plugin.app.vault.getAbstractFileByPath(plugin.settings.folder);
 let max = 0;
 if (folder instanceof TFolder) for (const f of folder.children) {
  if (!(f instanceof TFile) || f.extension !== 'md' || !f.basename.startsWith(prefix + ' ')) continue;
  const n = /^\d+$/.exec(f.basename.slice(prefix.length + 1));
  if (n) max = Math.max(max, +n[0]);
 }
 return max + 1;
}
export const noteContent = (type: string, id: string, created: string, body: string) =>
 `---\nnotifly: true\nnotifly_type: ${type.replace(/[^A-Za-z0-9_-]/g, '')}\ncssclasses: notifly-thought\nnotifly_id: ${id}\ncreated: ${created}\n---\n\n${body.trim()}\n`;
export const bodyOf = (raw: string) => raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
async function freePath(plugin: Notifly, folder: string, prefix: string) {
 for (let n = nextNumber(plugin, prefix); ; n++) {
  const path = normalizePath(`${folder}/${prefix} ${n}.md`);
  if (!plugin.app.vault.getAbstractFileByPath(path)) return path;
 }
}
/** Creates the note for a capture (the first autosave, or Save with autosave off). */
export async function createNote(plugin: Notifly, templateId: string, body: string): Promise<Session> {
 if (!body.trim()) throw new Error('Write a thought first.');
 const folder = await ensureFolder(plugin);
 const t = templateOf(plugin, templateId);
 const id = randomUUID();
 const created = new Date().toISOString();
 const file = await plugin.app.vault.create(await freePath(plugin, folder, prefixOf(t)), noteContent(t.id, id, created, body));
 return { path: file.path, id, created, template: t.id };
}
/** Rewrites a capture's note; if its category changed, the note moves to that category's numbering. */
export async function updateNote(plugin: Notifly, s: Session, templateId: string, body: string): Promise<Session> {
 const file = plugin.app.vault.getAbstractFileByPath(s.path);
 if (!(file instanceof TFile)) return createNote(plugin, templateId, body);
 const t = templateOf(plugin, templateId);
 const prefix = prefixOf(t);
 let path = file.path;
 if (!file.basename.startsWith(prefix + ' ')) {
  path = await freePath(plugin, file.parent?.path ?? plugin.settings.folder, prefix);
  await plugin.app.fileManager.renameFile(file, path);
 }
 // process() rewrites the file in one step, so it cannot clash with another plugin touching the same note.
 await plugin.app.vault.process(file, () => noteContent(t.id, s.id, s.created, body));
 return { ...s, path, template: t.id };
}
export async function discardNote(plugin: Notifly, s: Session) {
 const file = plugin.app.vault.getAbstractFileByPath(s.path);
 if (file instanceof TFile) await plugin.app.fileManager.trashFile(file);
}
/** A file name that is safe to link to and not already taken in the attachments folder. */
function attachmentName(plugin: Notifly, dir: string, name: string) {
 const base = Array.from(name.split(/[\\/]/).pop() ?? name).map(c => (c.charCodeAt(0) < 32 || ':*?"<>|#^[]'.includes(c) ? '-' : c)).join('').trim().replace(/^\.+/, '').trim() || 'File';
 const dot = base.lastIndexOf('.');
 const stem = dot > 0 ? base.slice(0, dot) : base;
 const ext = dot > 0 ? base.slice(dot) : '';
 let candidate = base;
 for (let n = 1; plugin.app.vault.getAbstractFileByPath(normalizePath(`${dir}/${candidate}`)); n++) candidate = `${stem} ${n}${ext}`;
 return candidate;
}
/** Saves a file (a picture, PDF, recording...) next to the thoughts and returns the Markdown to put in the note. */
export async function saveAttachment(plugin: Notifly, data: Blob, name: string): Promise<string> {
 const dir = normalizePath((await ensureFolder(plugin)) + '/attachments');
 if (!plugin.app.vault.getFolderByPath(dir)) await plugin.app.vault.createFolder(dir);
 const finalName = attachmentName(plugin, dir, name);
 await plugin.app.vault.createBinary(normalizePath(`${dir}/${finalName}`), await data.arrayBuffer());
 return snippetFor(finalName);
}
/** Gives older timestamp-named thoughts a "Thought N" name. Obsidian rewrites links that point at them. */
export async function renameLegacy(plugin: Notifly) {
 const legacy = thoughts(plugin).filter(f => /^Thought \d{4}-\d{2}-\d{2}T/.test(f.basename)).sort((a, b) => a.stat.ctime - b.stat.ctime);
 let n = nextNumber(plugin, 'Thought');
 for (const file of legacy) {
  let path: string;
  do path = normalizePath(`${file.parent?.path ?? ''}/Thought ${n++}.md`); while (plugin.app.vault.getAbstractFileByPath(path));
  await plugin.app.fileManager.renameFile(file, path);
 }
}
export function thoughts(plugin: Notifly): TFile[] {
 return plugin.app.vault.getMarkdownFiles().filter(f => {
  const meta = plugin.app.metadataCache.getFileCache(f)?.frontmatter;
  return meta?.notifly === true || f.path.startsWith(plugin.settings.folder + '/');
 }).sort((a,b) => capturedAt(plugin, b) - capturedAt(plugin, a));
}
/** Older thoughts lack the class that tucks their metadata into the corner icon. */
export async function addThoughtClass(plugin: Notifly) {
 for (const file of thoughts(plugin)) {
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  if (fm && JSON.stringify((fm as Record<string, unknown>)['cssclasses'] ?? '').includes('notifly-thought')) continue;
  await plugin.app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => { f['cssclasses'] = 'notifly-thought'; });
 }
}

/** How many notes each category has and when it was last used, for ordering pills and lists. */
export function categoryStats(plugin: Notifly): Map<string, { count: number; last: number }> {
 const stats = new Map<string, { count: number; last: number }>();
 for (const file of thoughts(plugin)) {
  const raw: unknown = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.['notifly_type'];
  const id = typeof raw === 'string' ? raw : 'thought';
  const s = stats.get(id) ?? { count: 0, last: 0 };
  s.count++;
  s.last = Math.max(s.last, capturedAt(plugin, file));
  stats.set(id, s);
 }
 return stats;
}

/**
 * When a thought was captured. The note says so itself (`created` in its properties), which stays true when a vault
 * is copied or synced; the file's own creation time does not. Older notes without it fall back to the file.
 */
export function capturedAt(plugin: Notifly, file: TFile): number {
 const raw: unknown = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.['created'];
 const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
 return Number.isFinite(t) ? t : file.stat.ctime;
}
