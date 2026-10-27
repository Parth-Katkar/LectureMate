import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Copy, Loader2, Search, Sparkles, X } from "lucide-react";
import { formatClock } from "./moments";

const API_BASE = "http://127.0.0.1:8000";
const RECENT_KEY = "lecturemate:librarySearches";

type Hit = { video_id: number; video_title: string; seconds: number; text: string; context: string; score: number };
type Coverage = { video_id: number; title: string; matches: number };
type SearchResponse = {
  query: string; method: string; results: Hit[]; coverage: Coverage[];
  searched_videos: number; videos_with_transcript: number; videos_missing_index: number;
};

type Props = {
  videoCount: number;
  onOpen: (videoId: number, seconds: number) => void;
  onNotify: (message: string) => void;
};

const SUGGESTIONS = ["key definitions", "worked example", "common mistakes", "exam tips"];

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function Highlight({ text, query }: { text: string; query: string }) {
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "gi");
  return <>{text.split(pattern).map((part, i) => i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>)}</>;
}

function loadRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string").slice(0, 5) : [];
  } catch { return []; }
}

export default function LibrarySearch({ videoCount, onOpen, onNotify }: Props) {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState("");
  const [lectureFilter, setLectureFilter] = useState<number | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const requestRef = useRef(0);

  useEffect(() => { setLectureFilter(null); }, [data]);

  async function runSearch(raw: string) {
    const text = raw.trim();
    if (text.length < 2) return;
    const requestId = ++requestRef.current;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/api/library/search`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: text, limit: 30 }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || "Search failed");
      if (requestId !== requestRef.current) return;
      setData(payload as SearchResponse);
      const next = [text, ...recent.filter((r) => r.toLowerCase() !== text.toLowerCase())].slice(0, 5);
      setRecent(next);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* optional */ }
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setData(null);
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      if (requestId === requestRef.current) setBusy(false);
    }
  }

  async function indexAll() {
    setIndexing(true);
    try {
      const response = await fetch(`${API_BASE}/api/library/index`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || "Indexing failed");
      if (payload.videos_failed?.length) onNotify(payload.videos_failed[0].detail || "Some lectures could not be indexed");
      else onNotify("Library indexed for smarter search");
      if (query.trim()) await runSearch(query);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Indexing failed");
    } finally {
      setIndexing(false);
    }
  }

  const grouped = useMemo(() => {
    if (!data) return [];
    const visible = lectureFilter === null ? data.results : data.results.filter((h) => h.video_id === lectureFilter);
    const map = new Map<number, { title: string; best: number; hits: Hit[] }>();
    for (const hit of visible) {
      const group = map.get(hit.video_id) || { title: hit.video_title, best: 0, hits: [] };
      group.best = Math.max(group.best, hit.score);
      group.hits.push(hit);
      map.set(hit.video_id, group);
    }
    return [...map.entries()]
      .map(([videoId, g]) => ({ videoId, ...g, hits: g.hits.sort((a, b) => a.seconds - b.seconds) }))
      .sort((a, b) => b.best - a.best);
  }, [data, lectureFilter]);

  async function copyList() {
    if (!data || !data.results.length) return;
    const lines = [`# Revision list: ${data.query}`, ""];
    for (const g of grouped) {
      lines.push(`## ${g.title}`);
      for (const h of g.hits) lines.push(`- **${formatClock(h.seconds)}** ${h.text}`);
      lines.push("");
    }
    try { await navigator.clipboard.writeText(lines.join("\n")); onNotify("Revision list copied as Markdown"); }
    catch { onNotify("Copy is not available in this browser"); }
  }

  const maxScore = data?.results.length ? Math.max(...data.results.map((h) => h.score)) : 1;

  return (
    <div className="lib-search">
      <p className="lib-search-intro">Find where any topic was explained across <strong>all {videoCount} of your lectures</strong>, then jump straight to that moment. Built for revision week.</p>

      <form className="lib-search-form" onSubmit={(e) => { e.preventDefault(); void runSearch(query); }} role="search">
        <Search size={17} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. backpropagation, normal forms, supply and demand" aria-label="Search all lectures" autoFocus />
        {query && <button type="button" className="lib-clear" onClick={() => { setQuery(""); setData(null); setError(""); }} aria-label="Clear search"><X size={15} /></button>}
        <button type="submit" className="primary-button small-primary" disabled={busy || query.trim().length < 2}>{busy ? <><Loader2 size={14} className="lib-spin" /> Searching</> : "Search"}</button>
      </form>

      {!data && !busy && !error && <div className="lib-hints">
        {recent.length > 0 && <div className="lib-hint-row"><span>Recent</span>{recent.map((r) => <button key={r} onClick={() => { setQuery(r); void runSearch(r); }}>{r}</button>)}</div>}
        <div className="lib-hint-row"><span>Try</span>{SUGGESTIONS.map((r) => <button key={r} onClick={() => { setQuery(r); void runSearch(r); }}>{r}</button>)}</div>
      </div>}

      {error && <p className="lib-error" role="alert">{error}</p>}

      {data && data.videos_missing_index > 0 && <div className="lib-banner">
        <Sparkles size={16} />
        <span>{data.videos_missing_index} of {data.videos_with_transcript} lectures use keyword matching only. Index them for meaning-based search.</span>
        <button className="outline-button" onClick={() => void indexAll()} disabled={indexing}>{indexing ? "Indexing…" : "Index library"}</button>
      </div>}

      {data && <>
        <div className="lib-summary">
          <span>{data.results.length === 0 ? "No matches" : <><strong>{data.results.length}</strong> passage{data.results.length === 1 ? "" : "s"} in <strong>{data.coverage.length}</strong> of {data.videos_with_transcript} lecture{data.videos_with_transcript === 1 ? "" : "s"}</>}</span>
          <span className="lib-method">{data.method === "hybrid_semantic_keyword" ? "Semantic + keyword" : "Keyword"}</span>
          <button className="moments-copy" onClick={() => void copyList()} disabled={!data.results.length}><Copy size={13} /> Copy as revision list</button>
        </div>

        {data.coverage.length > 1 && <div className="moment-filters" role="group" aria-label="Filter by lecture">
          <button className={lectureFilter === null ? "selected" : ""} onClick={() => setLectureFilter(null)}>All lectures</button>
          {data.coverage.map((c) => <button key={c.video_id} className={lectureFilter === c.video_id ? "selected" : ""} onClick={() => setLectureFilter(c.video_id)} title={c.title}>{c.title.length > 28 ? c.title.slice(0, 27) + "…" : c.title} · {c.matches}</button>)}
        </div>}

        {data.results.length === 0 && <p className="moments-empty">
          {data.videos_with_transcript === 0 ? "None of your lectures has a transcript yet. Open a lecture and let transcription finish first." : "Nothing matched. Try different wording or a broader topic."}
        </p>}

        <div className="lib-results">
          {grouped.map((g) => <section key={g.videoId} className="lib-group">
            <h3>{g.title || "Untitled lecture"} <span>{g.hits.length}</span></h3>
            {g.hits.map((hit) => <button key={`${hit.video_id}-${hit.seconds}`} className="lib-hit" onClick={() => onOpen(hit.video_id, hit.seconds)}>
              <span className="lib-hit-time">{formatClock(hit.seconds)}</span>
              <span className="lib-hit-body">
                <span className="lib-hit-text"><Highlight text={hit.text} query={data.query} /></span>
                {hit.context && <span className="lib-hit-context">{hit.context}</span>}
                <span className="lib-hit-meter" aria-hidden="true"><i style={{ width: `${Math.max(8, Math.round((hit.score / maxScore) * 100))}%` }} /></span>
              </span>
              <span className="lib-hit-open">Open <ArrowRight size={13} /></span>
            </button>)}
          </section>)}
        </div>
      </>}
    </div>
  );
}
