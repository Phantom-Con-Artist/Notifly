import { App, TFile, loadPdfJs, normalizePath, setIcon } from 'obsidian';
import { fileKind } from '../core/search';

/** A file a note holds, found in the vault. */
export interface Media { file: TFile; kind: string }

interface PdfPage { getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> } }
interface PdfDoc { getPage(n: number): Promise<PdfPage>; destroy?: () => void }
interface PdfJs { getDocument(o: { data: ArrayBuffer }): { promise: Promise<PdfDoc> } }

const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** Finds the files named in a note, the same way Obsidian resolves a link. */
export function resolveMedia(application: App, names: string[], sourcePath: string): Media[] {
 const out: Media[] = [];
 for (const name of names) {
  const file = application.metadataCache.getFirstLinkpathDest(name, sourcePath) ?? application.vault.getFileByPath(normalizePath(name));
  if (file) out.push({ file, kind: fileKind(file.name) });
 }
 return out;
}
export const isVisual = (m: Media) => m.kind === 'image' || m.kind === 'pdf' || m.kind === 'video';

// Rendering a PDF page is heavy, so a couple at a time.
const waiting: Array<() => Promise<void>> = [];
let active = 0;
function later(task: () => Promise<void>) {
 waiting.push(task);
 const next = () => {
  if (active >= 2) return;
  const run = waiting.shift();
  if (!run) return;
  active++;
  void run().catch(() => {}).finally(() => { active--; next(); });
  next();
 };
 next();
}

const ICONS: Record<string, string> = { pdf: 'file-text', audio: 'mic', video: 'film', image: 'image', file: 'paperclip' };

/** A small labelled chip for a file. Used for anything that has no picture to show. */
export function fileChip(name: string, kind: string): HTMLElement {
 const chip = createSpan({ cls: 'notifly-file-chip' });
 setIcon(chip.createSpan({ cls: 'notifly-file-chip-icon' }), ICONS[kind] ?? 'paperclip');
 chip.createSpan({ text: name.split('/').pop() ?? name });
 return chip;
}

async function renderPdf(application: App, file: TFile, canvas: HTMLCanvasElement) {
 if (file.stat.size > MAX_PDF_BYTES) throw new Error('too big for a preview');
 const pdfjs = (await loadPdfJs()) as PdfJs;
 const doc = await pdfjs.getDocument({ data: await application.vault.readBinary(file) }).promise;
 try {
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const view = page.getViewport({ scale: 380 / base.width });
  canvas.width = Math.ceil(view.width);
  canvas.height = Math.ceil(view.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no canvas');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport: view }).promise;
 } finally { doc.destroy?.(); }
}

function thumb(application: App, host: HTMLElement, m: Media) {
 const box = host.createDiv({ cls: `notifly-thumb is-${m.kind}`, attr: { 'data-name': m.file.name } });
 const fallback = () => { box.empty(); box.addClass('is-fallback'); box.append(fileChip(m.file.name, m.kind)); };
 box.createSpan({ cls: 'notifly-thumb-badge', text: m.kind === 'pdf' ? 'PDF' : m.kind === 'video' ? 'Video' : 'Image' });
 if (m.kind === 'image') {
  const img = box.createEl('img', { attr: { src: application.vault.getResourcePath(m.file), alt: m.file.name, loading: 'lazy', draggable: 'false' } });
  img.addEventListener('error', fallback);
 } else if (m.kind === 'video') {
  const video = box.createEl('video', { attr: { src: application.vault.getResourcePath(m.file) + '#t=0.1', preload: 'metadata', muted: '', playsinline: '' } });
  video.addEventListener('error', fallback);
 } else {
  const canvas = box.createEl('canvas', { cls: 'notifly-thumb-pdf' });
  later(async () => { try { await renderPdf(application, m.file, canvas); } catch { fallback(); } });
 }
}

/**
 * Draws what is really in a note: pictures, the first page of PDFs, video frames and a small player for sound.
 * Files with nothing to show are left to the chips row.
 */
export function drawMedia(application: App, host: HTMLElement, media: Media[]) {
 const visual = media.filter(isVisual).slice(0, 3);
 const audio = media.find(m => m.kind === 'audio');
 if (visual.length) {
  const row = host.createDiv({ cls: `notifly-thumbs has-${visual.length}` });
  for (const m of visual) thumb(application, row, m);
 }
 if (audio) {
  const line = host.createDiv({ cls: 'notifly-audio', attr: { 'data-name': audio.file.name } });
  setIcon(line.createSpan({ cls: 'notifly-audio-icon' }), 'mic');
  const player = line.createEl('audio', { attr: { controls: '', preload: 'none', src: application.vault.getResourcePath(audio.file) } });
  // Playing a recording should not open the note.
  for (const type of ['click', 'keydown', 'dblclick'] as const) player.addEventListener(type, e => e.stopPropagation());
 }
}
