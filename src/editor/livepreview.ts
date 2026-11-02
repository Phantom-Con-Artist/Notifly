import { EditorState, Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { syntaxTree } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, CompletionContext } from '@codemirror/autocomplete';
import { keymap } from '@codemirror/view';

class Bullet extends WidgetType {
 toDOM() { return createSpan({ cls: 'nf-bullet', text: '•' }); }
}
class Check extends WidgetType {
 constructor(private done: boolean, private at: number) { super(); }
 eq(o: Check) { return o.done === this.done && o.at === this.at; }
 toDOM(view: EditorView) {
  const b = createSpan({ cls: 'nf-check' + (this.done ? ' is-done' : ''), attr: { role: 'checkbox', 'aria-checked': String(this.done) } });
  // Toggle without moving the caret, like a native Obsidian checkbox.
  b.addEventListener('mousedown', e => {
   e.preventDefault();
   const from = this.at + 1;
   view.dispatch({ changes: { from, to: from + 1, insert: this.done ? ' ' : 'x' } });
  });
  return b;
 }
 ignoreEvent() { return false; }
}
/** What a file is, in a word, for the chip that stands in for an embed. */
export function kindOf(name: string): string {
 const ext = (name.split('.').pop() ?? '').toLowerCase();
 if (ext === 'pdf') return 'PDF';
 if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'Image';
 if (['mp3', 'wav', 'm4a', 'ogg', 'flac', '3gp'].includes(ext) || (ext === 'webm' && /^voice/i.test(name))) return 'Audio';
 if (['mp4', 'mkv', 'mov', 'ogv', 'webm'].includes(ext)) return 'Video';
 return 'File';
}
class Embed extends WidgetType {
 constructor(private name: string) { super(); }
 eq(o: Embed) { return o.name === this.name; }
 toDOM() { return createSpan({ cls: 'nf-embed', text: this.name, attr: { 'data-kind': kindOf(this.name) } }); }
}
const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new Bullet() });

