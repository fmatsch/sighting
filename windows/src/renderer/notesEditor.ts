import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { formatTimecode } from './player';

/**
 * Custom Inline-Node für klickbare Timecodes (Ersatz für die
 * `sighting://seek?t=…`-Links der Mac-Version — hier reicht ein einfacher
 * Klick-Handler, da alles im selben Fenster läuft). `kind` unterscheidet
 * Notiz/Transkript/Bildbeschreibung für den Export.
 */
const TimecodeNode = Node.create<{ onSeek: (time: number) => void }>({
  name: 'timecode',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      time: { default: 0 },
      kind: { default: 'note' }, // 'note' | 'transcript' | 'vision'
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-timecode]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-timecode': node.attrs.time,
        'data-kind': node.attrs.kind,
        class: node.attrs.kind === 'vision' ? 'timecode-link vision-marker' : 'timecode-link',
      }),
      formatTimecode(node.attrs.time),
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const span = document.createElement('span');
      span.className =
        node.attrs.kind === 'vision' ? 'timecode-link vision-marker' : 'timecode-link';
      span.dataset.timecode = String(node.attrs.time);
      span.textContent = formatTimecode(node.attrs.time);
      span.addEventListener('click', (e) => {
        e.preventDefault();
        this.options.onSeek(node.attrs.time);
      });
      return { dom: span };
    };
  },
});

export interface NotesEditorOptions {
  element: HTMLElement;
  onSeek: (time: number) => void;
  onDirty: () => void;
  getCurrentTime: () => number;
  getScreenshotEnabled: () => boolean;
  captureFrame: () => string | null;
}

export class NotesEditor {
  editor: Editor;
  private pendingHeader = true;
  private opts: NotesEditorOptions;

  constructor(opts: NotesEditorOptions) {
    this.opts = opts;
    this.editor = new Editor({
      element: opts.element,
      extensions: [
        StarterKit.configure({
          heading: false,
          blockquote: false,
          bulletList: false,
          orderedList: false,
          codeBlock: false,
          horizontalRule: false,
        }),
        Image.configure({ HTMLAttributes: { class: 'note-shot' } }),
        TimecodeNode.configure({ onSeek: opts.onSeek }),
      ],
      content: '<p></p>',
      onTransaction: ({ transaction }) => {
        if (transaction.getMeta('sightingProgrammatic')) return;
        if (!transaction.docChanged) return;
        this.armIfBlankLine();
        this.maybeInsertHeader();
        this.opts.onDirty();
      },
    });
  }

  /** Setzt pendingHeader, wenn der aktuelle Absatz leer ist und davor
   * ebenfalls eine Leerzeile (oder der Dokumentanfang) liegt — spiegelt die
   * "zwei Enter" Trennregel der Mac-Version. */
  private armIfBlankLine() {
    if (this.pendingHeader) return;
    const { state } = this.editor;
    const { $from } = state.selection;
    if ($from.depth !== 1) return;
    if ($from.parent.content.size !== 0) return;
    const index = $from.index(0);
    if (index === 0) {
      this.pendingHeader = true;
      return;
    }
    const prevPara = state.doc.child(index - 1);
    if (prevPara.content.size === 0) this.pendingHeader = true;
  }

  private maybeInsertHeader() {
    if (!this.pendingHeader) return;
    const { state, view } = this.editor;
    const { $from } = state.selection;
    if ($from.depth !== 1) return;
    const para = $from.parent;
    if (para.childCount !== 1 || para.firstChild?.type.name !== 'text') return;

    this.pendingHeader = false;
    const time = this.opts.getCurrentTime();
    const imageDataUrl = this.opts.getScreenshotEnabled() ? this.opts.captureFrame() : null;

    const schema = state.schema;
    const paraStart = $from.start($from.depth);
    const nodes = [];
    if (imageDataUrl) nodes.push(schema.nodes.image.create({ src: imageDataUrl }));
    nodes.push(schema.nodes.timecode.create({ time, kind: 'note' }));
    nodes.push(schema.text('  '));
    const insertSize = nodes.reduce((sum, n) => sum + n.nodeSize, 0);

    const tr = state.tr.insert(paraStart, nodes);
    tr.setMeta('sightingProgrammatic', true);
    tr.setSelection(TextSelection.create(tr.doc, state.selection.from + insertSize));
    view.dispatch(tr);
  }

  /** Hängt einen fertigen Block (Transkript-Segment oder KI-Beschreibung)
   * ans Ende der Notizen an — analog zu appendTranscript in der Mac-Version. */
  appendBlock(kind: 'transcript' | 'vision', time: number, text: string, imageDataUrl?: string | null) {
    const { state, view } = this.editor;
    const schema = state.schema;
    const endPos = state.doc.content.size;

    const inline: any[] = [];
    if (imageDataUrl) inline.push(schema.nodes.image.create({ src: imageDataUrl }));
    inline.push(schema.nodes.timecode.create({ time, kind }));
    inline.push(schema.text('  ' + text));

    const paragraph = schema.nodes.paragraph.create(null, inline);
    const tr = state.tr.insert(endPos, [schema.nodes.paragraph.create(), paragraph, schema.nodes.paragraph.create()]);
    tr.setMeta('sightingProgrammatic', true);
    view.dispatch(tr);
    this.opts.onDirty();
    this.editor.view.dom.scrollTop = this.editor.view.dom.scrollHeight;
  }

  appendTranscriptHeader(rangeStart: number, rangeEnd: number) {
    const { state, view } = this.editor;
    const schema = state.schema;
    const endPos = state.doc.content.size;
    const heading = schema.nodes.paragraph.create(
      null,
      schema.text(`Transkript ${formatTimecode(rangeStart)}–${formatTimecode(rangeEnd)}`, [
        schema.marks.bold.create(),
      ])
    );
    const tr = state.tr.insert(endPos, [schema.nodes.paragraph.create(), heading]);
    tr.setMeta('sightingProgrammatic', true);
    view.dispatch(tr);
  }

  getJSON(): unknown {
    return this.editor.getJSON();
  }

  setJSON(doc: unknown) {
    this.pendingHeader = false;
    this.editor.commands.setContent(doc as any, { emitUpdate: false });
  }

  focus() {
    this.editor.commands.focus('end');
  }

  get isFocused(): boolean {
    return this.editor.isFocused;
  }
}
