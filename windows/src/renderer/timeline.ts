import { Player } from './player';
import { Marker } from './markerPanel';

/** Zeitleiste mit Scrubbing, Marker-Punkten und In/Out-Bereich — Pendant zu
 * TimelineView.swift. */
export class Timeline {
  private el: HTMLElement;
  private fill: HTMLElement;
  private playhead: HTMLElement;
  private inout: HTMLElement;
  private markersLayer: HTMLElement;
  private player: Player;
  private getMarkers: () => Marker[];
  private onMarkerClick: (marker: Marker) => void;
  private dragging = false;

  constructor(
    el: HTMLElement,
    player: Player,
    getMarkers: () => Marker[],
    onMarkerClick: (marker: Marker) => void
  ) {
    this.el = el;
    this.fill = el.querySelector('#timeline-fill')!;
    this.playhead = el.querySelector('#timeline-playhead')!;
    this.inout = el.querySelector('#timeline-inout')!;
    this.markersLayer = el.querySelector('#timeline-markers')!;
    this.player = player;
    this.getMarkers = getMarkers;
    this.onMarkerClick = onMarkerClick;

    const seekFromEvent = (e: MouseEvent) => {
      const rect = this.el.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.player.seek(fraction * (this.player.duration || 0));
    };
    this.el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).classList.contains('marker-dot')) return;
      this.dragging = true;
      seekFromEvent(e);
    });
    window.addEventListener('mousemove', (e) => {
      if (this.dragging) seekFromEvent(e);
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
  }

  render() {
    const duration = this.player.duration || 0.001;
    const width = this.el.clientWidth;
    const frac = this.player.currentTime / duration;
    this.fill.style.width = `${frac * width}px`;
    this.playhead.style.left = `${frac * width - 1.5}px`;

    if (this.player.inPoint !== null) {
      const outVal = this.player.outPoint ?? duration;
      const x1 = (Math.min(this.player.inPoint, outVal) / duration) * width;
      const x2 = (Math.max(this.player.inPoint, outVal) / duration) * width;
      this.inout.style.display = 'block';
      this.inout.style.left = `${x1}px`;
      this.inout.style.width = `${Math.max(x2 - x1, 2)}px`;
    } else {
      this.inout.style.display = 'none';
    }

    this.markersLayer.innerHTML = '';
    for (const marker of this.getMarkers()) {
      const dot = document.createElement('div');
      dot.className = 'marker-dot';
      dot.style.left = `${(marker.time / duration) * width}px`;
      dot.style.background = marker.color;
      dot.title = marker.label || marker.time.toFixed(0);
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onMarkerClick(marker);
      });
      this.markersLayer.appendChild(dot);
    }
  }
}