// Obsidian-style live preview: syntax markers disappear unless the cursor is on them.
function build(view: EditorView, live: boolean): DecorationSet {
 const out: Range<Decoration>[] = [];
 // Source mode keeps every Markdown mark visible and only colours them.
 const cut = (a: number, b: number) => { if (live) out.push(hide.range(a, b)); };
 const { state } = view;
 const sel = state.selection.main;
 const touches = (from: number, to: number) => sel.from <= to && sel.to >= from;
 const lineTouched = (pos: number) => { const l = state.doc.lineAt(pos); return touches(l.from, l.to); };
 syntaxTree(state).iterate({
  enter: n => {
   const name = n.name;
   const h = /^ATXHeading([1-6])$/.exec(name);
   if (h) out.push(Decoration.line({ class: 'nf-h nf-h' + h[1] }).range(state.doc.lineAt(n.from).from));
   else if (name === 'HeaderMark') { if (!lineTouched(n.from)) cut(n.from, Math.min(n.to + 1, state.doc.lineAt(n.from).to)); }
   else if (name === 'StrongEmphasis') out.push(Decoration.mark({ class: 'nf-strong' }).range(n.from, n.to));
   else if (name === 'Emphasis') out.push(Decoration.mark({ class: 'nf-em' }).range(n.from, n.to));
   else if (name === 'Strikethrough') out.push(Decoration.mark({ class: 'nf-strike' }).range(n.from, n.to));
   else if (name === 'InlineCode') out.push(Decoration.mark({ class: 'nf-code' }).range(n.from, n.to));
   else if (name === 'EmphasisMark' || name === 'CodeMark' || name === 'StrikethroughMark') {
    const p = n.node.parent;
    if (p && p.name !== 'FencedCode' && !touches(p.from, p.to)) cut(n.from, n.to);
   }
   else if (name === 'FencedCode') {
    for (let l = state.doc.lineAt(n.from).number; l <= state.doc.lineAt(n.to).number; l++) out.push(Decoration.line({ class: 'nf-fence' }).range(state.doc.line(l).from));
   }
   else if (name === 'Blockquote') {
    for (let l = state.doc.lineAt(n.from).number; l <= state.doc.lineAt(n.to).number; l++) out.push(Decoration.line({ class: 'nf-quote' }).range(state.doc.line(l).from));
   }
   else if (name === 'QuoteMark') { if (!lineTouched(n.from)) cut(n.from, Math.min(n.to + 1, state.doc.lineAt(n.from).to)); }
   else if (name === 'ListMark') {
    const t = state.sliceDoc(n.from, n.to);
    // A checkbox replaces its bullet entirely.
    if (live && n.node.parent?.getChild('Task')) cut(n.from, Math.min(n.to + 1, state.doc.lineAt(n.from).to));
    else if (live && (t === '-' || t === '*' || t === '+') && !lineTouched(n.from)) out.push(bullet.range(n.from, n.to));
    else out.push(Decoration.mark({ class: 'nf-listmark' }).range(n.from, n.to));
   }
   else if (name === 'TaskMarker') {
    const done = /\[[xX]\]/.test(state.sliceDoc(n.from, n.to));
    if (live) out.push(Decoration.replace({ widget: new Check(done, n.from) }).range(n.from, n.to + (state.sliceDoc(n.to, n.to + 1) === ' ' ? 1 : 0)));
    else out.push(Decoration.mark({ class: 'nf-task' }).range(n.from, n.to));
   }
   else if (name === 'Task') { if (/^\[[xX]\]/.test(state.sliceDoc(n.from, n.from + 3))) out.push(Decoration.mark({ class: 'nf-task-done' }).range(n.from + 3, Math.max(n.from + 3, n.to))); }
   else if (name === 'Link') {
    // [label](url) shows just the label, as a link, until the cursor comes near.
    const marks = n.node.getChildren('LinkMark');
    const urlNode = n.node.getChild('URL');
    const url = urlNode ? state.sliceDoc(urlNode.from, urlNode.to) : '';
    const attrs: Record<string, string> = url ? { 'data-url': url, title: 'Ctrl+click to open' } : {};
    const open = marks[0], close = marks[1];
    if (live && open && close && marks.length >= 4 && !touches(n.from, n.to)) {
     cut(n.from, open.to);
     out.push(Decoration.mark({ class: 'nf-link', attributes: attrs }).range(open.to, close.from));
     cut(close.from, n.to);
    } else out.push(Decoration.mark({ class: 'nf-link', attributes: attrs }).range(n.from, n.to));
   }
   else if (name === 'HorizontalRule') out.push(Decoration.mark({ class: 'nf-hr' }).range(n.from, n.to));
  },
 });
 for (const { from, to } of view.visibleRanges) {
  const text = state.sliceDoc(from, to);
  for (const m of text.matchAll(/(!?)\[\[([^[\]\n]+?)\]\]/g)) {
   const embed = m[1] === '!';
   const a = from + m.index + (embed ? 1 : 0), b = from + m.index + m[0].length;
   if (embed && live && !(sel.to > a - 1 && sel.from < b)) { out.push(Decoration.replace({ widget: new Embed((m[2] ?? '').split('|')[0] ?? '') }).range(a - 1, b)); continue; }
   const active = touches(a, b);
   out.push(Decoration.mark({ class: 'nf-wikilink' }).range(a, b));
   if (!active) {
    cut(a, a + 2); cut(b - 2, b);
    const pipe = (m[2] ?? '').indexOf('|');
    if (pipe >= 0) cut(a + 2, a + 2 + pipe + 1);
   }
  }
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) out.push(Decoration.mark({ class: 'nf-link', attributes: { 'data-url': m[0], title: 'Ctrl+click to open' } }).range(from + m.index, from + m.index + m[0].length));
  for (const m of text.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) {
   const a = from + m.index + (m[1] ?? '').length;
   out.push(Decoration.mark({ class: 'nf-tag' }).range(a, a + (m[2] ?? '').length));
  }
 }
 return Decoration.set(out, true);
}
const previewPlugin = (live: boolean) => ViewPlugin.fromClass(class {
 decorations: DecorationSet;
 constructor(view: EditorView) { this.decorations = build(view, live); }
 update(u: ViewUpdate) { if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = build(u.view, live); }
}, { decorations: v => v.decorations });
export const livePreview = previewPlugin(true);
export const sourcePreview = previewPlugin(false);

/** Typing [[ closes itself to [[]] and suggests note names; picking one steps past the closing brackets. */
function wikilinks(notes: () => string[]) {
 const source = (context: CompletionContext) => {
  const match = context.matchBefore(/\[\[[^\][\n]*/);
  if (!match) return null;
  const query = match.text.slice(2).toLowerCase();
  const options = notes()
   .filter(n => n.toLowerCase().includes(query))
   .sort((a, b) => Number(b.toLowerCase().startsWith(query)) - Number(a.toLowerCase().startsWith(query)) || a.length - b.length)
   .slice(0, 30)
   .map(label => ({
    label,
    apply: (view: EditorView, _c: unknown, from: number, to: number) => {
     const closed = view.state.sliceDoc(to, to + 2) === ']]';
     view.dispatch({ changes: { from, to: closed ? to + 2 : to, insert: label + ']]' }, selection: { anchor: from + label.length + 2 } });
    },
   }));
  return { from: match.from + 2, options, filter: false, validFor: /^[^\][\n]*$/ };
 };
 return [
  closeBrackets(),
  keymap.of(closeBracketsKeymap),
  EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['['] } }]),
  autocompletion({ override: [source], icons: false, defaultKeymap: true }),
 ];
}

