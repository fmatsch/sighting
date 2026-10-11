import * as fs from 'fs';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel,
} from 'docx';
import { ProjectData } from './projectStore';

/** Liest Breite/Höhe direkt aus dem IHDR-Chunk eines PNG-Buffers. */
function pngDimensions(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
  return Buffer.from(base64, 'base64');
}

function formatTimecode(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

interface NoteBlock {
  time: number;
  kind: 'note' | 'transcript' | 'vision';
  text: string;
  images: string[]; // data-URIs
}

/** Zerlegt das TipTap-Dokument in Blöcke: jeder Timecode-Node beginnt einen
 * neuen Block, nachfolgender reiner Text/Bilder bis zum nächsten Timecode
 * gehören dazu — analog zu ExportService.noteBlocks in der Mac-Version. */
export function extractBlocks(doc: any): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let current: NoteBlock | null = null;

  const paragraphs: any[] = (doc?.content || []).filter((n: any) => n.type === 'paragraph');
  for (const para of paragraphs) {
    const content: any[] = para.content || [];
    const timecodeNode = content.find((n) => n.type === 'timecode');
    const images = content.filter((n) => n.type === 'image').map((n) => n.attrs.src);
    const text = content
      .filter((n) => n.type === 'text')
      .map((n) => n.text)
      .join('')
      .trim();

    if (timecodeNode) {
      if (current) blocks.push(current);
      current = {
        time: timecodeNode.attrs.time,
        kind: timecodeNode.attrs.kind || 'note',
        text,
        images,
      };
    } else if (current) {
      if (text) current.text = current.text ? `${current.text} ${text}` : text;
      current.images.push(...images);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function kindLabel(kind: NoteBlock['kind']): string {
  if (kind === 'transcript') return 'Transkript';
  if (kind === 'vision') return 'Bildbeschreibung (KI)';
  return 'Notiz';
}

export async function generateDocx(
  project: ProjectData,
  videoName: string,
  targetPath: string
): Promise<void> {
  const blocks = extractBlocks(project.notes);
  const children: Paragraph[] = [
    new Paragraph({ text: `Sichtungsnotizen – ${videoName}`, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({
      children: [new TextRun({ text: new Date().toLocaleString('de-AT'), size: 18, color: '666666' })],
    }),
    new Paragraph({ text: '' }),
  ];

  if (project.markers.length > 0) {
    children.push(new Paragraph({ text: 'Marker', heading: HeadingLevel.HEADING_2 }));
    for (const marker of project.markers) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${formatTimecode(marker.time)}  `, bold: true, font: 'Courier New' }),
            new TextRun(marker.label || ''),
          ],
        })
      );
    }
    children.push(new Paragraph({ text: '' }));
  }

  for (const block of blocks) {
    for (const image of block.images) {
      try {
        const buffer = dataUrlToBuffer(image);
        const { width, height } = pngDimensions(buffer);
        const targetWidth = 220;
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                data: buffer,
                transformation: { width: targetWidth, height: (height / width) * targetWidth },
                type: 'png',
              }),
            ],
          })
        );
      } catch {
        // Bild überspringen, falls unlesbar
      }
    }
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `[${kindLabel(block.kind)}] ${formatTimecode(block.time)}  `,
            bold: true,
            color: '1F6FEB',
            font: 'Courier New',
          }),
          new TextRun({ text: block.text, italics: block.kind === 'vision' }),
        ],
      })
    );
    children.push(new Paragraph({ text: '' }));
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(targetPath, buffer);
}

export function generateCsv(project: ProjectData, targetPath: string): void {
  const rows: { time: number; type: string; text: string }[] = [];
  for (const marker of project.markers) {
    rows.push({ time: marker.time, type: 'Marker', text: marker.label || '' });
  }
  for (const block of extractBlocks(project.notes)) {
    rows.push({ time: block.time, type: kindLabel(block.kind), text: block.text });
  }
  rows.sort((a, b) => a.time - b.time);

  let csv = '﻿Timecode;Sekunden;Typ;Text\n';
  for (const row of rows) {
    const escaped = row.text.replace(/"/g, '""').replace(/\n/g, ' ');
    csv += `${formatTimecode(row.time)};${Math.floor(row.time)};${row.type};"${escaped}"\n`;
  }
  fs.writeFileSync(targetPath, csv, 'utf-8');
}

/** Baut die HTML-Ansicht, aus der der Main-Prozess per `printToPDF` das PDF erzeugt. */
export function renderExportHtml(project: ProjectData, videoName: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = extractBlocks(project.notes);

  let markersHtml = '';
  if (project.markers.length > 0) {
    markersHtml =
      '<h2>Marker</h2>' +
      project.markers
        .map(
          (m) =>
            `<p><span class="tc">${formatTimecode(m.time)}</span> ${esc(m.label || '')}</p>`
        )
        .join('');
  }

  const blocksHtml = blocks
    .map((b) => {
      const imgs = b.images.map((src) => `<img src="${src}" class="shot">`).join('');
      const cls = b.kind === 'vision' ? 'block vision' : 'block';
      return `<div class="${cls}">${imgs}<p><span class="tc">[${kindLabel(b.kind)}] ${formatTimecode(
        b.time
      )}</span> ${esc(b.text)}</p></div>`;
    })
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, Arial, sans-serif; padding: 32px; color: #111; }
    h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 24px; }
    .tc { font-family: monospace; font-weight: bold; color: #1F6FEB; margin-right: 8px; }
    .block { margin-bottom: 14px; }
    .block.vision p { font-style: italic; color: #555; }
    .shot { width: 180px; display: block; margin-bottom: 4px; border-radius: 4px; }
    .date { color: #666; font-size: 11px; }
  </style></head><body>
    <h1>Sichtungsnotizen – ${esc(videoName)}</h1>
    <p class="date">${esc(new Date().toLocaleString('de-AT'))}</p>
    ${markersHtml}
    ${blocksHtml}
  </body></html>`;
}

// ---------- Premiere Pro (Final-Cut-XML + SRT) ----------

import { spawnSync } from 'child_process';
import * as path from 'path';
import { findExecutable } from './toolPaths';

const MARKER_TITLES: Record<string, string> = {
  yellow: 'Zitat',
  green: 'Gut',
  red: 'Problem',
  blue: 'B-Roll',
};

export interface PremiereVideoInfo {
  duration: number;
  width: number;
  height: number;
}

/** Liest Bildrate und Auflösung per `ffmpeg -i` (Ausgabe auf stderr). Ohne
 * ffmpeg bzw. bei unlesbarer Ausgabe greifen die Werte aus dem Renderer. */
function probeVideo(videoPath: string, fallback: PremiereVideoInfo): { fps: number; width: number; height: number } {
  let fps = 25;
  let width = fallback.width;
  let height = fallback.height;
  const ffmpeg = findExecutable('ffmpeg');
  if (ffmpeg) {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-i', videoPath], { encoding: 'utf-8' });
    const text = `${result.stderr || ''}`;
    const videoLine = text.split('\n').find((l) => /Stream #.*Video:/.test(l));
    if (videoLine) {
      const f = videoLine.match(/(\d+(?:\.\d+)?)\s*fps/);
      if (f && Math.round(parseFloat(f[1])) > 0) fps = Math.round(parseFloat(f[1]));
      const d = videoLine.match(/,\s*(\d{2,5})x(\d{2,5})[\s,\[]/);
      if (d) {
        width = parseInt(d[1], 10);
        height = parseInt(d[2], 10);
      }
    }
  }
  return { fps, width: width || 1920, height: height || 1080 };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** file://localhost/C%3A/Pfad/zur/Datei.mp4 (Windows) bzw. file://localhost/Pfad (POSIX). */
function pathUrl(videoPath: string): string {
  const parts = videoPath.replace(/\\/g, '/').split('/').map(encodeURIComponent);
  const joined = parts.join('/');
  return 'file://localhost' + (joined.startsWith('/') ? joined : '/' + joined);
}

function srtTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(totalSeconds / 3600))}:${p(Math.floor(totalSeconds / 60) % 60)}:${p(totalSeconds % 60)},${p(ms, 3)}`;
}

export function buildSrt(blocks: { time: number; text: string }[], maxEnd: number): string {
  if (blocks.length === 0) return '';
  const sorted = [...blocks].sort((a, b) => a.time - b.time);
  let out = '';
  sorted.forEach((block, index) => {
    const minEnd = block.time + 0.5;
    const end =
      index + 1 < sorted.length
        ? Math.max(minEnd, Math.min(sorted[index + 1].time, block.time + 8))
        : Math.max(minEnd, Math.min(block.time + 4, maxEnd));
    out += `${index + 1}\n${srtTimestamp(block.time)} --> ${srtTimestamp(end)}\n${block.text}\n\n`;
  });
  return out;
}

export function buildPremiereXml(
  videoPath: string,
  info: { fps: number; width: number; height: number; duration: number },
  markers: ProjectData['markers']
): string {
  const { fps, width, height } = info;
  const totalFrames = Math.max(1, Math.round(info.duration * fps));
  const fileName = xmlEscape(path.basename(videoPath));
  const name = xmlEscape(path.basename(videoPath).replace(/\.[^.]+$/, ''));
  const rate = `<rate>
              <timebase>${fps}</timebase>
              <ntsc>FALSE</ntsc>
            </rate>`;

  const markersXml = [...markers]
    .sort((a, b) => a.time - b.time)
    .map(
      (m) => `
      <marker>
        <name>${xmlEscape(MARKER_TITLES[m.colorName] || 'Marker')}</name>
        <comment>${xmlEscape(m.label || '')}</comment>
        <in>${Math.round(m.time * fps)}</in>
        <out>-1</out>
      </marker>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence>
    <name>${name}</name>
    <duration>${totalFrames}</duration>
    <rate>
      <timebase>${fps}</timebase>
      <ntsc>FALSE</ntsc>
    </rate>
    <media>
      <video>
        <track>
          <clipitem id="clipitem-1">
            <name>${fileName}</name>
            <duration>${totalFrames}</duration>
            ${rate}
            <start>0</start>
            <end>${totalFrames}</end>
            <in>0</in>
            <out>${totalFrames}</out>
            <file id="file-1">
              <name>${fileName}</name>
              <pathurl>${xmlEscape(pathUrl(videoPath))}</pathurl>
              ${rate}
              <duration>${totalFrames}</duration>
              <media>
                <video>
                  <samplecharacteristics>
                    <width>${width}</width>
                    <height>${height}</height>
                  </samplecharacteristics>
                </video>
                <audio>
                  <channelcount>2</channelcount>
                </audio>
              </media>
            </file>
          </clipitem>
        </track>
      </video>
      <audio>
        <track>
          <clipitem id="clipitem-2">
            <name>${fileName}</name>
            <duration>${totalFrames}</duration>
            ${rate}
            <start>0</start>
            <end>${totalFrames}</end>
            <in>0</in>
            <out>${totalFrames}</out>
            <file id="file-1"/>
          </clipitem>
        </track>
      </audio>
    </media>${markersXml}
  </sequence>
</xmeml>
`;
}

/** Schreibt `<name>.xml` (Video + Marker) und daneben `<name>.srt` (Transkript). */
export function generatePremiere(
  project: ProjectData,
  videoInfo: PremiereVideoInfo,
  xmlPath: string
): { xmlPath: string; srtPath: string } {
  if (!project.videoPath) throw new Error('Kein Video geladen.');
  const probed = probeVideo(project.videoPath, videoInfo);
  const xml = buildPremiereXml(project.videoPath, { ...probed, duration: videoInfo.duration }, project.markers);
  fs.writeFileSync(xmlPath, xml, 'utf-8');

  const srtPath = xmlPath.replace(/\.[^.\\/]+$/, '') + '.srt';
  const transcript = extractBlocks(project.notes).filter((b) => b.kind === 'transcript');
  fs.writeFileSync(srtPath, buildSrt(transcript, videoInfo.duration), 'utf-8');
  return { xmlPath, srtPath };
}
