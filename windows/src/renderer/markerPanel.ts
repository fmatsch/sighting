import { formatTimecode } from './player';

export interface Marker {
  id: string;
  time: number;
  colorName: string;
  label: string;
}

export const MARKER_PALETTE: { name: string; color: string; title: string }[] = [
  { name: 'yellow', color: '#f4c430', title: 'Zitat' },
  { name: 'green', color: '#34c759', title: 'Gut' },
  { name: 'red', color: '#ff3b30', title: 'Problem' },
  { name: 'blue', color: '#007aff', title: 'B-Roll' },
];

function colorFor(name: string): string {
  return MARKER_PALETTE.find((p) => p.name === name)?.color || '#f4c430';
}

/** Marker-Liste in der Sidebar — Pendant zu MarkerListPane in der Mac-Version. */
export class MarkerPanel {
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private onSeek: (time: number) => void;
  private onChange: () => void;

  constructor(listEl: HTMLElement, emptyEl: HTMLElement, onSeek: (time: number) => void, onChange: () => void) {
    this.listEl = listEl;
    this.emptyEl = emptyEl;
    this.onSeek = onSeek;
    this.onChange = onChange;
  }

  render(markers: Marker[], onDelete: (id: string) => void, onLabelChange: (id: string, label: string) => void, onColorChange: (id: string, colorName: string) => void) {
    this.emptyEl.style.display = markers.length === 0 ? 'block' : 'none';
    this.listEl.innerHTML = '';
    const sorted = [...markers].sort((a, b) => a.time - b.time);
    for (const marker of sorted) {
      const li = document.createElement('li');

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = colorFor(marker.colorName);
      dot.title = 'Farbe ändern';
      dot.style.cursor = 'pointer';
      dot.addEventListener('click', () => {
        const idx = MARKER_PALETTE.findIndex((p) => p.name === marker.colorName);
        const next = MARKER_PALETTE[(idx + 1) % MARKER_PALETTE.length];
        onColorChange(marker.id, next.name);
      });

      const tc = document.createElement('span');
      tc.className = 'tc';
      tc.textContent = formatTimecode(marker.time);
      tc.addEventListener('click', () => this.onSeek(marker.time));

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Beschreibung';
      input.value = marker.label;
      input.addEventListener('input', () => {
        onLabelChange(marker.id, input.value);
        this.onChange();
      });

      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '🗑';
      del.addEventListener('click', () => onDelete(marker.id));

      li.append(dot, tc, input, del);
      this.listEl.appendChild(li);
    }
  }
}
