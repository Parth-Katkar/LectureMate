import React, { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import "./learning-detective-visuals.css";
import "./folders.css";
import MomentsPanel from "./MomentsPanel";
import LibrarySearch from "./LibrarySearch";
import { useMoments, MOMENT_KINDS } from "./moments";
import { analyzeScreenshot, captureCurrentFrame, captureSharedScreenFrame } from "./services/visualAnalysis";
import {
  ArrowDownRight, ArrowRight, BookOpen, Bookmark, Check, ChevronDown,
  CircleHelp, Clock3, FileText, GraduationCap, Headphones, Layers3,
  Link2, ListVideo, MessageCircle, MoreHorizontal, PanelLeftClose,
  Pause, Play, Plus, Search, Send, Settings2, Sparkles, StickyNote, Upload,
  Video, WandSparkles, X, FileVideo, Trash2, LogOut,
  Folder, FolderOpen, FolderPlus, FolderMinus, Pencil, ChevronRight
} from "lucide-react";

type Tab = "Transcript" | "Notes" | "Quiz" | "Mind Map" | "Generate Notes" | "Flashcards" | "Learning Detective" | "Moments";
type Message = { role: "assistant" | "user"; text: string; time?: string; sources?: { seconds: number; text: string; source_type?: "transcript" | "visual"; video_id?: number | null; video_title?: string }[]; imageBase64?: string };
type AnswerMode = "quick" | "learn" | "exam" | "deep";
type SavedAnswer = { question: string; answer: string; videoTitle: string; savedAt: string };
type BackendVideo = { id: number; title: string; url: string; created_at: string };
type BackendFolder = { id: number; name: string; created_at: string; video_ids: number[] };
type FolderMenuState = { kind: "move"; videoId: number; top: number; left: number } | { kind: "add"; folderId: number; top: number; left: number } | null;
type BackendTranscriptSegment = { id: number; seconds: number; text: string };
type StudyArtifactKind = "full_notes" | "crisp_notes" | "mindmap" | "quiz" | "flashcards";
type MindMapNode = { label: string; children: MindMapNode[] };
type MindMapData = { title: string; children: MindMapNode[] };
type QuizQuestion = { question: string; options: string[]; correct_index: number; explanation: string; concept?: string; prerequisites?: string[] };
type QuizData = { title: string; questions: QuizQuestion[] };
type LearningConcept = { concept: string; attempts: number; correct: number; accuracy: number; status: "needs_focus" | "developing" | "on_track" };

// API versions may return accuracy as either 0..1 or 0..100. Normalize before display/math.
function learningAccuracy(value: number | null | undefined): number { if (!Number.isFinite(value)) return 0; const n = Number(value); return Math.max(0, Math.min(1, n > 1 ? n / 100 : n)); }
type LearningProfile = { video_id: number; concepts: LearningConcept[]; replayed_segments: { seconds: number; replay_events: number }[]; struggling_concepts: LearningConcept[]; prerequisite_edges?: { concept: string; prerequisite: string }[]; learning_signals?: { confusion_events: number; help_requests: number; replay_events: number; repeated_topics: { concept: string; count: number; event_type: string; seconds: number }[] } };
type LearningPathStep = { id: string; title: string; reason: string; seconds: number; concept: string; prompt: string; kind: "concept" | "replay" | "review" };
type QuizProgressSession = { session_id: string; video_id: number; video_title: string; kind: "quiz" | "prerequisite"; title: string; target_concept: string; total_questions: number; answered_questions: number; correct_answers: number; accuracy: number; created_at: string; updated_at: string };

type PrerequisiteGraph = { prerequisites: string[]; concepts: string[]; edges: { prerequisite: string; concept: string }[]; height: number };
function buildPrerequisiteGraph(profile: LearningProfile | null): PrerequisiteGraph {
  const rawEdges = profile?.prerequisite_edges || [];
  const edges = rawEdges.filter((edge) => edge.prerequisite && edge.concept && edge.prerequisite.toLowerCase() !== edge.concept.toLowerCase())
    .filter((edge, index, all) => all.findIndex((other) => other.prerequisite.toLowerCase() === edge.prerequisite.toLowerCase() && other.concept.toLowerCase() === edge.concept.toLowerCase()) === index)
    .slice(0, 16);
  const prerequisites = [...new Set(edges.map((edge) => edge.prerequisite))].slice(0, 8);
  const concepts = [...new Set(edges.map((edge) => edge.concept))].slice(0, 8);
  return { prerequisites, concepts, edges: edges.filter((edge) => prerequisites.includes(edge.prerequisite) && concepts.includes(edge.concept)), height: Math.max(180, Math.max(prerequisites.length, concepts.length, 1) * 58 + 34) };
}

type LearningProgressData = { quiz_sessions: QuizProgressSession[]; completed_steps: { video_id: number; video_title: string; step_id: string; title: string; concept: string; seconds: number; updated_at: string }[]; stats: { quiz_sessions: number; questions_answered: number; correct_answers: number; overall_accuracy: number; completed_review_steps: number } };

function buildLearningPath(profile: LearningProfile | null, segments: BackendTranscriptSegment[]): LearningPathStep[] {
  if (!profile) return [];
  const weak = [...(profile.struggling_concepts || [])].sort((a, b) => learningAccuracy(a.accuracy) - learningAccuracy(b.accuracy) || b.attempts - a.attempts);
  const developing = (profile.concepts || []).filter((item) => item.status === "developing").sort((a, b) => learningAccuracy(a.accuracy) - learningAccuracy(b.accuracy));
  const concepts = [...weak, ...developing.filter((item) => !weak.some((w) => w.concept === item.concept))].slice(0, 3);
  const steps: LearningPathStep[] = [];
  for (const item of concepts) {
    const terms = item.concept.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
    const matched = segments.map((segment) => ({ segment, score: terms.reduce((score, term) => score + (segment.text.toLowerCase().includes(term) ? 1 : 0), 0) })).filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score || a.segment.seconds - b.segment.seconds)[0]?.segment;
    const fallbackReplay = profile.replayed_segments?.[0]?.seconds ?? 0;
    steps.push({ id: `concept:${item.concept}`, title: `Review ${item.concept}`, reason: `${Math.round(learningAccuracy(item.accuracy) * 100)}% quiz accuracy across ${item.attempts} attempts${item.status === "needs_focus" ? " — highest priority" : " — reinforce next"}.`, seconds: matched?.seconds ?? fallbackReplay, concept: item.concept, prompt: `Explain "${item.concept}" from this lecture in simple steps, give one concrete example, then ask me one practice question.`, kind: "concept" });
  }
  const replay = profile.replayed_segments?.[0];
  if (replay && !steps.some((step) => step.seconds === replay.seconds)) {
    const segment = segments.reduce<BackendTranscriptSegment | null>((best, candidate) => !best || Math.abs(candidate.seconds - replay.seconds) < Math.abs(best.seconds - replay.seconds) ? candidate : best, null);
    const excerpt = segment?.text?.trim();
    steps.push({ id: `replay:${replay.seconds}`, title: "Revisit a replay hotspot", reason: `You returned to this section ${replay.replay_events} ${replay.replay_events === 1 ? "time" : "times"}. Rewatching can help, but replay alone does not prove confusion.`, seconds: replay.seconds, concept: excerpt?.slice(0, 100) || "this section", prompt: `Explain the lecture section around ${formatTime(replay.seconds)} in simpler terms and check my understanding.`, kind: "replay" });
  }
  if (steps.length === 0) {
    const first = segments[0];
    steps.push({ id: "review:first", title: "Start with a quick review", reason: "There is not enough quiz history to prioritize a specific gap yet. Review a key section, then complete a personalized quiz.", seconds: first?.seconds ?? 0, concept: "key lecture concepts", prompt: "Give me a concise review of the key concepts in this lecture, then ask three questions to check my understanding.", kind: "review" });
  }
  return steps.slice(0, 4);
}

