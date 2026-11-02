import type { Template } from '../editor/template-utils';
export type { Template };

const make = (id: string, name: string, prefix: string, body: string, placeholder: string): Template => ({ id, name, prefix, body, placeholder, icon: '' });
export const THOUGHT = make('thought', 'Thought', 'Thought', '', 'An idea, observation or random realization…');
export const TASK = make('task', 'Task', 'Task', '- [ ] {{cursor}}', '');
export const BLANK = make('blank', '+', 'Note', '', 'Pure Markdown. Nothing else.');
export const LINK = make('link', 'Link', 'Link', '{{cursor}}\n\n', 'Paste a link, then add optional commentary below…');
export const QUOTE = make('quote', 'Quote', 'Quote', '> {{cursor}}\n\n— ', '');

/** What a fresh install ships with. */
export const DEFAULT_TEMPLATES: Template[] = [THOUGHT, TASK, BLANK];
/** Ready-made extras the template manager can add. */
export const PRESETS: Template[] = [LINK, QUOTE];

const ICONS: Record<string, string> = { thought: 'lightbulb', task: 'square-check', link: 'link', quote: 'quote', blank: 'plus' };
export const iconFor = (t: Pick<Template, 'id'>) => ICONS[t.id] ?? 'file-text';
/** File-name prefix: the template name, minus characters Obsidian cannot use in a file name. */
export const prefixFromName = (name: string) => name.replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'Note';
export const clone = (list: Template[]): Template[] => list.map(t => ({ ...t }));
