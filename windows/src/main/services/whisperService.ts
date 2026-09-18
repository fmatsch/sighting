import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { findExecutable } from './toolPaths';

/**
 * Lokale Transkription über whisper.cpp (whisper-cli), analog zur
 * macOS-Version: ffmpeg extrahiert das In/Out-Segment als 16-kHz-WAV,
 * whisper-cli transkribiert nach JSON. Optionales Add-on — ohne
 * installiertes whisper-cli/ffmpeg bleibt die App ansonsten unverändert.
 */

const MODEL_NAME = 'ggml-large-v3-turbo.bin';
const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin';

function modelPath(): string {
  return path.join(app.getPath('userData'), 'models', MODEL_NAME);
}

export interface WhisperStatus {
  whisperInstalled: boolean;
  ffmpegInstalled: boolean;
  modelExists: boolean;
  setupProblem: string | null;
}

export function getStatus(): WhisperStatus {
  const whisperInstalled = findExecutable('whisper-cli') !== null;
  const ffmpegInstalled = findExecutable('ffmpeg') !== null;
  const modelExists = fs.existsSync(modelPath());

  let setupProblem: string | null = null;
  if (!whisperInstalled) {
    setupProblem =
      'whisper-cli wurde nicht gefunden. Download der Windows-Release: ' +
      'https://github.com/ggml-org/whisper.cpp/releases (whisper-cli.exe in den PATH legen).';
  } else if (!ffmpegInstalled) {
    setupProblem = 'ffmpeg wurde nicht gefunden. Installation: winget install Gyan.FFmpeg';
  } else if (!modelExists) {
    setupProblem = 'Das Whisper-Modell (~1,6 GB) muss einmalig geladen werden.';
  }
  return { whisperInstalled, ffmpegInstalled, modelExists, setupProblem };
}

export function downloadModel(onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const dest = modelPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmpDest = dest + '.download';
    const file = fs.createWriteStream(tmpDest);

    const request = (url: string) => {
      https
        .get(url, (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            request(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`Download fehlgeschlagen (HTTP ${response.statusCode}).`));
            return;
          }
          const total = parseInt(response.headers['content-length'] || '0', 10);
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (total > 0) onProgress(received / total);
          });
          response.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              fs.renameSync(tmpDest, dest);
              resolve();
            });
          });
        })
        .on('error', (err) => {
          fs.unlink(tmpDest, () => {});
          reject(err);
        });
    };
    request(MODEL_URL);
  });
}

export interface WhisperSegment {
  start: number; // Sekunden, relativ zum Video
  text: string;
}

export function transcribe(
  videoPath: string,
  start: number,
  end: number,
  onProgress: (text: string) => void
): Promise<WhisperSegment[]> {
  return new Promise((resolve, reject) => {
    const ffmpeg = findExecutable('ffmpeg');
    const whisper = findExecutable('whisper-cli');
    if (!ffmpeg || !whisper) {
      reject(new Error('whisper-cli oder ffmpeg nicht gefunden.'));
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'sighting-whisper-'));
    const wavPath = path.join(tmpDir, 'segment.wav');
    const outBase = path.join(tmpDir, 'transcript');

    const cleanup = () => {
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    };

    onProgress('Extrahiere Audio …');
    const ff = spawn(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-ss',
      String(start),
      '-to',
      String(end),
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      wavPath,
    ]);
    let ffError = '';
    ff.stderr.on('data', (d) => (ffError += d.toString()));
    ff.on('close', (code) => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`ffmpeg-Fehler: ${ffError.slice(-400)}`));
        return;
      }

      onProgress('Transkribiere … 0 %');
      const wp = spawn(whisper, [
        '-m',
        modelPath(),
        '-f',
        wavPath,
        '-l',
        'auto',
        '-oj',
        '-of',
        outBase,
        '--print-progress',
      ]);
      let wpError = '';
      wp.stderr.on('data', (d) => {
        const text = d.toString();
        wpError += text;
        const match = text.match(/progress\s*=\s*(\d+)%/);
        if (match) onProgress(`Transkribiere … ${match[1]} %`);
      });
      wp.on('close', (wcode) => {
        if (wcode !== 0) {
          cleanup();
          reject(new Error(`Whisper-Fehler: ${wpError.slice(-400)}`));
          return;
        }
        try {
          const json = JSON.parse(fs.readFileSync(outBase + '.json', 'utf-8'));
          const entries: any[] = json.transcription || [];
          const segments: WhisperSegment[] = entries
            .map((entry) => {
              const text = (entry.text || '').trim();
              const fromMs = entry.offsets?.from;
              if (!text || typeof fromMs !== 'number') return null;
              return { start: start + fromMs / 1000, text };
            })
            .filter((s): s is WhisperSegment => s !== null);
          cleanup();
          resolve(segments);
        } catch (e) {
          cleanup();
          reject(new Error('Whisper-Ausgabe konnte nicht gelesen werden.'));
        }
      });
    });
  });
}
