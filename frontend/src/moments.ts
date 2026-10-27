import { useCallback, useEffect, useState } from "react";

export type MomentKind = "key" | "confusing" | "review";
export type Moment = { id: string; seconds: number; kind: MomentKind; note: string; createdAt: string };
export type Chapter = { index: number; start: number; end: number; title: string };
type Segment = { seconds: number; text: string };

export const MOMENT_KINDS: { kind: MomentKind; label: string; hint: string }[] = [
  { kind: "key", label: "Key idea", hint: "Something worth remembering" },
  { kind: "confusing", label: "Confusing", hint: "Come back and clarify this" },
  { kind: "review", label: "Review later", hint: "Revisit before the exam" },
];

const storageKey = (videoId: number) => `lecturemate:moments:${videoId}`;

function readMoments(videoId: number | null): Moment[] {
  if (videoId === null) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(videoId)) || "[]");
    return Array.isArray(parsed) ? parsed.filter((m) => m && typeof m.seconds === "number") : [];
  } catch {
    return [];
  }
}

/** Per-lecture bookmarks, persisted in localStorage and kept sorted by time. */
export function useMoments(videoId: number | null) {
  const [moments, setMoments] = useState<Moment[]>(() => readMoments(videoId));

  useEffect(() => { setMoments(readMoments(videoId)); }, [videoId]);

  const persist = useCallback((next: Moment[]) => {
    setMoments(next);
    if (videoId === null) return;
    try { localStorage.setItem(storageKey(videoId), JSON.stringify(next)); } catch { /* storage is optional */ }
  }, [videoId]);

  const addMoment = useCallback((seconds: number, kind: MomentKind = "key", note = "") => {
    const rounded = Math.max(0, Math.floor(seconds));
    const entry: Moment = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, seconds: rounded, kind, note: note.trim(), createdAt: new Date().toISOString() };
    persist([...moments, entry].sort((a, b) => a.seconds - b.seconds));
    return entry;
  }, [moments, persist]);

  const updateMoment = useCallback((id: string, patch: Partial<Pick<Moment, "note" | "kind">>) => {
    persist(moments.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, [moments, persist]);

  const removeMoment = useCallback((id: string) => persist(moments.filter((m) => m.id !== id)), [moments, persist]);

  return { moments, addMoment, updateMoment, removeMoment };
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const STOP_WORDS = new Set((
  "a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just let like me more most my no nor not now of off on once only or other our out over own really same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who why will with would you your going gonna kind know okay right yeah thing things lot get got one two see look want need say said make just actually basically"
).split(" "));

function topTerms(text: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []) {
    if (STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Splits a transcript into evenly timed chapters and names each by its most frequent terms. Fully offline. */
export function buildChapters(segments: Segment[], durationSeconds: number): Chapter[] {
  if (segments.length < 6) return [];
  const sorted = [...segments].sort((a, b) => a.seconds - b.seconds);
  const total = Math.max(durationSeconds, sorted[sorted.length - 1].seconds + 1);
  const count = Math.max(3, Math.min(8, Math.round(total / 300)));
  const size = total / count;
  const chapters: Chapter[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * size);
    const end = i === count - 1 ? Math.ceil(total) : Math.floor((i + 1) * size);
    const text = sorted.filter((s) => s.seconds >= start && s.seconds < end).map((s) => s.text).join(" ");
    const terms = topTerms(text, 3);
    if (!terms.length) continue;
    chapters.push({ index: chapters.length + 1, start, end, title: terms.map(titleCase).join(" · ") });
  }
  return chapters;
}

export function momentsToMarkdown(title: string, moments: Moment[]): string {
  const label = (k: MomentKind) => MOMENT_KINDS.find((x) => x.kind === k)?.label || k;
  const lines = [`# ${title || "Lecture"} — saved moments`, ""];
  for (const m of moments) lines.push(`- **${formatClock(m.seconds)}** · ${label(m.kind)}${m.note ? ` — ${m.note}` : ""}`);
  return lines.join("\n");
}
