/** What a search box can say: plain words, #tags, cat:Category, file:report and type:pdf. */
export interface Query { words: string[]; tags: string[]; cats: string[]; files: string[]; types: string[] }
export interface Searchable { title: string; body: string; category: string; categoryId: string; tags: string[]; files: string[] }

const FILE_KEYS: Record<string, keyof Query> = { cat: 'cats', category: 'cats', file: 'files', files: 'files', attachment: 'files', type: 'types' };

/** Splits the box text into its parts. Quotes keep spaces together: cat:"Lab meetings". */
export function parseQuery(text: string): Query {
 const q: Query = { words: [], tags: [], cats: [], files: [], types: [] };
 for (const m of text.matchAll(/([A-Za-z]+):"([^"]*)"|([A-Za-z]+):(\S*)|"([^"]+)"|(\S+)/g)) {
  const key = (m[1] ?? m[3] ?? '').toLowerCase();
  const value = (m[2] ?? m[4] ?? '').trim().toLowerCase();
  const slot = FILE_KEYS[key];
  if (slot && (m[1] !== undefined || m[3] !== undefined)) { if (value) q[slot].push(value); continue; }
  const word = (m[5] ?? m[6] ?? m[0]).trim().toLowerCase();
  if (!word) continue;
  if (word.startsWith('#') && word.length > 1) q.tags.push(word);
  else q.words.push(word);
 }
 return q;
}

const KINDS: Record<string, string[]> = {
 pdf: ['pdf'],
 image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'],
 audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac', '3gp'],
 video: ['mp4', 'mkv', 'mov', 'ogv', 'webm'],
};
const ALIASES: Record<string, string> = { images: 'image', picture: 'image', pictures: 'image', photo: 'image', photos: 'image', voice: 'audio', sound: 'audio', recording: 'audio', recordings: 'audio', pdfs: 'pdf', videos: 'video' };

/** pdf, image, audio, video or file. A Notifly voice note saved as .webm counts as audio. */
export function fileKind(name: string): string {
 const ext = (name.split('.').pop() ?? '').toLowerCase();
 if (ext === 'webm' && /^voice note/i.test(name)) return 'audio';
 for (const [kind, exts] of Object.entries(KINDS)) if (exts.includes(ext)) return kind;
 return 'file';
}

/** Names of the files a note holds: every [[wikilink]] or ![[embed]] whose target is not a note. */
export function attachmentsOf(body: string): string[] {
 const names = new Set<string>();
 for (const m of body.matchAll(/!?\[\[([^\]|#\n]+?)(?:[|#][^\]\n]*)?\]\]/g)) {
  const target = (m[1] ?? '').trim();
  const base = target.split('/').pop() ?? target;
  if (/\.[A-Za-z0-9]{1,6}$/.test(base) && !/\.md$/i.test(base)) names.add(base);
 }
 return [...names];
}

/** True when the note satisfies every part of the query. */
export function matches(q: Query, e: Searchable): boolean {
 const tags = e.tags.map(t => t.toLowerCase());
 if (!q.tags.every(t => tags.some(x => x === t || x.startsWith(t + '/')))) return false;
 const cat = e.category.toLowerCase();
 if (!q.cats.every(c => cat.includes(c) || e.categoryId.toLowerCase() === c)) return false;
 const files = e.files.map(f => f.toLowerCase());
 if (!q.files.every(f => files.some(x => x.includes(f)))) return false;
 if (!q.types.every(t => { const kind = ALIASES[t] ?? t; return files.some(f => kind === 'file' || kind === 'any' || fileKind(f) === kind); })) return false;
 if (!q.words.length) return true;
 const hay = [e.title, e.body, e.category, ...e.tags, ...e.files].join('\n').toLowerCase();
 return q.words.every(w => hay.includes(w));
}