type FlashcardData = { title: string; cards: { front: string; back: string }[] };
type StudyArtifactRecord = { kind: StudyArtifactKind; content: string; data: MindMapData | QuizData | FlashcardData | null; provider?: string; updated_at?: string };
type LLMProvider = "gemini" | "groq" | "ollama";
type LLMSettings = { provider: LLMProvider; gemini_model: string; groq_model: string; ollama_model: string; ollama_vision_model: string; ollama_base_url: string; gemini_api_key_configured: boolean; groq_api_key_configured: boolean };
type YouTubePlayer = {
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  destroy: () => void;
};
type YouTubeApi = {
  Player: new (element: HTMLElement, options: {
    videoId: string;
    playerVars?: Record<string, number | string>;
    events?: { onReady?: (event: { target: YouTubePlayer }) => void; onStateChange?: (event: { data: number }) => void };
  }) => YouTubePlayer;
};
declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}
const API_BASE = "http://127.0.0.1:8000";
function createLearningSessionId(): string {
  return `lm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
function authenticatedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localStorage.getItem("lecturemate:token") || "";
  return { ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

const transcript = [
  { time: "00:00", seconds: 0, text: "Today we're going to understand how neural networks learn from data." },
  { time: "00:18", seconds: 18, text: "Think of a neural network as a series of connected layers, each learning useful patterns." },
  { time: "00:42", seconds: 42, text: "Each connection has a weight. During training, the model adjusts these weights to reduce its errors." },
  { time: "01:06", seconds: 66, text: "The loss function measures how far the model's prediction is from the correct answer." },
  { time: "01:31", seconds: 91, text: "Backpropagation calculates how each weight contributed to the error, using the chain rule." },
  { time: "01:58", seconds: 118, text: "Gradient descent then updates the weights in the direction that reduces the loss." },
  { time: "02:26", seconds: 146, text: "A learning rate controls the size of each update. Too large can overshoot; too small can be slow." },
];

function parseSubtitleText(raw: string): { seconds: number; text: string }[] {
  const normalized = raw.replace(/\r/g, "").replace(/^\uFEFF/, "").trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n\s*\n/);
  const parsed: { seconds: number; text: string }[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const match = lines[timingIndex].match(/(\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3}/);
    if (!match) continue;
    const stamp = match[0].replace(",", ".");
    const pieces = stamp.split(":");
    let seconds = 0;
    if (pieces.length === 3) seconds = Number(pieces[0]) * 3600 + Number(pieces[1]) * 60 + Number(pieces[2]);
    else if (pieces.length === 2) seconds = Number(pieces[0]) * 60 + Number(pieces[1]);
    const text = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    if (text) parsed.push({ seconds: Math.floor(seconds), text });
  }
  return parsed.sort((a, b) => a.seconds - b.seconds);
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function secondsFromTime(value: string): number {
  const [minutes = "0", seconds = "0"] = value.split(":");
  return Math.max(0, Number(minutes) * 60 + Number(seconds));
}

function getYouTubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? null;
    if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host) || host.endsWith(".youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live", "v"].includes(parts[0] ?? "")) return parts[1] ?? null;
    }
  } catch { /* Invalid URLs are handled by the form. */ }
  return null;
}

const initialMessages: Message[] = [];


function MindMapBranch({ node }: { node: MindMapNode }) {
  return <li className="mindmap-node"><div className="mindmap-node-label">{node.label}</div>{node.children?.length > 0 && <ul>{node.children.map((child, index) => <MindMapBranch key={`${child.label}-${index}`} node={child} />)}</ul>}</li>;
}

function renderMathParts(line: string) {
  const pieces: { text: string; math: boolean; display: boolean }[] = [];
  const pattern = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+\$)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) pieces.push({ text: line.slice(last, index), math: false, display: false });
    const raw = match[0];
    const display = raw.startsWith("$$") || raw.startsWith("\\[");
    const content = raw.startsWith("$$") ? raw.slice(2, -2) : raw.startsWith("\\[") ? raw.slice(2, -2) : raw.startsWith("\\(") ? raw.slice(2, -2) : raw.slice(1, -1);
    pieces.push({ text: content, math: true, display });
    last = index + raw.length;
  }
  if (last < line.length || pieces.length === 0) pieces.push({ text: line.slice(last), math: false, display: false });
  return pieces;
}

function RichMessageText({ text }: { text: string }) {
  return <div className="rich-message-text">{text.split("\n").map((line, lineIndex) => {
    const trimmed = line.trim();
    const looksLikeStandaloneEquation = trimmed.length > 0 && trimmed.length < 140 && /(?:=|≈|≤|≥|\\times|\\cdot|\\sum|\\frac|→)/.test(trimmed) && (/^[A-Za-z0-9_(]/.test(trimmed) || trimmed.startsWith("\\") || trimmed.startsWith("$")) && !/[.!?]$/.test(trimmed);
    const parts = renderMathParts(line);
    if (parts.length === 1 && !parts[0].math && looksLikeStandaloneEquation) parts[0] = { text: trimmed, math: true, display: true };
    const hasDisplay = parts.some((part) => part.math && part.display);
    return <p className={hasDisplay ? "math-line math-line-display" : "math-line"} key={lineIndex}>{parts.map((part, partIndex) => part.math ? <span key={partIndex} className={part.display ? "math-display" : "math-inline"} dangerouslySetInnerHTML={{ __html: katex.renderToString(part.text, { displayMode: part.display, throwOnError: false, strict: "ignore" }) }} /> : <React.Fragment key={partIndex}>{part.text || " "}</React.Fragment>)}</p>;
  })}</div>;
}

function App() {
  const currentUser = (() => {
    try { return JSON.parse(localStorage.getItem("lecturemate:user") || "null") as { id?: number; email?: string } | null; }
    catch { return null; }
  })();
  const [activeNav, setActiveNav] = useState("My library");
  const [tab, setTab] = useState<Tab>("Transcript");
  const [query, setQuery] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [answerMode, setAnswerMode] = useState<AnswerMode>("quick");
  const [savedAnswers, setSavedAnswers] = useState<SavedAnswer[]>([]);
  const [showSavedAnswers, setShowSavedAnswers] = useState(false);
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [showTranscriptModal, setShowTranscriptModal] = useState(false);
  const [showLLMModal, setShowLLMModal] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [topicConfidenceExpanded, setTopicConfidenceExpanded] = useState(false);
  const [progressTrendExpanded, setProgressTrendExpanded] = useState(false);
  const [llmSettings, setLlmSettings] = useState<LLMSettings>({ provider: "ollama", gemini_model: "gemini-flash-latest", groq_model: "openai/gpt-oss-20b", ollama_model: "llama3", ollama_vision_model: "qwen2.5vl:3b", ollama_base_url: "http://127.0.0.1:11434", gemini_api_key_configured: false, groq_api_key_configured: false });
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [llmBusy, setLlmBusy] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [transcriptDraft, setTranscriptDraft] = useState("");
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  const [saved, setSaved] = useState(() => localStorage.getItem("lecturemate:saved") === "true");
  const [notes, setNotes] = useState(() => localStorage.getItem("lecturemate:notes") ?? "");
  const [backendVideos, setBackendVideos] = useState<BackendVideo[]>([]);
  // Folders group lectures so the tutor can answer across all of them.
  const [folders, setFolders] = useState<BackendFolder[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<number, boolean>>({});
  const [folderMenu, setFolderMenu] = useState<FolderMenuState>(null);
  const [useFolderContext, setUseFolderContext] = useState(true);
  const [targetFolderId, setTargetFolderId] = useState<number | null>(null);
  const [backendTranscript, setBackendTranscript] = useState<BackendTranscriptSegment[]>([]);
  const [activeVideoId, setActiveVideoId] = useState<number | null>(null);
  const [chatLoadedForVideo, setChatLoadedForVideo] = useState<number | null>(null);
  const [learningProfile, setLearningProfile] = useState<LearningProfile | null>(null);
  const [learningProfileBusy, setLearningProfileBusy] = useState(false);
  const [learningProfileError, setLearningProfileError] = useState("");
  const [quizMode, setQuizMode] = useState<"standard" | "personalized" | "prerequisite">("standard");
  const [diagnosticConcept, setDiagnosticConcept] = useState("");
  const [diagnosticTarget, setDiagnosticTarget] = useState("");
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticData, setDiagnosticData] = useState<QuizData | null>(null);
  const [diagnosticAnswers, setDiagnosticAnswers] = useState<Record<number, number>>({});
  const [diagnosticError, setDiagnosticError] = useState("");
  const [completedLearningSteps, setCompletedLearningSteps] = useState<Record<string, boolean>>({});
  const [learningProgress, setLearningProgress] = useState<LearningProgressData | null>(null);
  const [learningProgressBusy, setLearningProgressBusy] = useState(false);
  const [learningProgressError, setLearningProgressError] = useState("");
  const [quizSessionId, setQuizSessionId] = useState("");
  const [diagnosticSessionId, setDiagnosticSessionId] = useState("");
  const learningPath = useMemo(() => buildLearningPath(learningProfile, backendTranscript), [learningProfile, backendTranscript]);
  const lastReplayLoggedAtRef = useRef(0);

  // Load chat history from the authenticated backend for each selected video.
  // This survives logout, browser cleanup, and signing in on another device.
  useEffect(() => {
    let cancelled = false;
    if (activeVideoId === null) {
      setChatLoadedForVideo(null);
      return;
    }
    const videoId = activeVideoId;
    setChatLoadedForVideo(null);
    fetch(`${API_BASE}/api/videos/${videoId}/chat`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.detail || "Could not load saved chat");
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        const serverMessages = Array.isArray(payload?.messages) ? payload.messages : [];
        setMessages(serverMessages);
        setChatLoadedForVideo(videoId);
      })
      .catch((error) => {
        if (cancelled) return;
        setMessages([]);
        setChatLoadedForVideo(videoId);
        notify(error instanceof Error ? `Chat history could not load: ${error.message}` : "Chat history could not load");
      });
    return () => { cancelled = true; };
  }, [activeVideoId]);

  // Save after a short pause instead of sending a request for every streamed token.
  useEffect(() => {
    if (activeVideoId === null || chatLoadedForVideo !== activeVideoId) return;
    const videoId = activeVideoId;
    const timer = window.setTimeout(() => {
      fetch(`${API_BASE}/api/videos/${videoId}/chat`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      }).then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.detail || "Could not save chat history");
        }
        try { localStorage.setItem(`lecturemate:chat:${videoId}`, JSON.stringify(messages)); } catch { /* cache is optional */ }
      }).catch((error) => console.error("LectureMate chat save failed:", error));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [messages, activeVideoId, chatLoadedForVideo]);
  useEffect(() => {
    try { setSavedAnswers(activeVideoId === null ? [] : JSON.parse(localStorage.getItem(`lecturemate:savedAnswers:${activeVideoId}`) || "[]")); } catch { setSavedAnswers([]); }
    setShowSavedAnswers(false);
    setQuizAnswers({});
    setFlippedCards({});
  }, [activeVideoId]);
  const [backendOnline, setBackendOnline] = useState(false);
  const [apiBusy, setApiBusy] = useState(false);
  const [selectedTime, setSelectedTime] = useState("00:00");
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [seekSeconds, setSeekSeconds] = useState(0);
  const [seekVersion, setSeekVersion] = useState(0);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [autoTranscribeBusy, setAutoTranscribeBusy] = useState(false);
  const [transcriptProgress, setTranscriptProgress] = useState(0);
  const transcriptionControllerRef = useRef<AbortController | null>(null);
  const [transcriptStatus, setTranscriptStatus] = useState("");
  const [studyArtifact, setStudyArtifact] = useState("");
  const [studyArtifactKind, setStudyArtifactKind] = useState<StudyArtifactKind | null>(null);
  const [studyArtifactData, setStudyArtifactData] = useState<MindMapData | QuizData | FlashcardData | null>(null);
  const [studyArtifactBusy, setStudyArtifactBusy] = useState(false);
  const studyArtifactGenerationRef = useRef(0);
  const [noteMode, setNoteMode] = useState<"full" | "crisp">("full");
  const [quizQuestionCount, setQuizQuestionCount] = useState<5 | 10>(5);
  const [personalizedQuizEnabled, setPersonalizedQuizEnabled] = useState(false);
  const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});
  const [flippedCards, setFlippedCards] = useState<Record<number, boolean>>({});
  const [visualAnalysis, setVisualAnalysis] = useState("");
  const [visualBusy, setVisualBusy] = useState(false);
  const [attachVisualToChat, setAttachVisualToChat] = useState(false);
  const [visualTimestamp, setVisualTimestamp] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { moments, addMoment, updateMoment, removeMoment } = useMoments(activeVideoId);
  const [isPlaying, setIsPlaying] = useState(false);
  const [youtubeApiUnavailable, setYoutubeApiUnavailable] = useState(false);
  const youtubePlayerHostRef = useRef<HTMLDivElement>(null);
  const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
  // The YT.Player object exists immediately but its methods (seekTo, getCurrentTime, ...) only appear after onReady.
  const youtubeReadyRef = useRef(false);
  const seekSecondsRef = useRef(0);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    setCompletedLearningSteps({});
    setStudyArtifact("");
    setStudyArtifactKind(null);
    setStudyArtifactData(null);
    setQuizAnswers({});
    setFlippedCards({});
    studyArtifactGenerationRef.current += 1;
  }, [activeVideoId]);

  useEffect(() => {
    let cancelled = false;
    const generationAtStart = studyArtifactGenerationRef.current;
    if (activeVideoId === null) return () => { cancelled = true; };
    fetch(`${API_BASE}/api/videos/${activeVideoId}/study-artifacts`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Could not load saved study materials")))
      .then((payload: { artifacts?: Record<string, StudyArtifactRecord> }) => {
        if (cancelled || generationAtStart !== studyArtifactGenerationRef.current) return;
        // Restore the artifact belonging to the current study tab, if one exists.
        const preferred: StudyArtifactKind = tab === "Mind Map" ? "mindmap" : tab === "Quiz" ? "quiz" : tab === "Flashcards" ? "flashcards" : "full_notes";
        const artifact = payload.artifacts?.[preferred] || payload.artifacts?.crisp_notes || payload.artifacts?.full_notes || payload.artifacts?.mindmap || payload.artifacts?.quiz || payload.artifacts?.flashcards;
        if (artifact) { setStudyArtifactKind(artifact.kind); setStudyArtifact(artifact.content || ""); setStudyArtifactData(artifact.data ?? null); }
      }).catch(() => { /* Older backend versions simply have no artifact endpoint. */ });
    return () => { cancelled = true; };
  }, [activeVideoId, tab]);

  useEffect(() => {
    let cancelled = false;
    async function initialiseBackend() {
      try {
        const health = await fetch(`${API_BASE}/api/health`);
        if (!health.ok) throw new Error("Health check failed");
        const response = await fetch(`${API_BASE}/api/videos`);
        if (!response.ok) throw new Error("Could not load videos");
        const videos: BackendVideo[] = await response.json();
        const settingsResponse = await fetch(`${API_BASE}/api/llm/settings`);
        const settingsData: LLMSettings | null = settingsResponse.ok ? await settingsResponse.json() : null;
        const foldersResponse = await fetch(`${API_BASE}/api/folders`);
        const folderData: BackendFolder[] = foldersResponse.ok ? await foldersResponse.json() : [];
        if (!cancelled) {
          setBackendOnline(true);
          setBackendVideos(videos);
          setFolders(Array.isArray(folderData) ? folderData : []);
          if (settingsData) setLlmSettings(settingsData);
        }
      } catch {
        if (!cancelled) setBackendOnline(false);
      }
    }
    initialiseBackend();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadSelectedNotes() {
      if (activeVideoId === null) {
        setNotes(localStorage.getItem("lecturemate:notes") ?? "");
        return;
      }
      try {
        const response = await fetch(`${API_BASE}/api/videos/${activeVideoId}/notes`);
        if (!response.ok) throw new Error("Could not load notes");
        const data: { content: string } = await response.json();
        if (!cancelled) setNotes(data.content);
      } catch {
        if (!cancelled) notify("Could not load notes from the backend");
      }
    }
    loadSelectedNotes();
    return () => { cancelled = true; };
  }, [activeVideoId]);

  async function refreshLearningProfile(videoId: number | null = activeVideoId) {
    if (videoId === null) { setLearningProfile(null); setLearningProfileError(""); return; }
    setLearningProfileBusy(true);
    setLearningProfileError("");
    try {
      const response = await fetch(`${API_BASE}/api/videos/${videoId}/learning-profile`, { headers: authenticatedHeaders() });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || "Could not load learning insights.");
      setLearningProfile(payload as LearningProfile);
    } catch (error) {
      setLearningProfileError(error instanceof Error ? error.message : "Could not load learning insights.");
    } finally {
      setLearningProfileBusy(false);
    }
  }

  async function refreshLearningProgress() {
    setLearningProgressBusy(true);
    setLearningProgressError("");
    try {
      const response = await fetch(`${API_BASE}/api/learning-progress`, { headers: authenticatedHeaders() });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || "Could not load your learning progress.");
      const progress = payload as LearningProgressData;
      setLearningProgress(progress);
      const completedMap: Record<string, boolean> = {};
      for (const item of progress.completed_steps || []) completedMap[`${item.video_id}:${item.step_id}`] = true;
      setCompletedLearningSteps(completedMap);
    } catch (error) {
      setLearningProgressError(error instanceof Error ? error.message : "Could not load your learning progress.");
    } finally {
      setLearningProgressBusy(false);
    }
  }

  async function toggleLearningStep(step: LearningPathStep, completed: boolean) {
    if (activeVideoId === null) return;
    const videoId = activeVideoId;
    const key = `${videoId}:${step.id}`;
    try {
      const response = await fetch(`${API_BASE}/api/videos/${videoId}/learning-path/${encodeURIComponent(step.id)}`, {
        method: "PUT",
        headers: authenticatedHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ completed: !completed, title: step.title, concept: step.concept, seconds: step.seconds }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || "Could not save review progress.");
      setCompletedLearningSteps((old) => ({ ...old, [key]: !completed }));
      void refreshLearningProgress();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save review progress.");
    }
  }

  useEffect(() => { void refreshLearningProgress(); }, [activeVideoId]);

  async function recordLearningEvent(eventType: "replay" | "confusion" | "help_requested", seconds: number, concept = "", metadata: Record<string, unknown> = {}) {
    const videoId = activeVideoId;
    if (videoId === null) return;
    try {
      const response = await fetch(`${API_BASE}/api/videos/${videoId}/learning-events`, {
        method: "POST",
        headers: authenticatedHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ event_type: eventType, seconds: Math.max(0, Math.floor(seconds)), concept: concept.slice(0, 180), metadata }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401) window.dispatchEvent(new Event("lecturemate:auth-expired"));
        throw new Error(payload?.detail || "Could not save learning signal.");
      }
      if (tab === "Learning Detective") void refreshLearningProfile(videoId);
    } catch (error) {
      console.warn("LectureMate learning event was not saved:", error);
    }
  }

  useEffect(() => {
    setLearningProfile(null);
    setLearningProfileError("");
    if (activeVideoId === null) return;
    let cancelled = false;
    setLearningProfileBusy(true);
    fetch(`${API_BASE}/api/videos/${activeVideoId}/learning-profile`, { headers: authenticatedHeaders() })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.detail || "Could not load learning insights.");
        return payload as LearningProfile;
      })
      .then((payload) => { if (!cancelled) setLearningProfile(payload); })
      .catch((error) => { if (!cancelled) setLearningProfileError(error instanceof Error ? error.message : "Could not load learning insights."); })
      .finally(() => { if (!cancelled) setLearningProfileBusy(false); });
    return () => { cancelled = true; };
  }, [activeVideoId]);

  useEffect(() => {
    if (tab === "Learning Detective") void refreshLearningProfile();
  }, [tab, activeVideoId]);

  const activeBackendVideo = backendVideos.find((video) => video.id === activeVideoId);
  const activeFolder = activeVideoId === null ? null : folders.find((folder) => folder.video_ids.includes(activeVideoId)) ?? null;
  const folderVideoCount = activeFolder ? activeFolder.video_ids.filter((id) => backendVideos.some((video) => video.id === id)).length : 0;
  // Chat spans the whole folder only when there is more than one lecture and the learner has not switched it off.
  const folderChatActive = !!activeFolder && useFolderContext && folderVideoCount > 1;

  async function loadFolders() {
    try {
      const response = await fetch(`${API_BASE}/api/folders`);
      if (response.ok) setFolders(await response.json());
    } catch { /* folders are optional; the library still works without them */ }
  }

  async function folderRequest(path: string, init: RequestInit, failure: string): Promise<any> {
    const response = await fetch(`${API_BASE}${path}`, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.detail || failure);
    return payload;
  }

  async function createFolder(initialVideoId?: number): Promise<BackendFolder | null> {
    const name = window.prompt("Name this folder (for example “Physics 101”)", "");
    if (!name || !name.trim()) return null;
    try {
      const folder: BackendFolder = await folderRequest("/api/folders", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }),
      }, "Could not create the folder");
      if (initialVideoId !== undefined) {
        await folderRequest(`/api/folders/${folder.id}/videos/${initialVideoId}`, { method: "PUT" }, "Could not add the video");
      }
      await loadFolders();
      notify(initialVideoId !== undefined ? `Added to “${folder.name}”` : `Folder “${folder.name}” created`);
      return folder;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not create the folder");
      return null;
    }
  }

  async function renameFolder(folder: BackendFolder) {
    const name = window.prompt("Rename folder", folder.name);
    if (!name || !name.trim() || name.trim() === folder.name) return;
    try {
      await folderRequest(`/api/folders/${folder.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }),
      }, "Could not rename the folder");
      await loadFolders();
    } catch (error) { notify(error instanceof Error ? error.message : "Could not rename the folder"); }
  }

  async function deleteFolder(folder: BackendFolder) {
    const count = folder.video_ids.length;
    if (!window.confirm(`Delete the folder “${folder.name}”? Its ${count} video${count === 1 ? "" : "s"} will stay in your library, just not grouped.`)) return;
    try {
      await folderRequest(`/api/folders/${folder.id}`, { method: "DELETE" }, "Could not delete the folder");
      if (targetFolderId === folder.id) setTargetFolderId(null);
      await loadFolders();
      notify("Folder deleted. Your videos are still in the library.");
    } catch (error) { notify(error instanceof Error ? error.message : "Could not delete the folder"); }
  }

  async function addVideoToFolder(folderId: number, videoId: number, quiet = false) {
    try {
      await folderRequest(`/api/folders/${folderId}/videos/${videoId}`, { method: "PUT" }, "Could not add the video to the folder");
      await loadFolders();
      setCollapsedFolders((current) => ({ ...current, [folderId]: false }));
      if (!quiet) notify("Added to folder");
    } catch (error) { notify(error instanceof Error ? error.message : "Could not add the video to the folder"); }
  }

  async function removeVideoFromFolder(folderId: number, videoId: number) {
    try {
      await folderRequest(`/api/folders/${folderId}/videos/${videoId}`, { method: "DELETE" }, "Could not remove the video from the folder");
      await loadFolders();
      notify("Removed from folder. It is still in your library.");
    } catch (error) { notify(error instanceof Error ? error.message : "Could not remove the video from the folder"); }
  }

  function openFolderMenu(event: React.MouseEvent<HTMLElement>, menu: { kind: "move"; videoId: number } | { kind: "add"; folderId: number }) {
    const rect = event.currentTarget.getBoundingClientRect();
    setFolderMenu({ ...menu, top: Math.min(rect.bottom + 4, window.innerHeight - 280), left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)) } as FolderMenuState);
  }

  function addNewVideoToFolder(folder: BackendFolder) {
    setFolderMenu(null);
    startNewChat();
    setActiveNav("My library");
    setTargetFolderId(folder.id);
    notify(`Paste a link or upload a file. It will be added to “${folder.name}”.`);
  }
  const youtubeId = activeBackendVideo ? getYouTubeVideoId(activeBackendVideo.url) : null;
  const isUploadedFile = Boolean(activeBackendVideo?.url.includes("/media/"));

  function seekToSeconds(seconds: number) {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    if (activeVideoId !== null && safeSeconds < currentSeconds - 10 && Date.now() - lastReplayLoggedAtRef.current > 8000) {
      lastReplayLoggedAtRef.current = Date.now();
      const nearest = backendTranscript.reduce<BackendTranscriptSegment | null>((best, segment) => {
        if (!best) return segment;
        return Math.abs(segment.seconds - safeSeconds) < Math.abs(best.seconds - safeSeconds) ? segment : best;
      }, null);
      void recordLearningEvent("replay", safeSeconds, nearest?.text?.slice(0, 180) || "", { from_seconds: currentSeconds, to_seconds: safeSeconds });
    }
    setCurrentSeconds(safeSeconds);
    setSelectedTime(formatTime(safeSeconds));
    setSeekSeconds(safeSeconds);
    seekSecondsRef.current = safeSeconds;
    setSeekVersion((version) => version + 1);
  }

  function seekToTimestamp(time: string) {
    seekToSeconds(secondsFromTime(time));
  }

  useEffect(() => {
    if (!loaded || !youtubeId || !youtubePlayerHostRef.current) {
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      return;
    }
    let cancelled = false;
    let pollId: number | undefined;
    setYoutubeApiUnavailable(false);
    const fallbackTimer = window.setTimeout(() => {
      if (!window.YT?.Player) setYoutubeApiUnavailable(true);
    }, 8000);
    const mountPlayer = () => {
      const youtubeApi = window.YT;
      if (cancelled || !youtubeApi?.Player || !youtubePlayerHostRef.current) return;
      setYoutubeApiUnavailable(false);
      youtubeReadyRef.current = false;
      youtubePlayerRef.current?.destroy();
      // YT.Player REPLACES the element it is given with an iframe. Never hand it the
      // React-owned host div, or React later tries to remove a node that is no longer
      // in the DOM and the whole app unmounts (blank screen). Give it a throwaway child.
      const host = youtubePlayerHostRef.current;
      host.replaceChildren();
      const mountPoint = document.createElement("div");
      host.appendChild(mountPoint);
      youtubePlayerRef.current = new youtubeApi.Player(mountPoint, {
        videoId: youtubeId,
        playerVars: { autoplay: 0, controls: 1, rel: 0, playsinline: 1, enablejsapi: 1 },
        events: {
          onReady: (event) => {
            if (cancelled) return;
            youtubeReadyRef.current = true;
            const duration = Math.floor(event.target.getDuration() || 0);
            setDurationSeconds(duration);
            if (seekSecondsRef.current > 0) event.target.seekTo(seekSecondsRef.current, true);
            setIsPlaying(event.target.getPlayerState() === 1);
            pollId = window.setInterval(() => {
              if (cancelled || !youtubePlayerRef.current || !youtubeReadyRef.current) return;
              const now = Math.floor(youtubePlayerRef.current.getCurrentTime() || 0);
              setCurrentSeconds(now);
              setSelectedTime(formatTime(now));
              const updatedDuration = Math.floor(youtubePlayerRef.current.getDuration() || 0);
              if (updatedDuration > 0) setDurationSeconds(updatedDuration);
              setIsPlaying(youtubePlayerRef.current.getPlayerState() === 1);
            }, 500);
          },
          onStateChange: (event) => {
            if (!cancelled) setIsPlaying(event.data === 1);
          },
        },
      });
    };
    if (window.YT?.Player) {
      mountPlayer();
    } else {
      window.onYouTubeIframeAPIReady = mountPlayer;
      const existingScript = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
      if (!existingScript) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;
        script.onerror = () => { if (!cancelled) setYoutubeApiUnavailable(true); };
        document.head.appendChild(script);
      } else {
        existingScript.addEventListener("error", () => { if (!cancelled) setYoutubeApiUnavailable(true); }, { once: true });
      }
    }
    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
      if (pollId !== undefined) window.clearInterval(pollId);
      youtubeReadyRef.current = false;
      try { youtubePlayerRef.current?.destroy(); } catch { /* player already gone */ }
      youtubePlayerRef.current = null;
      // Clear whatever the player left inside our host; the host div itself stays React's.
      youtubePlayerHostRef.current?.replaceChildren();
    };
  }, [loaded, youtubeId]);

  useEffect(() => {
    if (seekVersion === 0) return;
    // If the player is still starting up, onReady applies seekSecondsRef instead.
    if (youtubePlayerRef.current && youtubeReadyRef.current) youtubePlayerRef.current.seekTo(seekSeconds, true);
    if (localVideoRef.current) localVideoRef.current.currentTime = seekSeconds;
  }, [seekVersion, seekSeconds]);

  function togglePlayback() {
    if (youtubePlayerRef.current) {
      if (!youtubeReadyRef.current) { notify("The video player is still loading"); return; }
      if (youtubePlayerRef.current.getPlayerState() === 1) youtubePlayerRef.current.pauseVideo();
      else youtubePlayerRef.current.playVideo();
      return;
    }
    const video = localVideoRef.current;
    if (video) {
      if (video.paused) void video.play().catch(() => notify("The browser could not start video playback"));
      else video.pause();
      return;
    }
    notify("Add a video to enable playback");
  }

  useEffect(() => {
    if (!autoTranscribeBusy) return;
    setTranscriptProgress(3);
    const progressTimer = window.setInterval(() => {
      setTranscriptProgress((current) => {
        // The transcription endpoint does not expose internal stage percentages,
        // so this is an estimated indicator that waits near completion for the backend.
        if (current >= 92) return current;
        const increment = current < 25 ? 4 : current < 60 ? 2 : 0.7;
        return Math.min(92, Math.round((current + increment) * 10) / 10);
      });
    }, 900);
    return () => window.clearInterval(progressTimer);
  }, [autoTranscribeBusy]);

  useEffect(() => {
    let cancelled = false;
    async function loadSelectedTranscript() {
      if (activeVideoId === null) {
        setBackendTranscript([]);
        return;
      }
      try {
        const response = await fetch(`${API_BASE}/api/videos/${activeVideoId}/transcript`);
        if (!response.ok) throw new Error("Could not load transcript");
        const segments: BackendTranscriptSegment[] = await response.json();
        if (!cancelled) setBackendTranscript(segments);
      } catch {
        if (!cancelled) setBackendTranscript([]);
      }
    }
    loadSelectedTranscript();
    return () => { cancelled = true; };
  }, [activeVideoId]);

  const activeTranscript = useMemo(() => activeVideoId === null ? transcript : backendTranscript.map((line) => ({
    ...line,
    time: `${String(Math.floor(line.seconds / 60)).padStart(2, "0")}:${String(line.seconds % 60).padStart(2, "0")}`,
  })), [activeVideoId, backendTranscript]);

  const filteredTranscript = useMemo(
    () => activeTranscript.filter((line) => line.text.toLowerCase().includes(searchTerm.toLowerCase())),
    [activeTranscript, searchTerm],
  );

  // Opens a library lecture and lands on a given moment without logging a "replay" learning event.
  function jumpWithoutLogging(seconds: number) {
    const safe = Math.max(0, Math.floor(seconds));
    setCurrentSeconds(safe);
    setSelectedTime(formatTime(safe));
    setSeekSeconds(safe);
    seekSecondsRef.current = safe;
    setSeekVersion((version) => version + 1);
  }

  function openVideoAt(videoId: number, seconds: number) {
    const video = backendVideos.find((item) => item.id === videoId);
    if (!video) { notify("That lecture is no longer in your library"); return; }
    setActiveNav("My library");
    setTab("Transcript");
    if (activeVideoId !== video.id || !loaded) {
      setVisualAnalysis(""); setAttachVisualToChat(false); setVisualTimestamp(0);
      setActiveVideoId(video.id); setBackendTranscript([]); setTranscriptStatus("");
      setLoaded(true); setVideoUrl(video.url);
      void processTranscriptAutomatically(video);
    }
    jumpWithoutLogging(seconds);
    // Players finish mounting a moment later; apply the jump again so it sticks.
    window.setTimeout(() => jumpWithoutLogging(seconds), 1500);
  }

  function saveMomentNow() {
    if (activeVideoId === null) { notify("Select a lecture first"); return; }
    addMoment(currentSeconds, "key");
    notify(`Moment saved at ${formatTime(currentSeconds)}`);
  }
  const saveMomentRef = useRef(saveMomentNow);
  saveMomentRef.current = saveMomentNow;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "b" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      event.preventDefault();
      saveMomentRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  async function deleteVideo(video: BackendVideo) {
    const confirmed = window.confirm(`Delete "${video.title}" from your library? This also removes its saved transcript, notes, study materials, and uploaded file (if applicable). This cannot be undone.`);
    if (!confirmed) return;
    try {
      const response = await fetch(`${API_BASE}/api/videos/${video.id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || "Could not delete this video");
      setBackendVideos((current) => current.filter((item) => item.id !== video.id));
      setFolders((current) => current.map((folder) => ({ ...folder, video_ids: folder.video_ids.filter((id) => id !== video.id) })));
      localStorage.removeItem(`lecturemate:chat:${video.id}`);
      localStorage.removeItem(`lecturemate:savedAnswers:${video.id}`);
      if (localStorage.getItem("lecturemate:activeVideoId") === String(video.id)) localStorage.removeItem("lecturemate:activeVideoId");
      if (activeVideoId === video.id) {
        transcriptionControllerRef.current?.abort();
        setActiveVideoId(null);
        setLoaded(false);
        setVideoUrl("");
        setBackendTranscript([]);
        setMessages([]);
        setSavedAnswers([]);
        setStudyArtifact("");
        setStudyArtifactKind(null);
        setStudyArtifactData(null);
        setTranscriptStatus("");
        setVisualAnalysis("");
        setAttachVisualToChat(false);
        setDurationSeconds(0);
        setCurrentSeconds(0);
        setSelectedTime("00:00");
      }
      notify("Video deleted");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not delete this video");
    }
  }

  function loadDemo() {
    notify("Demo lectures are disabled. Add or select a real lecture from your library.");
  }

  async function processTranscriptAutomatically(video: BackendVideo) {
    // Abort a previous lecture's request so its response cannot leave the UI stuck or overwrite this lecture.
    transcriptionControllerRef.current?.abort();
    const controller = new AbortController();
    transcriptionControllerRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), 5 * 60 * 1000);
    const isLocalUpload = video.url.includes("/media/");
    setTranscriptProgress(0);
    setAutoTranscribeBusy(true);
    setTranscriptStatus(isLocalUpload ? "Transcribing uploaded video with Whisper…" : "Checking YouTube captions first…");
    try {
      const existingResponse = await fetch(`${API_BASE}/api/videos/${video.id}/transcript`, { signal: controller.signal });
      if (existingResponse.ok) {
        const existingSegments: BackendTranscriptSegment[] = await existingResponse.json();
        if (existingSegments.length > 0) {
          if (activeVideoId === null || activeVideoId === video.id) setBackendTranscript(existingSegments);
          setTranscriptStatus(`Transcript ready · ${existingSegments.length} segments`);
          return;
        }
      }
      const response = await fetch(`${API_BASE}/api/videos/${video.id}/transcribe`, { method: "POST", signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Automatic Whisper transcription failed");
      const refreshed = await fetch(`${API_BASE}/api/videos/${video.id}/transcript`, { signal: controller.signal });
      if (!refreshed.ok) throw new Error("Transcript was created but could not be loaded");
      const segments: BackendTranscriptSegment[] = await refreshed.json();
      if (segments.length === 0) throw new Error("Transcription finished but returned no transcript segments. Check the backend terminal and retry.");
      setBackendTranscript(segments);
      setTab("Transcript");
      setTranscriptStatus(`Transcript ready · ${segments.length} segments`);
      if (data?.transcription_method === "youtube_captions" || data?.source === "youtube_captions") {
        notify(`Loaded YouTube captions · ${data.segments_saved ?? segments.length} segments`);
      } else if (isLocalUpload) {
        notify(`Whisper transcribed ${data.segments_saved ?? segments.length} segments`);
      } else {
        notify(`YouTube captions unavailable; Whisper transcribed ${data.segments_saved ?? segments.length} segments`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const message = "Transcription was cancelled or timed out. Retry, and check the backend terminal if it happens again.";
        setTranscriptStatus(message);
        if (transcriptionControllerRef.current === controller) notify(message);
      } else {
        const message = error instanceof Error ? error.message : "Automatic transcription failed";
        setTranscriptStatus(`Automatic transcript unavailable: ${message}`);
        notify(message);
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (transcriptionControllerRef.current === controller) {
        transcriptionControllerRef.current = null;
        setTranscriptProgress(100);
        setAutoTranscribeBusy(false);
      }
    }
  }

  function cancelTranscription() {
    transcriptionControllerRef.current?.abort();
    // Close the blocking overlay immediately; the request's finally block performs cleanup.
    setAutoTranscribeBusy(false);
    setTranscriptStatus("Transcription cancelled. You can retry from this lecture.");
  }

  async function handleLoadVideo() {
    const url = videoUrl.trim();
    if (!url) {
      notify("Paste a YouTube link or choose a video file");
      return;
    }
    if (!getYouTubeVideoId(url)) {
      notify("Please enter a valid YouTube video URL");
      return;
    }
    if (!backendOnline) {
      notify("Start the FastAPI backend, then try again");
      return;
    }
    setApiBusy(true);
    try {
      let title = "Imported video";
      try {
        const parsed = new URL(url);
        const videoId = parsed.searchParams.get("v") || parsed.pathname.split("/").filter(Boolean).pop();
        if (videoId) title = `Video ${videoId}`;
      } catch { /* The backend will return a validation error for an invalid URL. */ }
      const response = await fetch(`${API_BASE}/api/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, url }),
      });
      if (response.status === 409) {
        const existing = backendVideos.find((video) => video.url === url);
        if (existing) {
          setVisualAnalysis("");
          setAttachVisualToChat(false);
          setVisualTimestamp(0);
          setActiveVideoId(existing.id);
          setLoaded(true);
          setVideoUrl(existing.url);
          setMessages([]);
          notify("That video is already in your library");
          if (targetFolderId !== null) { void addVideoToFolder(targetFolderId, existing.id, true); setTargetFolderId(null); }
          void processTranscriptAutomatically(existing);
          return;
        }
        throw new Error("That video URL is already in your library. Refresh and select it from the sidebar.");
      }
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.detail || "Could not add this video");
      }
      const video: BackendVideo = await response.json();
      setBackendVideos((current) => [video, ...current.filter((item) => item.id !== video.id)]);
      if (targetFolderId !== null) { await addVideoToFolder(targetFolderId, video.id, true); setTargetFolderId(null); }
      setVisualAnalysis("");
      setAttachVisualToChat(false);
      setVisualTimestamp(0);
      setActiveVideoId(video.id);
      setBackendTranscript([]);
      setTranscriptStatus("");
      setLoaded(true);
      setCurrentSeconds(0);
      setSelectedTime("00:00");
      setDurationSeconds(0);
      setIsPlaying(false);
      setMessages([]);
      setShowSourceModal(false);
      notify("Video saved. Checking for a transcript automatically…");
      void processTranscriptAutomatically(video);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not connect to the backend");
    } finally {
      setApiBusy(false);
    }
  }

  async function handleVideoFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      notify("Choose a valid video file");
      event.target.value = "";
      return;
    }
    if (!backendOnline) {
      notify("Start the FastAPI backend before uploading a video");
      event.target.value = "";
      return;
    }
    setUploadBusy(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`${API_BASE}/api/videos/upload`, { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || "Video upload failed");
      const video: BackendVideo = data;
      setBackendVideos((current) => [video, ...current.filter((item) => item.id !== video.id)]);
      if (targetFolderId !== null) { await addVideoToFolder(targetFolderId, video.id, true); setTargetFolderId(null); }
      setVisualAnalysis("");
      setAttachVisualToChat(false);
      setVisualTimestamp(0);
      setActiveVideoId(video.id);
      setBackendTranscript([]);
      setTranscriptStatus("");
      setVideoUrl(video.url);
      setLoaded(true);
      setCurrentSeconds(0);
      setSelectedTime("00:00");
      setDurationSeconds(0);
      setIsPlaying(false);
      setMessages([]);
      notify("Video uploaded. Whisper transcription is starting automatically…");
      void processTranscriptAutomatically(video);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Video upload failed");
    } finally {
      setUploadBusy(false);
      event.target.value = "";
    }
  }

  function startNewChat() {
    setVisualAnalysis("");
    setAttachVisualToChat(false);
    setVisualTimestamp(0);
    setLoaded(false);
    setActiveVideoId(null);
    setVideoUrl("");
    setMessages([]);
    setCurrentSeconds(0);
    setSelectedTime("00:00");
    setDurationSeconds(0);
    setIsPlaying(false);
    setTab("Transcript");
    setSearchTerm("");
  }

  async function saveNotes() {
    if (activeVideoId === null) {
      localStorage.setItem("lecturemate:notes", notes);
      notify("Demo notes saved in this browser");
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/videos/${activeVideoId}/notes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: notes }),
      });
      if (!response.ok) throw new Error("Could not save notes");
      notify("Notes saved to the backend");
    } catch {
      notify("Could not save notes. Check that the backend is running.");
    }
  }

  async function saveLLMSettings() {
    setLlmBusy(true);
    try {
      const response = await fetch(`${API_BASE}/api/llm/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...llmSettings, gemini_api_key: geminiApiKey, groq_api_key: groqApiKey }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || "Could not save LLM settings");
      setLlmSettings(data);
      setGeminiApiKey("");
      setGroqApiKey("");
      notify("AI provider settings saved");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save AI settings");
    } finally { setLlmBusy(false); }
  }

  async function testLLMConnection() {
    setLlmBusy(true);
    try {
      // Save the current form first so the test uses the provider/model selected here.
      const saveResponse = await fetch(`${API_BASE}/api/llm/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...llmSettings, gemini_api_key: geminiApiKey, groq_api_key: groqApiKey }),
      });
      const saved = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(saved?.detail || "Could not save LLM settings");
      setLlmSettings(saved);
      setGeminiApiKey("");
      setGroqApiKey("");
      const response = await fetch(`${API_BASE}/api/llm/test`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || "AI provider test failed");
      notify(`${data.provider === "gemini" ? "Gemini" : data.provider === "groq" ? "Groq" : "Ollama"} connected successfully`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "AI provider test failed");
    } finally { setLlmBusy(false); }
  }

  function saveAnswer(question: string, answer: string) {
    if (activeVideoId === null || !answer.trim()) { notify("Select a lecture and wait for the complete answer first"); return; }
    const next = [{ question, answer, videoTitle: activeBackendVideo?.title ?? "Lecture", savedAt: new Date().toISOString() }, ...savedAnswers].slice(0, 100);
    setSavedAnswers(next);
    localStorage.setItem(`lecturemate:savedAnswers:${activeVideoId}`, JSON.stringify(next));
    notify("Answer saved to this lecture's chat");
  }

  async function sendMessage() {
    const text = chatInput.trim();
    if (!text || isAsking || autoTranscribeBusy) return;
    setChatInput("");
    setMessages((current) => [...current, { role: "user", text }]);
    const normalized = text.toLowerCase().replace(/[!?.,]+$/g, "").trim();
    const instantReplies: Record<string, string> = {
      "hi": "Hi! What are you learning today?", "hello": "Hello! How can I help?", "hey": "Hey! What can I help you with?",
      "hi there": "Hi! What are you learning today?", "hello there": "Hello! How can I help?", "good morning": "Good morning! Ready to learn something?",
      "good afternoon": "Good afternoon! What can I help you understand?", "good evening": "Good evening! What are we learning today?",
      "thanks": "You're welcome!", "thank you": "You're welcome!", "thanks a lot": "You're welcome!",
      "who are you": "I'm LectureMate, your AI study companion. I can explain lecture topics, answer questions, and help make revision notes and quizzes.",
      "what can you do": "I can explain lecture concepts, find relevant moments in a video, and help create notes, quizzes, and mind maps."
    };
    if (instantReplies[normalized]) { setMessages((current) => [...current, { role: "assistant", text: instantReplies[normalized] }]); return; }
    if (activeVideoId === null) { setMessages((current) => [...current, { role: "assistant", text: "Select a video from your library and import its transcript before asking questions. Please select a lecture with a transcript before asking questions." }]); return; }
    const requestVideoId = activeVideoId;
    const confusionSignal = /\b(i(?:'m| am) confused|don't understand|do not understand|still don't get|not clear|confusing|explain again|i am lost|i'm lost|struggling)\b/i.test(text);
    void recordLearningEvent(confusionSignal ? "confusion" : "help_requested", currentSeconds, text.slice(0, 180), { question: text.slice(0, 1000) });
    setIsAsking(true);
    setMessages((current) => [...current, { role: "assistant", text: "" }]);
    let streamedText = "";
    let metadata: any = {};
    try {
      const response = await fetch(`${API_BASE}/api/videos/${requestVideoId}/ask/stream`, {
        method: "POST", headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({ question: text, mode: answerMode, use_folder: useFolderContext, visual_context: attachVisualToChat ? visualAnalysis : null, visual_seconds: attachVisualToChat ? visualTimestamp : null }),
      });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error?.detail || "Question search failed"); }
      if (!response.body) throw new Error("Streaming response is unavailable in this browser.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const processSseBlock = (rawBlock: string) => {
        const block = rawBlock.replace(/\r/g, "");
        const eventName = block.match(/^event:\s*(\w+)/m)?.[1];
        const dataLines = [...block.matchAll(/^data:\s?(.*)$/gm)].map((match) => match[1]);
        if (!eventName || dataLines.length === 0) return;
        let payload: any;
        try { payload = JSON.parse(dataLines.join("\n")); } catch { return; }
        if (eventName === "error") throw new Error(payload.detail || "The model could not generate an answer.");
        if (eventName === "metadata") metadata = payload;
        if (eventName === "token") {
          streamedText += String(payload.text ?? "");
          setMessages((current) => { const copy = [...current]; const idx = copy.length - 1; if (idx >= 0 && copy[idx].role === "assistant") copy[idx] = { ...copy[idx], text: streamedText }; return copy; });
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) processSseBlock(block);
        if (done) break;
      }
      if (buffer.trim()) processSseBlock(buffer);
      const sources = Array.isArray(metadata.sources) ? metadata.sources : [];
      const firstSource = sources[0];
      setMessages((current) => { const copy = [...current]; const idx = copy.length - 1; if (idx >= 0 && copy[idx].role === "assistant") copy[idx] = { ...copy[idx], text: streamedText || "No answer was returned.", ...(firstSource ? { time: formatTime(firstSource.seconds) } : {}), ...(sources.length ? { sources } : {}) }; return copy; });
      if (attachVisualToChat) { setAttachVisualToChat(false); setVisualAnalysis(""); notify("Slide context used for this answer and cleared for future chats"); }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not search this transcript. Check that the backend is running.";
      setMessages((current) => { const copy = [...current]; const idx = copy.length - 1; if (idx >= 0 && copy[idx].role === "assistant" && !copy[idx].text) copy[idx] = { ...copy[idx], text: message }; else copy.push({ role: "assistant", text: message }); return copy; });
    } finally { setIsAsking(false); }
  }

  async function generatePrerequisiteDiagnostic(concept: string, regenerate = false) {
    if (activeVideoId === null) { notify("Select a saved lecture first"); return; }
    setDiagnosticConcept(concept);
    setDiagnosticSessionId(createLearningSessionId());
    setDiagnosticBusy(true);
    setDiagnosticError("");
    setDiagnosticData(null);
    setDiagnosticAnswers({});
    try {
      const response = await fetch(`${API_BASE}/api/videos/${activeVideoId}/study-artifact`, {
        method: "POST",
        headers: authenticatedHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ kind: "quiz", question_count: 5, adaptive: true, diagnostic_concept: concept, regenerate }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || "Could not generate the prerequisite check.");
      if (!payload?.data || !Array.isArray(payload.data.questions)) throw new Error("The model returned an invalid diagnostic quiz. Please try again.");
      setDiagnosticData(payload.data as QuizData);
    } catch (error) {
      setDiagnosticError(error instanceof Error ? error.message : "Could not generate the prerequisite check.");
    } finally { setDiagnosticBusy(false); }
  }

  async function recordDiagnosticAnswer(index: number, selectedIndex: number, question: QuizQuestion) {
    if (diagnosticAnswers[index] !== undefined || activeVideoId === null) return;
    setDiagnosticAnswers((old) => ({ ...old, [index]: selectedIndex }));
    try {
      const response = await fetch(`${API_BASE}/api/videos/${activeVideoId}/quiz-attempts`, {
        method: "POST",
        headers: authenticatedHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          session_id: diagnosticSessionId || createLearningSessionId(),
          session_kind: "prerequisite",
          session_title: `Prerequisite check: ${diagnosticConcept || "lecture foundations"}`,
          target_concept: diagnosticConcept,
          session_total_questions: diagnosticData?.questions.length || 5,
          attempts: [{
            question: question.question,
            concept: question.concept || diagnosticConcept || "Prerequisite diagnostic",
            prerequisites: question.prerequisites || [],
            selected_answer: question.options[selectedIndex] || "",
            correct_answer: question.options[question.correct_index] || "",
            is_correct: selectedIndex === question.correct_index,
          }],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || "Could not save diagnostic answer.");
      void refreshLearningProfile(activeVideoId);
      void refreshLearningProgress();
    } catch (error) {
      console.warn("LectureMate diagnostic answer was not saved:", error);
      notify("Your answer was shown, but the diagnostic result could not be saved.");
    }
  }

  async function recordQuizAnswer(index: number, selectedIndex: number, question: QuizQuestion) {
    if (quizAnswers[index] !== undefined || activeVideoId === null) return;
    setQuizAnswers((old) => ({ ...old, [index]: selectedIndex }));
    try {
      const response = await fetch(`${API_BASE}/api/videos/${activeVideoId}/quiz-attempts`, {
        method: "POST",
        headers: authenticatedHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          session_id: quizSessionId || createLearningSessionId(),
          session_kind: "quiz",
          session_title: (studyArtifactData && "title" in studyArtifactData ? studyArtifactData.title : "Lecture quiz").slice(0, 180),
          target_concept: personalizedQuizEnabled ? (learningProfile?.struggling_concepts?.[0]?.concept || "Personalized lecture review") : "",
          session_total_questions: studyArtifactData && "questions" in studyArtifactData ? studyArtifactData.questions.length : 0,
          attempts: [{
            question: question.question,
            concept: question.concept || question.question.slice(0, 180) || "General lecture concept",
            prerequisites: question.prerequisites || [],
            selected_answer: question.options[selectedIndex] || "",
            correct_answer: question.options[question.correct_index] || "",
            is_correct: selectedIndex === question.correct_index,
          }],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || "Could not save quiz attempt.");
      if (payload?.learning_profile) {
        // The backend profile covers this user's saved attempts; refresh the active lecture's profile for replay signals too.
        void refreshLearningProfile(activeVideoId);
        void refreshLearningProgress();
      }
    } catch (error) {
      console.warn("LectureMate quiz attempt was not saved:", error);
      notify("Your answer was shown, but the learning insight could not be saved.");
    }
  }

  async function buildSemanticIndex() {
    if (activeVideoId === null) return;
    setAutoTranscribeBusy(true);
    try {
      const response = await fetch(`${API_BASE}/api/videos/${activeVideoId}/index-embeddings`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || "Could not build the semantic search index");
      notify(`Semantic search ready for ${data.segments_indexed} transcript segments`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not build semantic index");
    } finally { setAutoTranscribeBusy(false); }
  }

  async function generateStudyArtifact(kind: StudyArtifactKind, questionCount: 5 | 10 = 5, regenerate = false) {
    if (activeVideoId === null) { notify("Select a saved video first"); return; }
    studyArtifactGenerationRef.current += 1;
    if (studyArtifactBusy) return;
    setStudyArtifactBusy(true);
    if (kind === "quiz") setQuizSessionId(createLearningSessionId());
    // Keep the currently visible artifact intact while a user-requested replacement is being built.
    // Quiz submission only records answers; it must never trigger quiz generation.
    try {
      const response = await fetch(`${API_BASE}/api/videos/${activeVideoId}/study-artifact`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          kind,
          question_count: questionCount,
          adaptive: kind === "quiz" && personalizedQuizEnabled,
          diagnostic_concept: kind === "quiz" && personalizedQuizEnabled
            ? (learningProfile?.struggling_concepts?.[0]?.concept || learningProfile?.learning_signals?.repeated_topics?.[0]?.concept || "the main concepts in this lecture")
            : "",
          regenerate,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || "Could not generate study material");
      setStudyArtifact(data.content || "No content was generated.");
      setStudyArtifactData(data.data ?? null);
      setStudyArtifactKind(kind);
      if (kind === "quiz") setQuizAnswers({});
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not generate study material";
      // Do not replace a usable quiz with an error string if regeneration fails.
      if (!studyArtifactData) setStudyArtifact(message);
      notify(message);
    } finally { setStudyArtifactBusy(false); }
  }

  async function downloadStudyArtifact(kind: StudyArtifactKind, content = studyArtifact) {
    if (!content.trim()) { notify("Generate the study material first"); return; }
    try {
      const response = await fetch(`${API_BASE}/api/study-artifacts/pdf`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: activeBackendVideo?.title || "LectureMate study material", kind, content: kind === "mindmap" && studyArtifactData && "children" in studyArtifactData ? JSON.stringify(studyArtifactData) : content }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.detail || "Could not create PDF");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(activeBackendVideo?.title || "lecturemate").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60)}_${kind}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Keep the object URL alive long enough for the browser to begin the download.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("PDF download started");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not download PDF");
    }
  }


  async function analyzeVisuals() {
    if (activeVideoId === null) { notify("Select a saved video first"); return; }
    // Pause first so the captured image and timestamp refer to the same frame.
    if (youtubePlayerRef.current && youtubeReadyRef.current) youtubePlayerRef.current.pauseVideo();
    if (localVideoRef.current) localVideoRef.current.pause();
    const seconds = Math.max(0, Math.floor(
      (youtubeReadyRef.current ? youtubePlayerRef.current?.getCurrentTime() : undefined) ?? localVideoRef.current?.currentTime ?? currentSeconds,
    ));
    setCurrentSeconds(seconds);
    setSelectedTime(formatTime(seconds));
    setVisualBusy(true);
    setAttachVisualToChat(false);
    setVisualAnalysis("");
    setVisualTimestamp(seconds);
    try {
      let screenshot = captureCurrentFrame(localVideoRef.current);
      // YouTube player pixels are cross-origin and cannot be read by canvas. Ask the
      // user to select the current tab/screen instead of trying yt-dlp/cookies.
      if (!screenshot && youtubePlayerRef.current) {
        notify("Select the tab showing this paused video in the browser capture prompt");
        screenshot = await captureSharedScreenFrame();
      }
      const data = await analyzeScreenshot(activeVideoId, seconds, screenshot);
      setVisualAnalysis(data.analysis || "No visual context was returned.");
      setVisualTimestamp(data.seconds ?? seconds);
      setAttachVisualToChat(true);
      notify(`Saved visual shot at ${data.timestamp}. ${data.visual_shots_saved} shot(s) are now indexed with the transcript.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not analyze the current screenshot";
      setVisualAnalysis("");
      setAttachVisualToChat(false);
      notify(message);
    } finally { setVisualBusy(false); }
  }

  async function importTranscript() {
    if (activeVideoId === null) { notify("Select a saved video first"); return; }
    const segments = parseSubtitleText(transcriptDraft);
    if (!segments.length) { notify("No subtitle cues found. Paste SRT or WebVTT text."); return; }
    setTranscriptBusy(true);
    try {
      const response = await fetch(`${API_BASE}/api/videos/${activeVideoId}/transcript`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || "Could not import transcript");
      const refreshed = await fetch(`${API_BASE}/api/videos/${activeVideoId}/transcript`);
      if (!refreshed.ok) throw new Error("Transcript was saved but could not be reloaded");
      setBackendTranscript(await refreshed.json());
      setTranscriptDraft("");
      setShowTranscriptModal(false);
      setTab("Transcript");
      setMessages([]);
      notify(`Imported ${data.segments_saved} transcript segments`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not import transcript");
    } finally { setTranscriptBusy(false); }
  }

  const folderedVideoIds = new Set(folders.flatMap((folder) => folder.video_ids));
  const unfiledVideos = backendVideos.filter((video) => !folderedVideoIds.has(video.id));
  const renderLibraryVideo = (video: BackendVideo, folder: BackendFolder | null) => (
    <div key={video.id} className={`library-video-row ${activeVideoId === video.id ? "selected" : ""} ${folder ? "in-folder" : ""}`}>
            <button className="library-video" onClick={() => { setVisualAnalysis(""); setAttachVisualToChat(false); setVisualTimestamp(0); setActiveVideoId(video.id); setBackendTranscript([]); setTranscriptStatus(""); setLoaded(true); setVideoUrl(video.url); void processTranscriptAutomatically(video); }}>
              <div className="library-thumb purple"><Video size={15} /></div>
              <div className="library-video-copy"><span>{video.title}</span><small>Saved video</small></div>
            </button>
            {folder
              ? <button className="library-delete-button folder-action" title={`Remove from “${folder.name}”`} aria-label={`Remove ${video.title} from ${folder.name}`} onClick={() => void removeVideoFromFolder(folder.id, video.id)}><FolderMinus size={14} /></button>
              : <button className="library-delete-button folder-action" title="Add to a folder" aria-label={`Add ${video.title} to a folder`} onClick={(event) => openFolderMenu(event, { kind: "move", videoId: video.id })}><FolderPlus size={14} /></button>}
            <button className="library-delete-button" title={`Delete ${video.title}`} aria-label={`Delete ${video.title}`} onClick={() => void deleteVideo(video)}><Trash2 size={14} /></button>
          </div>
  );

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><Play size={17} fill="currentColor" /></div>
          <span className="brand-name">lecturemate<span className="brand-dot">.</span></span>
          <button className="icon-button collapse-button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}><PanelLeftClose size={17} /></button>
        </div>

        <button className="new-chat" onClick={startNewChat}><Plus size={17} /> New chat <span>⌘ K</span></button>

        <div className="nav-section">
          <div className="nav-label">WORKSPACE</div>
          {[
            { label: "My library", icon: Layers3 },
            { label: "Recent videos", icon: Clock3 },
            { label: "Search library", icon: Search },
          ].map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${activeNav === label ? "active" : ""}`} onClick={() => setActiveNav(label)}>
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </div>

        <div className="library-block">
          <div className="library-heading"><span className="nav-label">YOUR LIBRARY</span><span className="library-heading-actions"><button className="icon-button small" onClick={() => void createFolder()} aria-label="New folder" title="New folder"><FolderPlus size={15} /></button><button className="icon-button small" onClick={startNewChat} aria-label="New chat"><Plus size={15} /></button></span></div>
          {folders.map((folder) => {
            const members = folder.video_ids.map((id) => backendVideos.find((video) => video.id === id)).filter((video): video is BackendVideo => !!video);
            const collapsed = !!collapsedFolders[folder.id];
            return <div key={`folder-${folder.id}`} className={`library-folder ${activeFolder?.id === folder.id ? "has-active" : ""}`}>
              <div className="library-folder-head">
                <button className="library-folder-toggle" aria-expanded={!collapsed} title={collapsed ? "Expand folder" : "Collapse folder"} onClick={() => setCollapsedFolders((current) => ({ ...current, [folder.id]: !current[folder.id] }))}>
                  <ChevronRight size={12} className={`folder-chevron ${collapsed ? "" : "open"}`} />
                  {collapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
                  <span className="library-folder-name">{folder.name}</span>
                  <small>{members.length}</small>
                </button>
                <button className="library-delete-button folder-action" title="Add videos to this folder" aria-label={`Add videos to ${folder.name}`} onClick={(event) => openFolderMenu(event, { kind: "add", folderId: folder.id })}><Plus size={14} /></button>
                <button className="library-delete-button folder-action" title="Rename folder" aria-label={`Rename ${folder.name}`} onClick={() => void renameFolder(folder)}><Pencil size={13} /></button>
                <button className="library-delete-button" title={`Delete folder ${folder.name}`} aria-label={`Delete folder ${folder.name}`} onClick={() => void deleteFolder(folder)}><Trash2 size={14} /></button>
              </div>
              {!collapsed && (members.length === 0
                ? <p className="library-folder-empty">Empty. Use + to add videos.</p>
                : members.map((video) => renderLibraryVideo(video, folder)))}
            </div>;
          })}
          {folders.length > 0 && unfiledVideos.length > 0 && <div className="library-unfiled-label">NOT IN A FOLDER</div>}
          {unfiledVideos.map((video) => renderLibraryVideo(video, null))}
          <button className="library-video muted" onClick={startNewChat}>
            <div className="library-thumb purple"><Plus size={15} /></div>
            <div className="library-video-copy"><span>Add another video</span><small>Save to your library</small></div>
          </button>
        </div>

        {folderMenu && <>
          <div className="folder-menu-backdrop" onClick={() => setFolderMenu(null)} />
          <div className="folder-menu" role="menu" style={{ top: folderMenu.top, left: folderMenu.left }}>
            {folderMenu.kind === "move" ? <>
              <div className="folder-menu-title">Add to folder</div>
              {folders.map((folder) => <button key={folder.id} role="menuitem" onClick={() => { const videoId = folderMenu.videoId; setFolderMenu(null); void addVideoToFolder(folder.id, videoId); }}><Folder size={13} /><span>{folder.name}</span></button>)}
              <button role="menuitem" className="folder-menu-new" onClick={() => { const videoId = folderMenu.videoId; setFolderMenu(null); void createFolder(videoId); }}><Plus size={13} /><span>New folder…</span></button>
            </> : (() => {
              const target = folders.find((folder) => folder.id === folderMenu.folderId);
              if (!target) return null;
              const candidates = backendVideos.filter((video) => !target.video_ids.includes(video.id));
              return <>
                <div className="folder-menu-title">Add to “{target.name}”</div>
                <div className="folder-menu-scroll">
                  {candidates.length === 0 && <p className="folder-menu-empty">Every video in your library is already here.</p>}
                  {candidates.map((video) => {
                    const other = folders.find((folder) => folder.video_ids.includes(video.id));
                    return <button key={video.id} role="menuitem" onClick={() => { setFolderMenu(null); void addVideoToFolder(target.id, video.id); }}><Video size={13} /><span>{video.title}{other && <small> · moves from {other.name}</small>}</span></button>;
                  })}
                </div>
                <button role="menuitem" className="folder-menu-new" onClick={() => addNewVideoToFolder(target)}><Plus size={13} /><span>New video into this folder…</span></button>
              </>;
            })()}
          </div>
        </>}

        <div className="sidebar-bottom">
          <div className="upgrade-card">
            <div className="upgrade-icon"><Sparkles size={16} /></div>
            <div><strong>Your learning space</strong><p>One video at a time. Big ideas, made clearer.</p></div>
          </div>
          <button className="profile-row" onClick={() => setShowLLMModal(true)}>
            <div className="avatar"><Settings2 size={15} /></div><div className="profile-copy"><strong>AI model settings</strong><span>{llmSettings.provider === "gemini" ? "Gemini API" : llmSettings.provider === "groq" ? "Groq API" : "Local Ollama"}</span></div><Settings2 size={16} className="profile-settings" />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>{activeNav}</strong><ChevronDown size={14} /></div>
          <div className="topbar-actions">
            <div className="status-pill"><span className={`status-dot ${backendOnline ? "online" : "offline"}`} /> {backendOnline ? "Backend connected" : "Backend offline"}</div>
            <button className="help-button" onClick={() => notify("Add or select a lecture to start asking questions.")}><CircleHelp size={17} /><span>Help</span></button>
            <div className="topbar-profile-wrap">
              <button className={`topbar-profile-button ${showProfileMenu ? "is-open" : ""}`} aria-label="Profile menu" aria-expanded={showProfileMenu} onClick={() => setShowProfileMenu((open) => !open)}>
                <span className="topbar-profile-avatar">{(currentUser?.email || "U").slice(0, 1).toUpperCase()}</span><span className="topbar-profile-label">Profile</span><ChevronDown size={14} />
              </button>
              {showProfileMenu && <div className="topbar-profile-menu" role="menu">
                <div className="topbar-profile-identity"><span className="topbar-profile-avatar">{(currentUser?.email || "U").slice(0, 1).toUpperCase()}</span><div><strong>{currentUser?.email || "Signed in"}</strong><small>LectureMate account</small></div></div>
                <button className="topbar-profile-menu-item" role="menuitem" onClick={() => { setShowProfileMenu(false); setShowLLMModal(true); }}><Settings2 size={16} /><span>AI model settings</span></button>
                <button className="topbar-profile-menu-item logout-item" role="menuitem" onClick={() => { setShowProfileMenu(false); window.dispatchEvent(new Event("lecturemate:logout")); }}><LogOut size={16} /><span>Log out</span></button>
              </div>}
            </div>
          </div>
        </header>

        <div className="page-content">
          {activeNav === "My library" && !loaded && <section className="welcome-row">
            <div>
              <div className="eyebrow"><Sparkles size={14} /> YOUR AI LEARNING SPACE</div>
              <h1>Make every lecture <span>click.</span></h1>
              <p className="subtitle">Understand the hard parts, right when you need them.</p>
            </div>
          </section>}

          {activeNav === "My library" && !loaded && <section className="url-card">
            <div className="url-card-icon"><Link2 size={19} /></div>
            <div className="url-main">
              {targetFolderId !== null && folders.some((folder) => folder.id === targetFolderId) && <div className="target-folder-chip"><Folder size={13} /><span>Adding to <strong>{folders.find((folder) => folder.id === targetFolderId)?.name}</strong></span><button type="button" onClick={() => setTargetFolderId(null)} aria-label="Cancel adding to folder" title="Cancel"><X size={13} /></button></div>}
              <label htmlFor="video-url">Start with a video</label>
              <p>Paste a YouTube link or add a video file to start learning.</p>
              <div className="url-input-row">
                <div className="url-input-wrap"><Link2 size={16} /><input id="video-url" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleLoadVideo()} placeholder="Paste a YouTube URL..." /></div>
                <button className="primary-button" disabled={apiBusy} onClick={handleLoadVideo}>{apiBusy ? "Opening..." : "Open video"} <ArrowRight size={16} /></button>
              </div>
              <div className="upload-divider"><span>or</span></div>
              <div className="local-upload-row">
                <button className="outline-button" disabled={uploadBusy} onClick={() => fileInputRef.current?.click()}><FileVideo size={16} /> {uploadBusy ? "Uploading video..." : "Upload a video file"}</button>
                <span>MP4, WebM, MOV and other browser-supported formats</span>
                <input ref={fileInputRef} className="hidden-file-input" type="file" accept="video/*,.mp4,.webm,.mov,.m4v,.ogv" onChange={handleVideoFileUpload} />
              </div>
            </div>
            <div className="url-decoration"><div className="deco-orbit orbit-one" /><div className="deco-orbit orbit-two" /><div className="deco-star">✳</div></div>
          </section>}

          {activeNav !== "My library" ? (
            <section className="workspace-page">
              <div className="recent-workspace-header"><div><div className="eyebrow compact">WORKSPACE</div><h1>{activeNav}</h1></div>{activeNav === "Recent videos" && <button className="recent-new-chat" onClick={() => { startNewChat(); setActiveNav("My library"); }}><Plus size={15} /> New chat</button>}</div>
              {activeNav === "Search library" && <LibrarySearch videoCount={backendVideos.length} onOpen={openVideoAt} onNotify={notify} />}
              {activeNav === "Recent videos" && <div className="workspace-list">{backendVideos.length === 0 ? <p className="empty-state">No saved videos yet. Add a YouTube link or upload a video from My library.</p> : backendVideos.slice().reverse().map((video) => <button key={video.id} className="workspace-list-item" onClick={() => { setActiveNav("My library"); setVisualAnalysis(""); setAttachVisualToChat(false); setVisualTimestamp(0); setActiveVideoId(video.id); setBackendTranscript([]); setTranscriptStatus(""); setLoaded(true); setVideoUrl(video.url); void processTranscriptAutomatically(video); }}><span className="library-thumb purple"><Video size={15} /></span><span><strong>{video.title || "Untitled lecture"}</strong><small>Added {video.created_at ? new Date(video.created_at).toLocaleDateString() : "to library"}</small></span><ArrowRight size={16} /></button>)}</div>}
            </section>
          ) : loaded ? (
            <section className="workspace-grid">
              <div className="left-column">
                <div className="section-heading">
                  <div><div className="eyebrow compact">NOW LEARNING</div><h2>{activeBackendVideo?.title ?? "No lecture selected"}</h2></div>
                  <button className={`icon-button bookmark-button ${saved ? "is-saved" : ""}`} onClick={() => { const nextSaved = !saved; setSaved(nextSaved); localStorage.setItem("lecturemate:saved", String(nextSaved)); notify(nextSaved ? "Saved to your library" : "Removed from saved answers"); }} aria-label="Save video"><Bookmark size={18} fill={saved ? "currentColor" : "none"} /></button>
                </div>

                <div className="video-frame">
                  <div className="video-top-overlay"><span className="video-tag"><span className="live-dot" /> {youtubeId ? "YOUTUBE VIDEO" : isUploadedFile ? "UPLOADED VIDEO" : activeBackendVideo ? "SAVED VIDEO LINK" : "DEMO LECTURE"}</span><button className="video-more" onClick={() => notify("Use the player controls to play, pause, or seek the video")}><MoreHorizontal size={20} /></button></div>
                  {youtubeId ? (
                    youtubeApiUnavailable ? (
                      <iframe
                        className="youtube-fallback-iframe"
                        title={activeBackendVideo?.title || "YouTube video player"}
                        src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=0&rel=0&playsinline=1`}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        referrerPolicy="strict-origin-when-cross-origin"
                        allowFullScreen
                      />
                    ) : <div key={youtubeId} ref={youtubePlayerHostRef} className="youtube-player-host" aria-label="YouTube video player" />
                  ) : isUploadedFile && activeBackendVideo ? (
                    <video key={activeBackendVideo.id} ref={localVideoRef} crossOrigin="anonymous" className="uploaded-video-player" src={`${activeBackendVideo.url}${activeBackendVideo.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(localStorage.getItem("lecturemate:token") || "")}`} controls onLoadedMetadata={(event) => { setDurationSeconds(Math.floor(event.currentTarget.duration || 0)); if (seekSecondsRef.current > 0) event.currentTarget.currentTime = seekSecondsRef.current; }} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)} onTimeUpdate={(event) => { const now = Math.floor(event.currentTarget.currentTime || 0); setCurrentSeconds(now); setSelectedTime(formatTime(now)); }} />
                  ) : activeBackendVideo ? (
                    <div className="video-unavailable"><Video size={28} /><strong>This link isn't a supported YouTube URL.</strong><span>Start a new chat and paste a YouTube video link, or upload a local video file.</span></div>
                  ) : (
                    <div className="video-art">
                      <div className="art-glow" />
                      <div className="neural-visual">
                        <svg viewBox="0 0 420 240" role="img" aria-label="Illustration of a neural network">
                          <g stroke="#7770dd" strokeOpacity=".45" strokeWidth="1.2">
                            {[[58,45],[58,95],[58,145],[58,195]].map((a, i) => [[180,30],[180,78],[180,126],[180,174],[180,218]].map((b,j) => <line key={`${i}-${j}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />))}
                            {[[180,30],[180,78],[180,126],[180,174],[180,218]].map((a,i) => [[330,65],[330,120],[330,175]].map((b,j) => <line key={`${i}-${j}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />))}
                          </g>
                          {[[58,45],[58,95],[58,145],[58,195]].map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r="8" fill="#9b93ff" stroke="#e4e1ff" strokeWidth="1.5" />)}
                          {[[180,30],[180,78],[180,126],[180,174],[180,218]].map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r="9" fill="#7770dd" stroke="#c7c2ff" strokeWidth="1.5" />)}
                          {[[330,65],[330,120],[330,175]].map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r="10" fill="#b2aaff" stroke="#f0eeff" strokeWidth="1.5" />)}
                          <g fill="#a9a4c9" fontSize="10" fontFamily="Inter, sans-serif"><text x="35" y="224">INPUT</text><text x="148" y="238">HIDDEN LAYER</text><text x="305" y="202">OUTPUT</text></g>
                        </svg>
                      </div>
                      <div className="video-title-art"><span>THE BASICS</span><h3>Neural<br />Networks</h3><p>How machines learn patterns</p></div>
                      <button className="big-play" onClick={() => setShowSourceModal(true)} aria-label="Demo play"><Play size={23} fill="currentColor" /></button>
                    </div>
                  )}
                  <div className="video-controls">
                    <button className="control-play" onClick={togglePlayback} aria-label={isPlaying ? "Pause video" : "Play video"} title={isPlaying ? "Pause video" : "Play video"}>{isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button>
                    <span className="video-time">{formatTime(currentSeconds)} <span>/ {durationSeconds ? formatTime(durationSeconds) : "--:--"}</span></span>
                    <div className="scrubber-wrap">
                      <input className="video-scrubber" aria-label="Seek video timestamp" type="range" min={0} max={Math.max(1, durationSeconds)} value={Math.min(currentSeconds, Math.max(1, durationSeconds))} onChange={(event) => seekToSeconds(Number(event.target.value))} />
                      {durationSeconds > 0 && moments.map((moment) => <button key={moment.id} type="button" className={`scrubber-marker kind-${moment.kind}`} style={{ left: `${Math.min(100, (moment.seconds / durationSeconds) * 100)}%` }} onClick={() => seekToSeconds(moment.seconds)} title={`${formatTime(moment.seconds)} · ${MOMENT_KINDS.find((k) => k.kind === moment.kind)?.label}${moment.note ? ` — ${moment.note}` : ""}`} aria-label={`Jump to saved moment at ${formatTime(moment.seconds)}`} />)}
                    </div>
                    <button className="control-moment" onClick={() => saveMomentNow()} disabled={activeVideoId === null} title="Save this moment (B)" aria-label="Save this moment"><Bookmark size={14} /></button>
                    <button className="control-cc" onClick={() => setTab("Transcript")}>CC</button>
                    <button className="control-full" onClick={() => { if (youtubePlayerHostRef.current?.querySelector("iframe")) { const frame = youtubePlayerHostRef.current.querySelector("iframe"); if (frame?.requestFullscreen) void frame.requestFullscreen(); } else if (localVideoRef.current?.requestFullscreen) void localVideoRef.current.requestFullscreen(); }} aria-label="Fullscreen"><ArrowDownRight size={17} /></button>
                  </div>
                </div>

                <div className="study-tabs">
                  <div className="tab-list">
                    {(["Transcript", "Notes", "Moments", "Quiz", "Mind Map", "Generate Notes", "Flashcards", "Learning Detective"] as Tab[]).map((item) => <button key={item} className={`tab-button ${tab === item ? "selected" : ""}`} onClick={() => setTab(item)}>{item === "Transcript" ? <ListVideo size={15} /> : item === "Notes" || item === "Generate Notes" ? <StickyNote size={15} /> : item === "Mind Map" || item === "Flashcards" ? <Layers3 size={15} /> : item === "Learning Detective" ? <Sparkles size={15} /> : item === "Moments" ? <Bookmark size={15} /> : <GraduationCap size={15} />}{item}</button>)}
                  </div>
                  {tab === "Transcript" && <div className="transcript-tools">
                    <div className="transcript-search"><Search size={14} /><input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Find in transcript" /></div>
                    {activeBackendVideo && <>{(autoTranscribeBusy || transcriptStatus) && <div className={`transcript-status ${autoTranscribeBusy ? "busy" : ""}`} role="status">{autoTranscribeBusy && <span className="thinking-spinner" />}{transcriptStatus || "Preparing transcript…"}</div>}{backendTranscript.length > 0 && <button className="outline-button import-transcript-button" disabled={autoTranscribeBusy} onClick={buildSemanticIndex}><Search size={14} /> Re-index</button>}<button className="outline-button import-transcript-button" onClick={() => setShowTranscriptModal(true)}><Upload size={14} /> Import fallback</button></>}
                  </div>}
                </div>

                {tab === "Transcript" && <div className="transcript-panel">
                  {activeBackendVideo && backendTranscript.length === 0 && <div className="empty-state">Transcript processing starts automatically. Keep this tab open while Whisper transcribes the video; status and errors appear above.</div>}
                  {filteredTranscript.map((line) => <button key={line.time} className={`transcript-line ${selectedTime === line.time ? "current" : ""}`} onClick={() => seekToTimestamp(line.time)}>
                    <span className="timestamp">{line.time}</span><span className="transcript-text">{line.text}</span>{selectedTime === line.time && <span className="playing-mark"><Play size={10} fill="currentColor" /></span>}
                  </button>)}
                  {filteredTranscript.length === 0 && !(activeBackendVideo && backendTranscript.length === 0) && <div className="empty-state">No transcript lines match “{searchTerm}”.</div>}
                </div>}
                {tab === "Notes" && <div className="notes-panel"><div className="notes-title"><StickyNote size={17} /><strong>Your lecture notes</strong></div><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Write your notes here..." /><button className="primary-button small-primary" onClick={saveNotes}>Save notes <Check size={15} /></button><p className="notes-save-hint">{activeBackendVideo ? "Saved to this video in your SQLite database when you click Save." : "Select a saved lecture to store notes with that lecture."}</p></div>}
                {tab === "Quiz" && <div className="notes-panel quiz-hub-panel">
                  <div className="notes-title"><GraduationCap size={17} /><strong>Quiz studio</strong></div>
                  <p>All assessments live here. Choose a quiz type, answer questions, and review explanations. Learning Detective only analyzes the results.</p>
                  <div className="quiz-mode-grid" role="tablist" aria-label="Quiz type">
                    <button className={`quiz-mode-card ${quizMode === "standard" ? "selected" : ""}`} onClick={() => { setQuizMode("standard"); setPersonalizedQuizEnabled(false); }}><strong>Lecture quiz</strong><span>Check understanding across the lecture.</span></button>
                    <button className={`quiz-mode-card ${quizMode === "personalized" ? "selected" : ""}`} onClick={() => { setQuizMode("personalized"); setPersonalizedQuizEnabled(true); }}><strong>Personalized practice</strong><span>Focus on concepts that may need more practice.</span></button>
                    <button className={`quiz-mode-card ${quizMode === "prerequisite" ? "selected" : ""}`} onClick={() => { setQuizMode("prerequisite"); setPersonalizedQuizEnabled(false); }}><strong>Prerequisite diagnostic</strong><span>Check foundational concepts behind a difficult topic.</span></button>
                  </div>
                  {quizMode !== "prerequisite" ? <>
                    <div className="quiz-mode-description">{quizMode === "personalized" ? "Questions are tailored using your recorded learning history where available." : "Questions are grounded in the selected lecture and include explanations."}</div>
                    <div className="artifact-actions">
                      <button className={`outline-button ${quizQuestionCount === 5 ? "artifact-selected" : ""}`} onClick={() => setQuizQuestionCount(5)}>5 questions</button>
                      <button className={`outline-button ${quizQuestionCount === 10 ? "artifact-selected" : ""}`} onClick={() => setQuizQuestionCount(10)}>10 questions</button>
                      <button className="primary-button small-primary" disabled={studyArtifactBusy || !backendTranscript.length} onClick={() => void generateStudyArtifact("quiz", quizQuestionCount, true)}>{studyArtifactBusy ? "Generating…" : studyArtifactKind === "quiz" && studyArtifactData && "questions" in studyArtifactData ? "Generate replacement quiz" : "Generate quiz"}</button>
                    </div>
                    {studyArtifactKind === "quiz" && studyArtifactData && "questions" in studyArtifactData && <p className="quiz-save-hint">This quiz is saved to this lecture when generated. Use “Generate replacement quiz” only when you want a new set of questions.</p>}
                    {studyArtifactBusy && studyArtifactKind === "quiz" && <p role="status">Creating your quiz…</p>}
                    {studyArtifactKind === "quiz" && studyArtifactData && "questions" in studyArtifactData && <div className="generated-quiz"><h3>{studyArtifactData.title}</h3>{studyArtifactData.questions.map((question, index) => <section className="generated-question" key={`${index}-${question.question}`}><strong>{index + 1}. {question.question}</strong><div className="generated-question-options">{question.options.map((option, optionIndex) => { const answered = quizAnswers[index] !== undefined; const isCorrect = optionIndex === question.correct_index; const isSelected = quizAnswers[index] === optionIndex; return <button key={optionIndex} className={`${answered && isCorrect ? "answer-correct" : ""} ${answered && isSelected && !isCorrect ? "answer-wrong" : ""}`} onClick={() => void recordQuizAnswer(index, optionIndex, question)} disabled={answered}>{String.fromCharCode(65 + optionIndex)}. {option}</button>; })}</div>{quizAnswers[index] !== undefined && <p className="quiz-explanation">{quizAnswers[index] === question.correct_index ? "Correct! " : "Not quite. "}{question.explanation}</p>}</section>)}<div className="artifact-footer"><span>{Object.keys(quizAnswers).length} of {studyArtifactData.questions.length} answered</span><button className="outline-button" onClick={() => void downloadStudyArtifact("quiz")}><FileText size={14} /> Download PDF</button></div></div>}
                    {studyArtifactKind === "quiz" && studyArtifact && !studyArtifactData && <pre className="generated-study-content">{studyArtifact}</pre>}
                  </> : <section className="prerequisite-quiz-workspace">
                    <h3>Prerequisite diagnostic</h3>
                    <p>Choose the topic you are struggling with. The diagnostic checks related foundations and saves results to your learning history.</p>
                    <label className="diagnostic-target-field"><strong>Target concept</strong><input value={diagnosticTarget} onChange={(event) => setDiagnosticTarget(event.target.value)} placeholder={learningProfile?.struggling_concepts?.[0]?.concept || "e.g. Gradient descent"} maxLength={180} /></label>
                    {(learningProfile?.struggling_concepts || []).length > 0 && <div className="diagnostic-launch-list"><span className="quiz-suggested-label">Suggested from your results</span>{(learningProfile?.struggling_concepts || []).slice(0, 4).map((item, index) => <button key={`${item.concept}-quiz-target-${index}`} className="outline-button" onClick={() => setDiagnosticTarget(item.concept)}>{item.concept}</button>)}</div>}
                    <button className="primary-button small-primary" disabled={diagnosticBusy || activeVideoId === null || !backendTranscript.length} onClick={() => void generatePrerequisiteDiagnostic(diagnosticTarget.trim() || learningProfile?.struggling_concepts?.[0]?.concept || "the main concepts in this lecture", true)}>{diagnosticBusy ? "Building diagnostic…" : diagnosticData ? "Generate new diagnostic" : "Generate prerequisite diagnostic"}</button>
                    {diagnosticError && <p className="learning-detective-error" role="alert">{diagnosticError}</p>}
                    {diagnosticBusy && <p role="status">Creating five short questions to check the foundations of {diagnosticConcept}…</p>}
                    {diagnosticData && <div className="diagnostic-quiz">
                      <div className="diagnostic-quiz-heading"><strong>{diagnosticData.title || "Prerequisite diagnostic"}</strong><span>Target: {diagnosticConcept}</span></div>
                      {diagnosticData.questions.map((question, index) => { const answered = diagnosticAnswers[index] !== undefined; const selected = diagnosticAnswers[index]; const correct = selected === question.correct_index; return <section className="generated-question" key={`diagnostic-${index}-${question.question}`}>
                        <strong>{index + 1}. {question.question}</strong>
                        <div className="generated-question-options">{question.options.map((option, optionIndex) => <button key={optionIndex} className={`${answered && optionIndex === question.correct_index ? "answer-correct" : ""} ${answered && selected === optionIndex && !correct ? "answer-wrong" : ""}`} onClick={() => void recordDiagnosticAnswer(index, optionIndex, question)} disabled={answered}>{String.fromCharCode(65 + optionIndex)}. {option}</button>)}</div>
                        {answered && <p className="quiz-explanation">{correct ? "Correct. " : "Not quite. "}{question.explanation}</p>}
                      </section>; })}
                      <div className="diagnostic-result"><strong>{Object.keys(diagnosticAnswers).length} of {diagnosticData.questions.length} answered</strong>{Object.keys(diagnosticAnswers).length === diagnosticData.questions.length && <p>{diagnosticData.questions.filter((question, index) => diagnosticAnswers[index] === question.correct_index).length}/{diagnosticData.questions.length} correct. Use missed prerequisite questions as clues for what to review next.</p>}</div>
                      <div className="diagnostic-result-actions"><button className="outline-button" onClick={() => { setChatInput(`Teach me the prerequisite foundations for ${diagnosticConcept} from this lecture, using a simple example and the most relevant timestamp.`); notify("Added a prerequisite-focused explanation prompt to chat"); }}>Explain foundations in chat</button><button className="outline-button" disabled={diagnosticBusy} onClick={() => void generatePrerequisiteDiagnostic(diagnosticTarget.trim() || diagnosticConcept, true)}>Generate replacement questions</button></div><p className="quiz-save-hint">Diagnostic answers are saved to your learning history as you answer. Generate replacement questions only to start a fresh diagnostic.</p>
                    </div>}
                  </section>}
                </div>}
                {tab === "Generate Notes" && <div className="notes-panel"><div className="notes-title"><StickyNote size={17} /><strong>AI-generated lecture notes</strong></div><p>Choose how detailed your revision material should be.</p><div className="note-mode-options"><button className={`outline-button ${noteMode === "full" ? "artifact-selected" : ""}`} onClick={() => setNoteMode("full")}><BookOpen size={14} /> Full structured notes</button><button className={`outline-button ${noteMode === "crisp" ? "artifact-selected" : ""}`} onClick={() => setNoteMode("crisp")}><FileText size={14} /> Short & crisp important notes</button></div><button className="primary-button small-primary" disabled={studyArtifactBusy || !backendTranscript.length} onClick={() => void generateStudyArtifact(noteMode === "full" ? "full_notes" : "crisp_notes")}>{studyArtifactBusy ? "Generating…" : noteMode === "full" ? "Generate full notes" : "Generate crisp notes"}</button>{studyArtifactKind && ["full_notes", "crisp_notes"].includes(studyArtifactKind) && studyArtifact && <><pre className="generated-study-content">{studyArtifact}</pre><div className="artifact-footer"><span>{studyArtifactKind === "full_notes" ? "Full structured notes" : "Short & crisp notes"}</span><button className="outline-button" onClick={() => void downloadStudyArtifact(studyArtifactKind)}><FileText size={14} /> Download PDF</button></div></>}</div>}
                {tab === "Mind Map" && <div className="notes-panel"><div className="notes-title"><Layers3 size={17} /><strong>Natural lecture mind map</strong></div><p>Organize the lecture into related topics and subtopics.</p><button className="primary-button small-primary" disabled={studyArtifactBusy || !backendTranscript.length} onClick={() => void generateStudyArtifact("mindmap")}>{studyArtifactBusy ? "Generating…" : "Generate mind map"}</button>{studyArtifactBusy && studyArtifactKind === "mindmap" && <p role="status">Building topic relationships…</p>}{studyArtifactKind === "mindmap" && studyArtifactData && "children" in studyArtifactData && <div className="mindmap-view"><div className="mindmap-root">{studyArtifactData.title}</div><ul>{studyArtifactData.children.map((node, index) => <MindMapBranch key={`${node.label}-${index}`} node={node} />)}</ul><div className="artifact-footer"><span>Hierarchical topic map</span><button className="outline-button" onClick={() => void downloadStudyArtifact("mindmap")}><FileText size={14} /> Download PDF</button></div></div>}{studyArtifactKind === "mindmap" && studyArtifact && !studyArtifactData && <pre className="generated-study-content">{studyArtifact}</pre>}</div>}
                {tab === "Flashcards" && <div className="notes-panel"><div className="notes-title"><Layers3 size={17} /><strong>Lecture flashcards</strong></div><p>Recall first, then reveal the answer. Cards are saved to this lecture and remain available when you reopen it.</p><button className="primary-button small-primary" disabled={studyArtifactBusy || !backendTranscript.length} onClick={() => void generateStudyArtifact("flashcards")}>{studyArtifactBusy ? "Generating…" : studyArtifactKind === "flashcards" ? "Regenerate flashcards" : "Generate flashcards"}</button>{studyArtifactBusy && studyArtifactKind === "flashcards" && <p role="status">Creating concise, lecture-grounded flashcards…</p>}{studyArtifactKind === "flashcards" && studyArtifactData && "cards" in studyArtifactData && <div className="flashcards-grid"><h3 className="flashcards-heading">{studyArtifactData.title}</h3>{studyArtifactData.cards.map((card,index)=><button key={`${index}-${card.front}`} onClick={() => setFlippedCards(old=>({...old,[index]:!old[index]}))} aria-label={flippedCards[index] ? "Show question" : "Reveal answer"} className={`flashcard ${flippedCards[index] ? "flipped" : ""}`}><span className="flashcard-label">{flippedCards[index]?"Answer":"Question"} · {index+1}/{studyArtifactData.cards.length}</span><strong className="flashcard-answer">{flippedCards[index]?card.back:card.front}</strong><span className="flashcard-hint">Click to {flippedCards[index]?"see question":"reveal answer"}</span></button>)}<div className="artifact-footer flashcards-footer"><span>{studyArtifactData.cards.length} flashcards · click any card to flip</span><button className="outline-button" onClick={() => void downloadStudyArtifact("flashcards")}><FileText size={14} /> Download PDF</button></div></div>}{studyArtifactKind === "flashcards" && studyArtifact && !studyArtifactData && <pre className="generated-study-content">{studyArtifact}</pre>}</div>}

                {tab === "Moments" && (activeVideoId === null
                  ? <div className="notes-panel"><p className="empty-state">Select a lecture to start saving moments.</p></div>
                  : <MomentsPanel videoTitle={activeBackendVideo?.title ?? ""} currentSeconds={currentSeconds} durationSeconds={durationSeconds} segments={backendTranscript} moments={moments} onAdd={(seconds, kind, note) => addMoment(seconds, kind, note)} onUpdate={updateMoment} onRemove={removeMoment} onSeek={seekToSeconds} onNotify={notify} />)}
                {tab === "Learning Detective" && <div className="notes-panel learning-detective-panel ld-redesign">
                  <div className="learning-detective-heading">
                    <div><div className="notes-title"><Sparkles size={17} /><strong>Learning Detective</strong></div><p>See which concepts are solid, where foundations may be missing, and how your results change over time. Quizzes are managed in the Quiz tab.</p></div>
                    <button className="outline-button" disabled={learningProfileBusy || activeVideoId === null} onClick={() => { void refreshLearningProfile(); void refreshLearningProgress(); }}>{learningProfileBusy || learningProgressBusy ? "Refreshing…" : "Refresh insights"}</button>
                  </div>
                  {learningProfileError && <p className="learning-detective-error" role="alert">{learningProfileError}</p>}
                  {learningProgressError && <p className="learning-detective-error" role="alert">{learningProgressError}</p>}
                  {activeVideoId === null ? <div className="empty-state">Select a saved lecture to see learning insights.</div> : learningProfileBusy && !learningProfile ? <p role="status">Loading your learning signals…</p> : <>
                    {(() => {
                      const concepts = [...(learningProfile?.concepts || [])];
                      const weakest = concepts.slice().sort((a, b) => learningAccuracy(a.accuracy) - learningAccuracy(b.accuracy))[0];
                      const strongest = concepts.slice().sort((a, b) => b.accuracy - a.accuracy)[0];
                      const answered = learningProgress?.stats.questions_answered ?? 0;
                      const sessions = [...(learningProgress?.quiz_sessions || [])].filter((item) => item.answered_questions > 0).sort((a, b) => new Date(a.updated_at || a.created_at).getTime() - new Date(b.updated_at || b.created_at).getTime());
                      const trend = sessions.length >= 2 ? Math.round((sessions[sessions.length - 1].accuracy - sessions[0].accuracy) * 100) : null;
                      return <section className="ld-analysis-summary" aria-label="Learning analysis summary">
                        <div className="ld-analysis-summary-main"><span className="ld-eyebrow">YOUR LEARNING READOUT</span>
                          <h3>{weakest ? `Focus next on ${weakest.concept}` : answered ? "Keep building topic-level evidence" : "Your analysis starts with one quiz"}</h3>
                          <p>{weakest ? `This is currently your lowest-scoring tracked topic at ${Math.round(learningAccuracy(weakest.accuracy) * 100)}% across ${weakest.attempts} ${weakest.attempts === 1 ? "recorded answer" : "recorded answers"}. Review it, then retest to see whether the score changes.` : answered ? "There are saved answers, but no reliable topic-level breakdown yet. Keep answering quizzes with concept labels to reveal specific strengths and gaps." : "Learning Detective does not guess your strengths. Complete a quiz in Quiz to create measured evidence, then return here for topic comparisons and trends."}</p>
                          <div className="ld-analysis-actions"><button className="primary-button small-primary" onClick={() => { setQuizMode(weakest ? "personalized" : "standard"); setPersonalizedQuizEnabled(Boolean(weakest)); setTab("Quiz"); }}>{weakest ? "Practice weakest topic" : "Take a quiz"} <ArrowRight size={14} /></button>{weakest && <button className="outline-button" onClick={() => { setChatInput(`Explain "${weakest.concept}" step by step with a simple example, then point me to the relevant lecture timestamp.`); notify("Added a focused explanation prompt to chat"); }}>Ask tutor</button>}</div>
                        </div>
                        <div className="ld-analysis-facts">
                          <div><span>Strongest measured topic</span><strong>{strongest ? strongest.concept : "Not enough data"}</strong><b>{strongest ? `${Math.round(learningAccuracy(strongest.accuracy) * 100)}% accuracy` : "—"}</b></div>
                          <div><span>Evidence collected</span><strong>{answered} answers</strong><b>{learningProgress?.stats.quiz_sessions ?? 0} quiz sessions</b></div>
                          <div><span>Overall trend</span><strong>{trend === null ? "Not established" : `${trend > 0 ? "+" : ""}${trend} percentage points`}</strong><b>{trend === null ? "Need at least 2 completed sessions" : "First to latest saved session"}</b></div>
                        </div>
                      </section>;
                    })()}
                    <div className="learning-metrics ld-summary-metrics">
                      <div><strong>{learningProfile?.concepts?.length ?? 0}</strong><span>Topics assessed</span></div>
                      <div><strong>{(learningProfile?.struggling_concepts || []).length}</strong><span>Topics needing review</span></div>
                      <div><strong>{(learningProfile?.concepts || []).filter((item) => item.status === "on_track").length}</strong><span>Topics on track</span></div>
                    </div>
                    <section className={`learning-progress-overview${progressTrendExpanded ? " is-expanded" : ""}`}>
                      <button type="button" className="learning-progress-heading ld-progress-toggle" aria-expanded={progressTrendExpanded} onClick={() => setProgressTrendExpanded(value => !value)}>
                        <span><h4>Progress trend</h4><p>Expand to compare accuracy across saved quiz attempts and review quiz history.</p></span>
                        <span className="ld-confidence-toggle-label">{progressTrendExpanded ? "Collapse details −" : "View trend +"}</span>
                      </button>
                      <div className="learning-progress-stats">
                        <div><strong>{learningProgress?.stats.quiz_sessions ?? 0}</strong><span>Quiz sessions</span></div>
                        <div><strong>{learningProgress?.stats.questions_answered ?? 0}</strong><span>Questions answered</span></div>
                        <div><strong>{learningProgress?.stats.questions_answered ? `${Math.round(learningAccuracy(learningProgress?.stats.overall_accuracy ?? 0) * 100)}%` : "—"}</strong><span>Overall accuracy</span></div>
                      </div>
                      {progressTrendExpanded && <div className="ld-progress-expanded">
                        {(() => { const sessions = [...(learningProgress?.quiz_sessions || [])].filter(item => (item.answered_questions || 0) > 0).sort((a,b) => new Date(a.updated_at || a.created_at).getTime() - new Date(b.updated_at || b.created_at).getTime()); const points = sessions.slice(-12); const values = points.map(item => Math.max(0, Math.min(100, Math.round(learningAccuracy(item.accuracy) * 100)))); const coords = values.map((v,i) => `${points.length < 2 ? 50 : 12 + i * (76 / (points.length - 1))},${88 - v * .72}`).join(" "); return <section className="ld-accuracy-trend"><h4>Accuracy across attempts</h4><p>Each point is a saved quiz attempt, ordered from oldest to newest. Only recorded answers are included.</p>{points.length < 2 ? <p className="ld-chart-empty">Complete and save at least two quiz attempts to see an accuracy trend.</p> : <><svg viewBox="0 0 100 100" role="img" aria-label="Accuracy across saved quiz attempts chart" preserveAspectRatio="none"><line x1="12" y1="16" x2="88" y2="16"/><line x1="12" y1="52" x2="88" y2="52"/><line x1="12" y1="88" x2="88" y2="88"/><polyline points={coords} />{values.map((v,i) => <circle key={points[i].session_id} cx={points.length < 2 ? 50 : 12 + i * (76 / (points.length - 1))} cy={88 - v * .72} r="1.7"><title>{points[i].title}: {v}%</title></circle>)}</svg><div className="ld-trend-axis"><span>Older attempts</span><span>Latest attempts</span></div><div className="ld-trend-attempts">{points.map((item,i) => <div key={item.session_id}><span>Attempt {i+1}</span><strong>{values[i]}%</strong><small>{item.title}{item.target_concept ? ` · ${item.target_concept}` : ""}</small></div>)}</div></>}</section>; })()}
                        <section className="learning-insight-section"><h4>Recent quiz history</h4><p className="ld-section-helper">All saved quiz attempts for your account, across lectures.</p>
                          {(learningProgress?.quiz_sessions || []).length === 0 ? <p>No saved quiz results yet.</p> : (learningProgress?.quiz_sessions || []).map((session) => <article className="learning-history-item" key={session.session_id}><div><strong>{session.title}</strong><span>{session.video_title}{session.target_concept ? ` · ${session.target_concept}` : ""}</span><small>{new Date(session.updated_at || session.created_at).toLocaleString()}</small></div><b>{session.correct_answers}/{session.answered_questions} · {Math.round(learningAccuracy(session.accuracy) * 100)}%</b></article>)}
                        </section>
                      </div>}
                    </section>
                    <section className="ld-visual-grid ld-investigation-grid" aria-label="Learning behavior visual insights">
                      <section className={`ld-chart-card ld-investigation-card ld-confidence-card${topicConfidenceExpanded ? " is-expanded" : ""}`}>
                        <button type="button" className="ld-card-heading ld-confidence-toggle" aria-expanded={topicConfidenceExpanded} onClick={() => setTopicConfidenceExpanded((expanded) => !expanded)}>
                          <span className="ld-confidence-heading-copy"><span className="ld-eyebrow">EVIDENCE SNAPSHOT</span><strong className="ld-card-title">Topic confidence profile</strong><span className="ld-card-subtitle">Click to explore why each topic is marked for review, developing, or supported by stronger evidence.</span></span>
                          <span className="ld-confidence-toggle-side"><span className="ld-chart-icon"><Sparkles size={18} /></span><span className="ld-confidence-toggle-label">{topicConfidenceExpanded ? "Collapse details" : "View details"} {topicConfidenceExpanded ? "−" : "+"}</span></span>
                        </button>
                        {(() => { const topics = learningProfile?.concepts || []; const needsReview = topics.filter((item) => learningAccuracy(item.accuracy) < .5).length; const developing = topics.filter((item) => learningAccuracy(item.accuracy) >= .5 && learningAccuracy(item.accuracy) < .8).length; const strong = topics.filter((item) => learningAccuracy(item.accuracy) >= .8).length; const limited = topics.filter((item) => (item.attempts || 0) < 5).length; const total = topics.length; const parts = [{ label: "Needs review", count: needsReview, color: "#fb7185" }, { label: "Developing", count: developing, color: "#fbbf24" }, { label: "Strong evidence", count: strong, color: "#34d399" }]; return total === 0 ? <div className="ld-chart-empty"><strong>Not enough evidence yet</strong><p>Topic bands appear after quiz answers are saved with concept labels.</p></div> : <><div className="ld-confidence-layout"><div className="ld-confidence-ring" style={{ background: `conic-gradient(${parts.map((part, index) => { const before = parts.slice(0, index).reduce((sum, value) => sum + value.count, 0); const after = before + part.count; return `${part.color} ${before / total * 100}% ${after / total * 100}%`; }).join(", ")})` }}><div><strong>{total}</strong><span>topics</span></div></div><div className="ld-confidence-legend">{parts.map((part) => <div key={part.label}><i style={{ background: part.color }} /><span>{part.label}</span><strong>{part.count}</strong></div>)}</div></div>{topicConfidenceExpanded && <div className="ld-confidence-details"><div className="ld-confidence-rules"><div><strong><i style={{ background: "#fb7185" }} />Needs review</strong><p>Below 50% accuracy. Revisit the explanation and practice the underlying concept.</p></div><div><strong><i style={{ background: "#fbbf24" }} />Developing</strong><p>50–79% accuracy. Understanding may be partial or inconsistent; continue practice.</p></div><div><strong><i style={{ background: "#34d399" }} />Strong evidence</strong><p>80% or higher. This is a performance signal, not a guarantee of mastery.</p></div></div><div className="ld-confidence-evidence-note">{limited} of {total} topic{total === 1 ? " has" : "s have"} fewer than 5 recorded answers. Treat those classifications as preliminary; accuracy alone cannot prove mastery.</div><div className="ld-confidence-topic-list">{[...topics].sort((a, b) => learningAccuracy(a.accuracy) - learningAccuracy(b.accuracy)).map((item, index) => { const accuracy = Math.max(0, Math.min(100, Math.round(learningAccuracy(item.accuracy) * 100))); const status = accuracy < 50 ? "Needs review" : accuracy < 80 ? "Developing" : "Strong evidence"; const limitedEvidence = (item.attempts || 0) < 5; return <div className="ld-confidence-topic-row" key={`${item.concept}-confidence-${index}`}><div className="ld-confidence-topic-meta"><strong>{item.concept}</strong><span>{item.attempts || 0} answered · {accuracy}% accuracy</span></div><div className="ld-ranked-track"><span className={`ld-ranked-fill ${accuracy < 50 ? "ld-ranked-fill-low" : accuracy < 80 ? "ld-ranked-fill-mid" : "ld-ranked-fill-high"}`} style={{ width: `${accuracy}%` }} /></div><div className="ld-confidence-topic-status"><span>{limitedEvidence ? "Limited evidence · " : ""}{status}</span></div></div>; })}</div><div className="ld-confidence-collapse-row"><button type="button" className="outline-button" onClick={() => setTopicConfidenceExpanded(false)}>Collapse details ↑</button></div></div>}</>; })()}
                      </section>
                      <section className="ld-chart-card ld-investigation-card">
                        <div className="ld-card-heading"><div><span className="ld-eyebrow">LECTURE FRICTION</span><h4>Replay hotspots</h4><p>Lecture moments revisited more than once. Replay activity is a signal, not proof of confusion.</p></div><span className="ld-chart-icon"><Play size={17} /></span></div>
                        {(() => { const segments = [...(learningProfile?.replayed_segments || [])].sort((a, b) => a.seconds - b.seconds).slice(0, 6); const max = Math.max(1, ...segments.map((item) => item.replay_events)); return segments.length === 0 ? <div className="ld-chart-empty"><strong>No replay hotspots recorded</strong><p>As replay activity is recorded, this view will highlight timestamps worth revisiting.</p></div> : <div className="ld-friction-list">{segments.map((item) => <button className="ld-friction-row" key={item.seconds} onClick={() => seekToSeconds(item.seconds)}><span className="ld-friction-time">{formatTime(item.seconds)}</span><span className="ld-friction-track"><i style={{ width: `${Math.max(8, item.replay_events / max * 100)}%` }} /></span><strong>{item.replay_events}×</strong><ArrowRight size={14} /></button>)}</div>; })()}
                      </section>
                    </section>
                    <section className="ld-recommendation-card">
                      <div className="ld-recommendation-icon"><Sparkles size={20} /></div>
                      <div className="ld-recommendation-copy"><span className="ld-eyebrow">SUGGESTED NEXT ACTION</span>
                        {(() => { const weakest = [...(learningProfile?.concepts || [])].sort((a, b) => learningAccuracy(a.accuracy) - learningAccuracy(b.accuracy))[0]; const replay = learningProfile?.replayed_segments?.[0]; const step = learningPath[0]; if (weakest) return <><h4>Review {weakest.concept}</h4><p>Your recorded accuracy is {Math.round(learningAccuracy(weakest.accuracy) * 100)}% across {weakest.attempts} {weakest.attempts === 1 ? "attempt" : "attempts"}. Revisit the explanation, then use Quiz to check whether it is clearer.</p></>; if (replay) return <><h4>Revisit {formatTime(replay.seconds)}</h4><p>This timestamp has repeated backward replays. That may indicate a useful place to review, but replay alone does not prove confusion.</p></>; return <><h4>Build your first learning signal</h4><p>Answer a lecture quiz so LectureMate can begin tracking topic performance and topic-level patterns.</p></>; })()}
                        <div className="ld-recommendation-actions"><button className="outline-button" disabled={!learningPath.length && !(learningProfile?.replayed_segments || []).length} onClick={() => seekToSeconds(learningPath[0]?.seconds ?? learningProfile?.replayed_segments?.[0]?.seconds ?? 0)}><Play size={13} /> Review lecture</button><button className="outline-button" onClick={() => { const concept = learningProfile?.struggling_concepts?.[0]?.concept || learningProfile?.concepts?.slice().sort((a, b) => learningAccuracy(a.accuracy) - learningAccuracy(b.accuracy))[0]?.concept || "this topic"; setChatInput(`Explain "${concept}" from this lecture step by step, using a simple example and the most relevant timestamp.`); notify("Added a focused explanation prompt to chat"); }}>Ask tutor</button><button className="primary-button small-primary" onClick={() => { setQuizMode("personalized"); setPersonalizedQuizEnabled(true); setTab("Quiz"); }}>Open Quiz <ArrowRight size={14} /></button></div>
                      </div>
                    </section>

                    <p className="learning-detective-footnote">Insights are private to your account. Quiz results are measured evidence; topic scores come from saved quiz answers, and replay counts are signals rather than proof of confusion.</p>
                  </>}
                </div>}

              </div>

              <aside className="chat-panel">
                <div className="chat-header">
                  <div className="chat-title-icon"><WandSparkles size={17} /></div>
                  <div className="chat-title-copy"><h3>Ask your lecture</h3><p><span className="status-dot" /> Context-aware tutor</p></div>
                  <button className={`icon-button small ${showSavedAnswers ? "active" : ""}`} onClick={() => setShowSavedAnswers(v => !v)} aria-label={showSavedAnswers ? "Back to chat" : "Show saved answers"} title={showSavedAnswers ? "Back to chat" : "Saved answers"}><Bookmark size={16} /></button><button className="icon-button small" onClick={() => setMessages([])} aria-label="Clear conversation"><MoreHorizontal size={19} /></button>
                </div>
                {showSavedAnswers ? <div className="saved-answers-fullscreen">
                  <div className="saved-answers-fullscreen-heading"><div><h3>Saved answers</h3><p>{activeBackendVideo?.title ?? "Select a lecture"} · {savedAnswers.length} saved</p></div><button className="outline-button" onClick={() => setShowSavedAnswers(false)}>← Back to chat</button></div>
                  <div className="saved-answers-fullscreen-list">{activeVideoId === null ? <p className="saved-answers-empty">Select a lecture to view its saved answers.</p> : savedAnswers.length === 0 ? <p className="saved-answers-empty">No saved answers for this lecture yet. Return to chat and bookmark a completed answer.</p> : savedAnswers.map((item, i) => <article className="saved-answer-item saved-answer-full-item" key={`${item.savedAt}-${i}`}><strong>{item.question}</strong><p>{item.answer}</p><small>{new Date(item.savedAt).toLocaleString()}</small></article>)}</div>
                </div> : <>
                <div className="chat-context"><Video size={15} /><span>Using <strong>{activeBackendVideo?.title ?? "No lecture selected"}</strong></span><ChevronDown size={14} /></div>
                {activeFolder && <div className={`folder-context ${folderChatActive ? "on" : "off"}`}>
                  <Folder size={13} />
                  <span>{folderVideoCount > 1
                    ? (folderChatActive ? <>Chatting across <strong>{folderVideoCount} lectures</strong> in “{activeFolder.name}”</> : <>Folder context off. Using this lecture only.</>)
                    : <>“{activeFolder.name}” has only this lecture. Add more to chat across them.</>}</span>
                  {folderVideoCount > 1 && <button type="button" role="switch" aria-checked={useFolderContext} className="folder-switch" onClick={() => setUseFolderContext((value) => !value)} title={useFolderContext ? "Turn off folder context" : "Use all lectures in this folder"}><i /></button>}
                </div>}
                <div className="chat-messages">
                  {messages.length === 0 && <div className="chat-empty"><div className="empty-sparkle"><Sparkles size={22} /></div><h4>What would you like to understand?</h4><p>Ask about a concept, a confusing moment, or request an example.</p></div>}
                  {messages.map((message, index) => !(isAsking && message.role === "assistant" && !message.text.trim()) && <div key={`${index}-${message.role}`} className={`message ${message.role}`}>
                    {message.role === "assistant" && <div className="assistant-avatar"><Sparkles size={13} /></div>}
                    <div className="message-content">
                      {message.role === "assistant" && <div className="message-label">LECTUREMATE <span>· AI TUTOR</span></div>}
                      <div className="message-bubble"><RichMessageText text={message.text} /></div>
                      {message.role === "assistant" && message.text.trim() && !isAsking && <button className="save-answer-inline" onClick={() => { const question = [...messages.slice(0, index)].reverse().find(m => m.role === "user")?.text || "Lecture question"; saveAnswer(question, message.text); }}><Bookmark size={13} /> Save answer</button>}
                      {message.sources?.length ? <div className="source-chips">{message.sources.map((source) => {
                        // A passage from a different lecture in the folder opens that lecture at the right moment.
                        const other = typeof source.video_id === "number" && source.video_id !== activeVideoId;
                        return <button key={`${source.video_id ?? ""}-${source.source_type || "transcript"}-${source.seconds}-${source.text}`} className={`source-chip ${other ? "source-chip-other" : ""}`} title={other ? `Open “${source.video_title || "another lecture"}” at ${formatTime(source.seconds)}` : undefined} onClick={() => other ? openVideoAt(source.video_id as number, source.seconds) : seekToTimestamp(formatTime(source.seconds))}><Play size={10} fill="currentColor" /> {other ? <><span className="source-chip-title">{source.video_title || "Another lecture"}</span> · {formatTime(source.seconds)}</> : <>{source.source_type === "visual" ? "Visual" : "Transcript"} · {formatTime(source.seconds)}</>}</button>;
                      })}</div> : message.time && <button className="source-chip" onClick={() => seekToTimestamp(message.time!)}><Play size={10} fill="currentColor" /> Source · {message.time}</button>}
                    </div>
                  </div>)}
                  {isAsking && <div className="thinking-bubble" role="status" aria-label="Thinking"><span>Thinking</span><span className="thinking-dots"><i /><i /><i /></span></div>}
                </div>
                <div className="suggested-questions" aria-label="Suggested questions">
                  <button disabled={autoTranscribeBusy} onClick={() => setChatInput("Explain this like I'm a beginner")}>Explain simply</button>
                  <button disabled={autoTranscribeBusy} onClick={() => setChatInput("Give me a real-world example")}>Real-world example</button>
                  <button disabled={autoTranscribeBusy} onClick={() => setChatInput(`Summarize the key idea at ${selectedTime}`)}>This moment</button>
                </div>
                <div className="chat-composer">
                  <div className="answer-mode-row"><label htmlFor="answer-mode">Answer style</label><select id="answer-mode" className="answer-mode-select" value={answerMode} onChange={(e) => setAnswerMode(e.target.value as AnswerMode)}><option value="quick">Quick · concise</option><option value="learn">Learn · examples</option><option value="exam">Exam prep · key points</option><option value="deep">Deep · step by step</option></select></div>
                  {visualAnalysis && attachVisualToChat && <div className="slide-context-chip"><Video size={13} /><span>Slide context · {formatTime(visualTimestamp)} (one question)</span><button type="button" onClick={() => { setAttachVisualToChat(false); setVisualAnalysis(""); notify("Slide context cleared"); }} aria-label="Clear current slide context" title="Clear slide context"><X size={13} /></button></div>}
                  <div className="composer-input-row">
                    <button className={`composer-plus ${attachVisualToChat ? "active" : ""}`} type="button" onClick={() => { void analyzeVisuals(); }} disabled={visualBusy || autoTranscribeBusy || isAsking || !activeBackendVideo} aria-label="Understand current slide" title={visualBusy ? "Understanding current slide…" : "Understand current slide and attach context"}>{visualBusy ? <span className="send-spinner" /> : <Plus size={19} />}</button>
                    <textarea value={chatInput} disabled={autoTranscribeBusy} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }} placeholder={autoTranscribeBusy ? "Chat will be available when transcription finishes…" : visualBusy ? "Understanding this slide…" : folderChatActive && activeFolder ? `Ask about this lecture or any in “${activeFolder.name}”...` : "Ask anything about this lecture..."} rows={2} />
                  </div>
                  <div className="composer-bottom"><span><span className="keyboard-key">↵</span> to send · Shift + ↵ for new line</span><button className="send-button" onClick={sendMessage} disabled={!chatInput.trim() || isAsking || autoTranscribeBusy || visualBusy} aria-label="Send message">{isAsking ? <span className="send-spinner" /> : <Send size={16} />}</button></div>
                </div>
                <div className="chat-disclaimer"><Sparkles size={11} /> AI via {llmSettings.provider === "gemini" ? "Gemini" : llmSettings.provider === "groq" ? "Groq" : "local Ollama"} · searches transcript and saved lecture knowledge</div>
                </>}

              </aside>
            </section>
          ) : (
            <section className="empty-library">
              <div className="empty-library-icon"><Headphones size={27} /></div><h2>Your learning space starts here</h2><p>Add a lecture to ask questions, explore the transcript, and turn tricky concepts into clear explanations.</p><button className="primary-button" onClick={() => setShowSourceModal(true)}>Add your first lecture <ArrowRight size={16} /></button>
            </section>
          )}

          <footer className="page-footer"><span>Made for curious minds.</span><span><span className="footer-dot" /> Local development <span className="footer-divider">·</span> Saved videos and notes use SQLite</span></footer>
        </div>
      </main>

      {autoTranscribeBusy && <div className="transcription-progress-backdrop" role="dialog" aria-modal="true" aria-live="polite" aria-label="Transcribing video">
        <div className="transcription-progress-card">
          <div className="transcription-progress-icon"><WandSparkles size={24} /></div>
          <div className="eyebrow compact">LECTUREMATE AI</div>
          <h2>Preparing your lecture</h2>
          <p>{transcriptProgress < 20 ? (activeBackendVideo?.url.includes("youtube.com") || activeBackendVideo?.url.includes("youtu.be") ? "Checking for existing YouTube captions…" : "Getting the audio ready…") : transcriptProgress < 75 ? "Preparing transcript… Whisper runs only if captions are unavailable." : "Finishing transcript and preparing it for chat…"}</p>
          <div className="transcription-progress-number">{Math.floor(transcriptProgress)}<span>%</span></div>
          <div className="transcription-progress-track"><div className="transcription-progress-fill" style={{ width: `${transcriptProgress}%` }} /></div>
          <div className="transcription-progress-foot"><span><span className="thinking-spinner" /> This can take a few minutes for long videos</span><button type="button" className="transcription-cancel-button" onClick={cancelTranscription}>Cancel loading</button></div>
          <small>Progress is an estimate; Whisper runs locally and confirms completion when the transcript is saved.</small>
        </div>
      </div>}

      {showSourceModal && <div className="modal-backdrop" onClick={() => setShowSourceModal(false)}>
        <div className="source-modal" onClick={(e) => e.stopPropagation()}>
          <button className="modal-close icon-button" onClick={() => setShowSourceModal(false)} aria-label="Close"><X size={18} /></button>
          <div className="modal-icon"><Link2 size={22} /></div><h2>Add a video to LectureMate</h2><p>Save a video link to your LectureMate library. Saving the link does not yet download the video or generate its transcript.</p>
          <label htmlFor="modal-video-url">Video URL</label><input id="modal-video-url" className="modal-input" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." />
          <div className="modal-actions"><button className="outline-button" onClick={() => setShowSourceModal(false)}>Cancel</button><button className="primary-button" disabled={apiBusy} onClick={handleLoadVideo}>{apiBusy ? "Saving..." : "Save video"} <ArrowRight size={15} /></button></div>
          <div className="modal-footnote"><CircleHelp size={14} /> Add a lecture link or upload a video to get started.</div>
        </div>
      </div>}
      {showTranscriptModal && <div className="modal-backdrop" onClick={() => setShowTranscriptModal(false)}>
        <div className="source-modal transcript-modal" onClick={(e) => e.stopPropagation()}>
          <button className="modal-close icon-button" onClick={() => setShowTranscriptModal(false)} aria-label="Close"><X size={18} /></button>
          <div className="modal-icon"><FileText size={22} /></div><h2>Import a transcript</h2>
          <p>Paste subtitle text in <strong>.srt</strong> or <strong>.vtt</strong> format. Each subtitle cue becomes a timestamped segment stored for this video.</p>
          <label htmlFor="transcript-text">Transcript content</label>
          <textarea id="transcript-text" className="transcript-draft" value={transcriptDraft} onChange={(e) => setTranscriptDraft(e.target.value)} placeholder={'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWelcome to this lecture.\n\n00:00:04.000 --> 00:00:08.000\nToday we will learn about neural networks.'} />
          <div className="modal-actions"><button className="outline-button" onClick={() => setShowTranscriptModal(false)}>Cancel</button><button className="primary-button" disabled={transcriptBusy} onClick={importTranscript}>{transcriptBusy ? "Importing..." : "Import transcript"} <ArrowRight size={15} /></button></div>
          <div className="modal-footnote"><CircleHelp size={14} /> Use subtitles you have permission to access. This does not download the video.</div>
        </div>
      </div>}
      {showLLMModal && <div className="modal-backdrop" onClick={() => setShowLLMModal(false)}>
        <div className="source-modal llm-modal" onClick={(e) => e.stopPropagation()}>
          <button className="modal-close icon-button" onClick={() => setShowLLMModal(false)} aria-label="Close"><X size={18} /></button>
          <div className="modal-icon"><Settings2 size={22} /></div><h2>AI model settings</h2>
          <p>Choose Gemini, Groq, or a local Ollama model. API keys are stored separately for each signed-in account and are never returned in API responses.</p>
          <label htmlFor="llm-provider">AI provider</label>
          <select id="llm-provider" className="modal-input" value={llmSettings.provider} onChange={(e) => setLlmSettings((current) => ({ ...current, provider: e.target.value as LLMProvider }))}>
            <option value="gemini">Google Gemini API</option><option value="groq">Groq API</option><option value="ollama">Local model via Ollama</option>
          </select>
          {llmSettings.provider === "gemini" ? <>
            <label htmlFor="gemini-key" className="llm-label-spaced">Gemini API key {llmSettings.gemini_api_key_configured ? "(already saved — leave blank to keep it)" : ""}</label>
            <input id="gemini-key" className="modal-input" type="password" autoComplete="new-password" value={geminiApiKey} onChange={(e) => setGeminiApiKey(e.target.value)} placeholder={llmSettings.gemini_api_key_configured ? "Saved key is hidden" : "Paste your Gemini API key"} />
            <label htmlFor="gemini-model" className="llm-label-spaced">Gemini model</label>
            <input id="gemini-model" className="modal-input" value={llmSettings.gemini_model} onChange={(e) => setLlmSettings((current) => ({ ...current, gemini_model: e.target.value }))} placeholder="gemini-flash-latest" />
            <div className="modal-footnote"><CircleHelp size={14} /> Get a key in Google AI Studio. API usage may be subject to quotas or charges.</div>
          </> : llmSettings.provider === "groq" ? <>
            <label htmlFor="groq-key" className="llm-label-spaced">Groq API key {llmSettings.groq_api_key_configured ? "(already saved — leave blank to keep it)" : ""}</label>
            <input id="groq-key" className="modal-input" type="password" autoComplete="new-password" value={groqApiKey} onChange={(e) => setGroqApiKey(e.target.value)} placeholder={llmSettings.groq_api_key_configured ? "Saved key is hidden" : "Paste your Groq API key"} />
            <label htmlFor="groq-model" className="llm-label-spaced">Groq model</label>
            <input id="groq-model" className="modal-input" value={llmSettings.groq_model} onChange={(e) => setLlmSettings((current) => ({ ...current, groq_model: e.target.value }))} placeholder="openai/gpt-oss-20b" />
            <div className="modal-footnote"><CircleHelp size={14} /> Create a key in the Groq Console. Availability and rate limits depend on your Groq account.</div>
          </> : <>
            <label htmlFor="ollama-model" className="llm-label-spaced">Installed Ollama model name</label>
            <input id="ollama-model" className="modal-input" value={llmSettings.ollama_model} onChange={(e) => setLlmSettings((current) => ({ ...current, ollama_model: e.target.value }))} placeholder="llama3 or llama3:latest" />
            <label htmlFor="ollama-vision-model" className="llm-label-spaced">Vision model for screenshots</label>
            <input id="ollama-vision-model" className="modal-input" value={llmSettings.ollama_vision_model} onChange={(e) => setLlmSettings((current) => ({ ...current, ollama_vision_model: e.target.value }))} placeholder="qwen2.5vl:3b" />
            <div className="modal-footnote"><CircleHelp size={14} /> This is separate from your chat model. Your existing text model remains in use for transcript chat.</div>
            <label htmlFor="ollama-url" className="llm-label-spaced">Ollama server URL</label>
            <input id="ollama-url" className="modal-input" value={llmSettings.ollama_base_url} onChange={(e) => setLlmSettings((current) => ({ ...current, ollama_base_url: e.target.value }))} placeholder="http://127.0.0.1:11434" />
            <div className="modal-footnote"><CircleHelp size={14} /> Use the exact name shown by <code>ollama list</code>, such as <code>llama3</code> or <code>llama3:latest</code>.</div>
          </>}
          <div className="modal-actions"><button className="outline-button" onClick={() => setShowLLMModal(false)}>Close</button><button className="outline-button" disabled={llmBusy} onClick={testLLMConnection}>{llmBusy ? "Testing..." : "Save & test"}</button><button className="primary-button" disabled={llmBusy} onClick={saveLLMSettings}>{llmBusy ? "Saving..." : "Save settings"}</button></div>
        </div>
      </div>}
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
    </div>
  );
}

export default App;