/** True when the position sits inside a [[link]], an ![[embed]] or a [text](url) on its line. */
function insideToken(view: EditorView, pos: number): boolean {
 const line = view.state.doc.lineAt(pos);
 for (const m of line.text.matchAll(/!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)/g)) {
  const from = line.from + m.index;
  if (pos > from && pos < from + m[0].length) return true;
 }
 return false;
}

/**
 * Puts a snippet (an embed or link) in the note on its own line, so PDFs and recordings show properly.
 * It never lands inside an existing link: if the position is inside one, the snippet goes after that line.
 */
export function insertSnippet(view: EditorView, snippet: string, at?: number) {
 let pos = at ?? view.state.selection.main.head;
 const line = view.state.doc.lineAt(pos);
 if (insideToken(view, pos)) pos = line.to;
 const lead = pos > view.state.doc.lineAt(pos).from ? '\n' : '';
 const insert = lead + snippet + '\n';
 view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
}

/**
 * Files: pasted, dropped or picked. onFile saves one file and returns the Markdown to insert, or null when the
 * caller inserts it later itself. A URL pasted over selected text becomes a link.
 */
export function fileHandling(onFile: (file: File) => Promise<string | null>) {
 const add = async (view: EditorView, files: File[], at: number | null) => {
  let pos = at;
  for (const f of files) {
   const snippet = await onFile(f);
   if (!snippet) continue;
   insertSnippet(view, snippet, pos ?? undefined);
   pos = null;
  }
 };
 const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
 const host = (view: EditorView) => view.dom.parentElement;
 return EditorView.domEventHandlers({
  paste(event, view) {
   const data = event.clipboardData;
   if (!data) return false;
   const text = data.getData('text/plain');
   const files = Array.from(data.files);
   if (files.length && !text.trim()) {
    event.preventDefault();
    void add(view, files, null);
    return true;
   }
   const url = text.trim();
   const sel = view.state.selection.main;
   if (/^https?:\/\/\S+$/i.test(url) && !sel.empty) {
    event.preventDefault();
    const label = view.state.sliceDoc(sel.from, sel.to);
    const insert = /^https?:\/\//i.test(label) ? url : `[${label}](${url})`;
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length } });
    return true;
   }
   return false;
  },
  dragenter(event, view) { if (hasFiles(event)) host(view)?.classList.add('nf-dragging'); return false; },
  dragover(event, view) {
   if (!hasFiles(event)) return false;
   event.preventDefault();
   host(view)?.classList.add('nf-dragging');
   return true;
  },
  dragleave(event, view) { if (!view.dom.contains(event.relatedTarget as Node | null)) host(view)?.classList.remove('nf-dragging'); return false; },
  drop(event, view) {
   host(view)?.classList.remove('nf-dragging');
   const files = Array.from(event.dataTransfer?.files ?? []);
   if (!files.length) return false;
   event.preventDefault();
   // A drop goes after the line it landed on, never into the middle of a sentence or a link.
   const hit = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
   void add(view, files, view.state.doc.lineAt(hit).to);
   return true;
  },
 });
}

/** Ctrl or Cmd plus click opens a rendered link. A plain click still just places the cursor. */
export function linkClicks(open: (url: string) => void) {
 return EditorView.domEventHandlers({
  click(event) {
   if (!(event.ctrlKey || event.metaKey)) return false;
   const url = (event.target as HTMLElement).closest('[data-url]')?.getAttribute('data-url');
   if (!url) return false;
   event.preventDefault();
   // Only web and mail links open; a link written as javascript: or file: does nothing.
   if (/^(https?:\/\/|mailto:)/i.test(url)) open(url);
   return true;
  },
 });
}

/** A name for a file that arrives without a useful one, such as a pasted screenshot. */
export function fileName(file: File): string {
 if (file.name && !/^(image|blob|unnamed|download)(\.\w+)?$/i.test(file.name)) return file.name;
 const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9].*/, '') || 'png';
 const d = new Date();
 const p = (n: number) => String(n).padStart(2, '0');
 return `Pasted image ${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

/** Markdown parsing, wikilink completion and the pieces both editors share. The preview mode is added separately. */
export const markdownBase = (notes: () => string[] = () => []) => [markdown({ extensions: GFM }), EditorView.lineWrapping, ...wikilinks(notes)];
