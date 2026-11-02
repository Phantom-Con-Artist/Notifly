/** Voice notes: records the microphone and hands back the finished recording. */
export interface Recording { blob: Blob; ext: string }

// m4a first: Obsidian shows it with a compact audio player, where webm gets a video player.
const TYPES: [string, string][] = [['audio/mp4', 'm4a'], ['audio/ogg;codecs=opus', 'ogg'], ['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm']];
export const MAX_SECONDS = 30 * 60;

/** Says what went wrong in everyday words. */
export function micProblem(e: unknown): string {
 const name = (e as { name?: string } | null)?.name ?? '';
 if (name === 'NotAllowedError' || name === 'SecurityError') return 'Notifly can\'t use your microphone. Allow it in your computer\'s privacy settings and try again.';
 if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
 if (name === 'NotReadableError') return 'Your microphone is busy. Close whatever else is using it and try again.';
 return 'Voice notes aren\'t available here.';
}

export class Recorder {
 private recorder?: MediaRecorder;
 private stream?: MediaStream;
 private chunks: Blob[] = [];
 private timer = 0;
 private started = 0;
 private finish?: (r: Recording | null) => void;
 get active() { return !!this.recorder && this.recorder.state !== 'inactive'; }
 get seconds() { return Math.floor((Date.now() - this.started) / 1000); }
 /** Starts recording. Rejects with a browser error; pass it to micProblem. */
 async start(onTick: (seconds: number) => void, onLimit: () => void) {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('unsupported');
  this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = TYPES.find(([t]) => MediaRecorder.isTypeSupported(t));
  this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type[0] } : undefined);
  const ext = type?.[1] ?? 'webm';
  this.chunks = [];
  this.recorder.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
  this.recorder.onstop = () => {
   const ok = this.chunks.length > 0;
   this.release();
   this.finish?.(ok ? { blob: new Blob(this.chunks, { type: this.recorder?.mimeType || 'audio/webm' }), ext } : null);
  };
  this.recorder.start(1000);
  this.started = Date.now();
  onTick(0);
  this.timer = window.setInterval(() => { const s = this.seconds; onTick(s); if (s >= MAX_SECONDS) onLimit(); }, 500);
 }
 /** Stops and returns the recording, or null if nothing was captured. */
 stop(): Promise<Recording | null> {
  return new Promise(resolve => {
   if (!this.active) { resolve(null); return; }
   this.finish = resolve;
   this.recorder?.stop();
  });
 }
 /** Stops and throws the recording away. */
 cancel() {
  if (!this.active) { this.release(); return; }
  this.finish = () => {};
  this.recorder?.stop();
 }
 private release() {
  window.clearInterval(this.timer);
  this.stream?.getTracks().forEach(t => t.stop());
  this.stream = undefined;
 }
}

/** "Voice note 2026-11-02 23.15.04.webm" */
export function voiceName(ext: string, now = new Date()): string {
 const p = (n: number) => String(n).padStart(2, '0');
 return `Voice note ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}.${ext}`;
}
