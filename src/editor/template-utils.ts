export interface Template { id: string; name: string; icon: string; body: string; placeholder: string; prefix: string }
/** Only the blank template has a character; the rest get a CSS dot, which no font can fail to render. */
export const glyph = (t: Template) => (t.id === 'blank' ? '+' : '');
/** A template's text and where the cursor goes ({{cursor}} marks it). */
export function expand(t: Template): { text: string; cursor: number } {
 const at = t.body.indexOf('{{cursor}}');
 const text = t.body.replace('{{cursor}}', '');
 return { text, cursor: at < 0 ? text.length : at };
}
/** True while the text is only a template's untouched scaffolding ("- [ ]", "> ", a lone dash). */
export const isBlank = (doc: string) => !doc.replace(/^(?:- \[[ x]\]|>|—|[-*+])[ \t]*$/gm, '').trim();
/** Drops the empty optional "— source" line a quote leaves behind. */
export const finalize = (doc: string) => doc.replace(/\n+—[ \t]*$/, '').trim();

const EMBEDDABLE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'webm', '3gp', 'mp4', 'mkv', 'mov', 'ogv', 'pdf']);
/** The Markdown that puts a file in a note: shown in place when Obsidian can show it, a plain link otherwise. */
export const snippetFor = (name: string) => (EMBEDDABLE.has((name.split('.').pop() ?? '').toLowerCase()) ? `![[${name}]]` : `[[${name}]]`);
