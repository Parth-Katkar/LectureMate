import { useMemo, useState } from "react";
import { Bookmark, Copy, Flag, HelpCircle, Lightbulb, Play, Trash2 } from "lucide-react";
import {
  MOMENT_KINDS, buildChapters, formatClock, momentsToMarkdown,
  type Moment, type MomentKind,
} from "./moments";

type Props = {
  videoTitle: string;
  currentSeconds: number;
  durationSeconds: number;
  segments: { seconds: number; text: string }[];
  moments: Moment[];
  onAdd: (seconds: number, kind: MomentKind, note: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<Moment, "note" | "kind">>) => void;
  onRemove: (id: string) => void;
  onSeek: (seconds: number) => void;
  onNotify: (message: string) => void;
};

const KIND_ICON = { key: Lightbulb, confusing: HelpCircle, review: Flag } as const;

export default function MomentsPanel({ videoTitle, currentSeconds, durationSeconds, segments, moments, onAdd, onUpdate, onRemove, onSeek, onNotify }: Props) {
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState<MomentKind | "all">("all");
  const chapters = useMemo(() => buildChapters(segments, durationSeconds), [segments, durationSeconds]);
  const activeChapter = chapters.find((c) => currentSeconds >= c.start && currentSeconds < c.end);
  const visible = filter === "all" ? moments : moments.filter((m) => m.kind === filter);
  const count = (k: MomentKind) => moments.filter((m) => m.kind === k).length;

  function add(kind: MomentKind) {
    onAdd(currentSeconds, kind, note);
    setNote("");
    onNotify(`Saved ${formatClock(currentSeconds)} as “${MOMENT_KINDS.find((x) => x.kind === kind)?.label}”`);
  }

  async function copyAll() {
    if (!moments.length) return;
    try {
      await navigator.clipboard.writeText(momentsToMarkdown(videoTitle, moments));
      onNotify("Moments copied as Markdown");
    } catch {
      onNotify("Copy is not available in this browser");
    }
  }

  return (
    <div className="notes-panel moments-panel">
      <div className="notes-title"><Bookmark size={17} /><strong>Lecture moments</strong></div>
      <p className="moments-intro">Mark important points while you watch. Press <kbd>B</kbd> anywhere to save the current time. Moments appear on the video timeline.</p>

      <div className="moments-capture">
        <div className="moments-capture-time">{formatClock(currentSeconds)}</div>
        <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add("key"); }} placeholder="Optional note for this moment" aria-label="Moment note" />
        <div className="moments-capture-actions">
          {MOMENT_KINDS.map(({ kind, label, hint }) => {
            const Icon = KIND_ICON[kind];
            return <button key={kind} className={`moment-add kind-${kind}`} onClick={() => add(kind)} title={hint}><Icon size={14} />{label}</button>;
          })}
        </div>
      </div>

      {chapters.length > 0 && <section className="moments-section">
        <h4>Auto chapters</h4>
        <div className="chapter-list">
          {chapters.map((c) => <button key={c.index} className={`chapter-row ${activeChapter?.index === c.index ? "current" : ""}`} onClick={() => onSeek(c.start)}>
            <span className="chapter-time">{formatClock(c.start)}</span>
            <span className="chapter-title">{c.title}</span>
            <Play size={11} fill="currentColor" />
          </button>)}
        </div>
      </section>}

      <section className="moments-section">
        <div className="moments-list-head">
          <h4>Saved moments <span>{moments.length}</span></h4>
          <button className="moments-copy" onClick={() => void copyAll()} disabled={!moments.length}><Copy size={13} /> Copy as Markdown</button>
        </div>
        <div className="moment-filters" role="group" aria-label="Filter moments">
          <button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>All {moments.length}</button>
          {MOMENT_KINDS.map(({ kind, label }) => <button key={kind} className={filter === kind ? "selected" : ""} onClick={() => setFilter(kind)}>{label} {count(kind)}</button>)}
        </div>
        {visible.length === 0 ? <p className="moments-empty">{moments.length ? "No moments in this category." : "No moments yet. Pause the video and mark something worth coming back to."}</p> : <ul className="moment-list">
          {visible.map((m) => {
            const Icon = KIND_ICON[m.kind];
            return <li key={m.id} className={`moment-item kind-${m.kind}`}>
              <button className="moment-jump" onClick={() => onSeek(m.seconds)} title="Jump to this moment"><Icon size={14} /><span>{formatClock(m.seconds)}</span></button>
              <input className="moment-note" value={m.note} onChange={(e) => onUpdate(m.id, { note: e.target.value })} placeholder="Add a note" aria-label={`Note at ${formatClock(m.seconds)}`} />
              <select className="moment-kind-select" value={m.kind} onChange={(e) => onUpdate(m.id, { kind: e.target.value as MomentKind })} aria-label="Moment type">
                {MOMENT_KINDS.map(({ kind, label }) => <option key={kind} value={kind}>{label}</option>)}
              </select>
              <button className="moment-remove" onClick={() => onRemove(m.id)} aria-label="Delete moment"><Trash2 size={14} /></button>
            </li>;
          })}
        </ul>}
      </section>
    </div>
  );
}
