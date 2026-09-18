import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { findExecutable } from './toolPaths';

/**
 * Chromiums <video>-Element kann wie AVFoundation auf dem Mac keine
 * MXF-Container öffnen, obwohl es den enthaltenen Codec (z. B. XDCAM-
 * MPEG-2) durchaus dekodieren kann. Lösung: verlustfreies Umpacken
 * (Stream-Copy, kein Re-Encode) nach .mp4 via ffmpeg, bevor das Video
 * geladen wird — exakt wie in der Mac-Version.
 */

const NEEDS_REMUX = new Set(['.mxf']);

export interface PrepareResult {
  /** Pfad, der tatsächlich ans <video>-Element übergeben wird. */
  playablePath: string;
  /** Ursprünglicher Pfad — wird im Projekt gespeichert, nicht der Temp-Pfad. */
  sourcePath: string;
  wasRemuxed: boolean;
}

export function prepareVideo(sourcePath: string): Promise<PrepareResult> {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!NEEDS_REMUX.has(ext)) {
    return Promise.resolve({ playablePath: sourcePath, sourcePath, wasRemuxed: false });
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = findExecutable('ffmpeg');
    if (!ffmpeg) {
      reject(
        new Error(
          `Für ${ext.toUpperCase()}-Dateien wird ffmpeg benötigt. Installation: winget install Gyan.FFmpeg`
        )
      );
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'sighting-import-'));
    const outPath = path.join(
      tmpDir,
      path.basename(sourcePath, ext) + '.mp4'
    );
    const proc = spawn(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      sourcePath,
      '-c',
      'copy',
      outPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        resolve({ playablePath: outPath, sourcePath, wasRemuxed: true });
      } else {
        reject(new Error(`Die Datei „${path.basename(sourcePath)}“ konnte nicht gelesen werden.\n${stderr.slice(-300)}`));
      }
    });
  });
}
