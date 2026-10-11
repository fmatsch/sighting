import { spawn, ChildProcess } from 'child_process';
import { findExecutable } from './toolPaths';

/**
 * Schnitterkennung über den Szenen-Score von ffmpeg (select='gt(scene,x)'),
 * analog zur macOS-Version. Liefert Shots (Start/Ende in Sekunden).
 */

export interface Shot {
  start: number;
  end: number;
}

/** Kürzer als das darf ein Shot nicht sein (Blitze, Überblendungen, Artefakte). */
export const MIN_SHOT_LENGTH = 1.0;

let current: ChildProcess | null = null;
let cancelled = false;

export function cancelDetection() {
  cancelled = true;
  current?.kill();
}

export function shotsFromCuts(cuts: number[], start: number, end: number): Shot[] {
  const starts: number[] = [start];
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    if (cut - starts[starts.length - 1] >= MIN_SHOT_LENGTH && end - cut >= MIN_SHOT_LENGTH) {
      starts.push(cut);
    }
  }
  return starts.map((s, i) => ({ start: s, end: i + 1 < starts.length ? starts[i + 1] : end }));
}

export function detectShots(
  videoPath: string,
  start: number,
  end: number,
  threshold: number,
  onProgress: (fraction: number) => void
): Promise<Shot[]> {
  return new Promise((resolve, reject) => {
    const ffmpeg = findExecutable('ffmpeg');
    if (!ffmpeg) {
      reject(new Error('ffmpeg wurde nicht gefunden. Installation: winget install Gyan.FFmpeg'));
      return;
    }
    cancelled = false;
    const span = Math.max(end - start, 0.001);
    const cuts: number[] = [];
    let buffer = '';
    let tail = '';

    const handleLine = (line: string) => {
      const pts = line.match(/pts_time:([0-9.]+)/);
      if (pts) {
        cuts.push(start + parseFloat(pts[1]));
      } else {
        const t = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (t) {
          const seconds = parseInt(t[1], 10) * 3600 + parseInt(t[2], 10) * 60 + parseFloat(t[3]);
          onProgress(Math.min(1, seconds / span));
        }
      }
      tail = (tail + '\n' + line).slice(-400);
    };

    const child = spawn(ffmpeg, [
      '-hide_banner',
      '-nostdin',
      '-stats',
      '-an',
      '-sn',
      '-ss',
      String(start),
      '-to',
      String(end),
      '-i',
      videoPath,
      // Verkleinern macht die Analyse bei HD/UHD-Material deutlich schneller.
      '-vf',
      `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
      '-f',
      'null',
      '-',
    ]);
    current = child;

    child.stderr.on('data', (d: Buffer) => {
      buffer += d.toString();
      // ffmpeg trennt Statuszeilen mit \r, Filterausgaben mit \n.
      const pieces = buffer.split(/[\r\n]/);
      buffer = pieces.pop() || '';
      pieces.filter((p) => p).forEach(handleLine);
    });
    child.on('error', (err) => {
      current = null;
      reject(new Error(`ffmpeg konnte nicht gestartet werden: ${err.message}`));
    });
    child.on('close', (code) => {
      current = null;
      if (buffer) handleLine(buffer);
      if (cancelled) {
        resolve([]);
        return;
      }
      if (code !== 0) {
        reject(new Error(`Schnitterkennung fehlgeschlagen: ${tail.slice(-300)}`));
        return;
      }
      resolve(shotsFromCuts(cuts, start, end));
    });
  });
}
