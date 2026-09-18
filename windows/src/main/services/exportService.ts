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
