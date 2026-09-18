/**
 * Kapselt das <video>-Element: Wiedergabe, Geschwindigkeit, Bild-für-Bild,
 * In/Out-Punkte, Standbild-Erzeugung für die Notizen. Bild-für-Bild ist eine
 * Zeit-basierte Näherung (HTML5-Video kennt keine echte Frame-Zählung wie
 * AVFoundation) — angenommene Framerate 25fps.
 */

const ASSUMED_FPS = 25;
export const AVAILABLE_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export class Player {
  readonly video: HTMLVideoElement;
  inPoint: number | null = null;
  outPoint: number | null = null;
  private canvas = document.createElement('canvas');

  onTimeUpdate: (() => void) | null = null;
  onPlayStateChange: (() => void) | null = null;
  onDurationChange: (() => void) | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    video.addEventListener('timeupdate', () => this.onTimeUpdate?.());
    video.addEventListener('play', () => this.onPlayStateChange?.());
    video.addEventListener('pause', () => this.onPlayStateChange?.());
    video.addEventListener('loadedmetadata', () => this.onDurationChange?.());
  }

  get currentTime(): number { return this.video.currentTime; }
  get duration(): number { return isFinite(this.video.duration) ? this.video.duration : 0; }
  get isPlaying(): boolean { return !this.video.paused && !this.video.ended; }
  get hasVideo(): boolean { return !!this.video.src; }

  load(src: string) {
    this.video.src = src;
    this.inPoint = null;
    this.outPoint = null;
  }

  togglePlay() { this.isPlaying ? this.video.pause() : this.video.play(); }
  play() { this.video.play(); }
  pause() { this.video.pause(); }

  seek(seconds: number) {
    const clamped = Math.max(0, Math.min(seconds, this.duration || seconds));
    this.video.currentTime = clamped;
  }
  skip(seconds: number) { this.seek(this.currentTime + seconds); }
  stepFrames(count: number) {
    this.pause();
    this.seek(this.currentTime + count / ASSUMED_FPS);
  }

  setRate(rate: number) {
    this.video.playbackRate = rate;
  }

  /** L-Taste: abspielen bzw. Geschwindigkeit erhöhen (1 → 1,25 → 1,5 → 2 → 1 …) */
  playFasterCycle(): number {
    if (!this.isPlaying) {
      this.video.playbackRate = 1;
      this.play();
      return 1;
    }
    const cycle = [1, 1.25, 1.5, 2];
    const idx = cycle.findIndex((r) => Math.abs(r - this.video.playbackRate) < 0.01);
    const next = cycle[(idx + 1) % cycle.length];
    this.video.playbackRate = next;
    return next;
  }

  setInPoint() { this.inPoint = this.currentTime; this.normalizeRange(); }
  setOutPoint() { this.outPoint = this.currentTime; this.normalizeRange(); }
  clearInOut() { this.inPoint = null; this.outPoint = null; }
  private normalizeRange() {
    if (this.inPoint !== null && this.outPoint !== null && this.inPoint > this.outPoint) {
      [this.inPoint, this.outPoint] = [this.outPoint, this.inPoint];
    }
  }
  get selectedRange(): { start: number; end: number } | null {
    if (this.inPoint !== null && this.outPoint !== null && this.outPoint > this.inPoint) {
      return { start: this.inPoint, end: this.outPoint };
    }
    return null;
  }

  /** Zeichnet den aktuellen Frame auf ein Canvas und liefert ein PNG-data-URI. */
  captureFrame(maxWidth = 480): string {
    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 360;
    const scale = Math.min(1, maxWidth / vw);
    this.canvas.width = Math.round(vw * scale);
    this.canvas.height = Math.round(vh * scale);
    const ctx = this.canvas.getContext('2d')!;
    ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.toDataURL('image/png');
  }
}

export function formatTimecode(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}
