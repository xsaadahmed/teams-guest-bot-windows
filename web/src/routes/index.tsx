import { createFileRoute } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  Pause,
  Play,
  Square,
  X,
  Minus,
  ChevronUp,
  Info,
  CheckCircle2,
  Home,
  Mic,
  FileText,
  Folder,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Loader2,
  Download,
} from "lucide-react";
import {
  fetchTranscript,
  getBotStatus,
  joinMeeting,
  leaveMeeting,
  listRecordings,
  listTranscripts,
  pauseRecording,
  resumeRecording,
  positionUiWindow,
  recordingDownloadUrl,
  recordingPlayUrl,
  type RecordingItem,
  type TranscriptItem,
} from "../lib/bot-api";

export const Route = createFileRoute("/")({
  component: Index,
});

type Page = "home" | "recording" | "notes" | "recordings" | "info";

const OVERLAY_EXPANDED = { width: 280, height: 210 };
const OVERLAY_COLLAPSED = { width: 280, height: 72 };
const OVERLAY_MARGIN = { left: 8, bottom: 8 };

type WindowGeometry = { width: number; height: number; x: number; y: number };

function captureWindowGeometry(): WindowGeometry {
  return {
    width: window.outerWidth,
    height: window.outerHeight,
    x: window.screenX,
    y: window.screenY,
  };
}

function applyWindowGeometry(g: WindowGeometry) {
  try {
    window.resizeTo(g.width, g.height);
    window.moveTo(g.x, g.y);
  } catch {
    // ignore
  }
}

function placeOverlayWindow(collapsed: boolean) {
  const size = collapsed ? OVERLAY_COLLAPSED : OVERLAY_EXPANDED;
  try {
    window.resizeTo(size.width, size.height);
    window.moveTo(
      OVERLAY_MARGIN.left,
      Math.max(0, window.screen.availHeight - size.height - OVERLAY_MARGIN.bottom),
    );
  } catch {
    // ignore
  }
  void positionUiWindow({
    ...size,
    left: OVERLAY_MARGIN.left,
    bottom: OVERLAY_MARGIN.bottom,
    topmost: true,
  }).catch(() => undefined);
}

function Index() {
  const [collapsed, setCollapsed] = useState(true);
  const [page, setPage] = useState<Page>("home");
  const [overlayOnly, setOverlayOnly] = useState(false);
  const recorder = useRecorder();
  const savedGeometry = useRef<WindowGeometry | null>(null);
  const pendingOverlay = useRef(false);

  useEffect(() => {
    if (recorder.mode !== "recording" || !pendingOverlay.current) return;

    const t = window.setTimeout(() => {
      pendingOverlay.current = false;
      if (!savedGeometry.current) {
        savedGeometry.current = captureWindowGeometry();
      }
      setOverlayOnly(true);
      placeOverlayWindow(false);
    }, 1500);

    return () => window.clearTimeout(t);
  }, [recorder.mode]);

  useEffect(() => {
    if (overlayOnly && (recorder.mode === "idle" || recorder.mode === "saved")) {
      setOverlayOnly(false);
      void positionUiWindow({
        width: savedGeometry.current?.width ?? 1100,
        height: savedGeometry.current?.height ?? 720,
        topmost: false,
        left: savedGeometry.current?.x ?? 80,
        bottom: 80,
      }).catch(() => undefined);
      if (savedGeometry.current) {
        applyWindowGeometry(savedGeometry.current);
        savedGeometry.current = null;
      }
    }
  }, [recorder.mode, overlayOnly]);

  const joinAndPrepareOverlay = async () => {
    pendingOverlay.current = true;
    const ok = await recorder.join();
    if (!ok) pendingOverlay.current = false;
  };

  const value = { ...recorder, join: joinAndPrepareOverlay };

  if (overlayOnly) {
    return (
      <RecorderContext.Provider value={value}>
        <div className="min-h-screen w-full bg-transparent overflow-hidden">
          <MeetingAssistantWindow
            forceVisible
            highest
            onChromeCollapseChange={(miniCollapsed) => placeOverlayWindow(miniCollapsed)}
          />
        </div>
      </RecorderContext.Provider>
    );
  }

  return (
    <RecorderContext.Provider value={value}>
      <div className="min-h-screen w-full flex bg-background text-foreground">
        <Sidebar
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          page={page}
          setPage={setPage}
        />
        <main className="flex-1 overflow-auto">
          {page === "home" && <HomePage setPage={setPage} />}
          {page === "recording" && <RecordingPage />}
          {page === "notes" && <NotesPage />}
          {page === "recordings" && <RecordingsPage />}
          {page === "info" && <AboutPage />}
        </main>

        <MeetingAssistantWindow />
      </div>
    </RecorderContext.Provider>
  );
}

/* ---------------- Sidebar ---------------- */

function Sidebar({
  collapsed,
  setCollapsed,
  page,
  setPage,
}: {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  page: Page;
  setPage: (p: Page) => void;
}) {
  const items: { id: Page; label: string; icon: React.ReactNode; accent?: "record" }[] = [
    { id: "home", label: "Home", icon: <Home className="w-5 h-5" /> },
    {
      id: "recording",
      label: "Record",
      icon: <Mic className="w-5 h-5" />,
      accent: "record",
    },
    { id: "notes", label: "Meeting Notes", icon: <FileText className="w-5 h-5" /> },
    { id: "recordings", label: "Recordings", icon: <Folder className="w-5 h-5" /> },
  ];

  return (
    <aside
      className={`shrink-0 border-r border-border bg-card flex flex-col transition-all duration-200 ${
        collapsed ? "w-14" : "w-56"
      }`}
    >
      <div className="flex items-center justify-between p-3 border-b border-border">
        {!collapsed && (
          <span className="text-sm font-semibold truncate">e& Assistant</span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1 rounded hover:bg-accent ml-auto"
          aria-label="Toggle sidebar"
        >
          {collapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <ChevronLeft className="w-4 h-4" />
          )}
        </button>
      </div>

      <nav className="flex-1 p-2 space-y-1">
        {items.map((it) => {
          const active = page === it.id;
          const isRecord = it.accent === "record";
          return (
            <button
              key={it.id}
              onClick={() => setPage(it.id)}
              className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-sm transition-colors ${
                isRecord
                  ? active
                    ? "bg-red-600 text-white shadow-sm"
                    : "bg-red-500 text-white hover:bg-red-600"
                  : active
                    ? "bg-accent text-foreground"
                    : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              title={collapsed ? it.label : undefined}
            >
              <span className={isRecord ? "text-white" : ""}>{it.icon}</span>
              {!collapsed && <span className="truncate font-medium">{it.label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="p-2 border-t border-border">
        <button
          onClick={() => setPage("info")}
          className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-sm transition-colors ${
            page === "info"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
          title={collapsed ? "About" : undefined}
        >
          <Info className="w-5 h-5" />
          {!collapsed && <span>About</span>}
        </button>
      </div>
    </aside>
  );
}

/* ---------------- Home ---------------- */

function HomePage({ setPage }: { setPage: (p: Page) => void }) {
  const cards: {
    id: Page;
    title: string;
    desc: string;
    icon: React.ReactNode;
    accent?: string;
  }[] = [
    {
      id: "recording",
      title: "Record",
      desc: "Start a new meeting recording",
      icon: <Mic className="w-6 h-6" />,
      accent: "text-red-500 bg-red-500/10",
    },
    {
      id: "notes",
      title: "Meeting Notes",
      desc: "Review AI-generated notes",
      icon: <FileText className="w-6 h-6" />,
      accent: "text-primary bg-primary/10",
    },
    {
      id: "recordings",
      title: "Recordings",
      desc: "Browse past recordings",
      icon: <Folder className="w-6 h-6" />,
      accent: "text-amber-600 bg-amber-500/10",
    },
  ];

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Welcome to e& Meeting Assistant</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Choose an option to get started.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((c) => (
          <button
            key={c.id}
            onClick={() => setPage(c.id)}
            className="text-left p-5 rounded-xl border border-border bg-card hover:shadow-md hover:border-primary/40 transition-all group"
          >
            <div
              className={`inline-flex items-center justify-center w-11 h-11 rounded-lg mb-4 ${c.accent}`}
            >
              {c.icon}
            </div>
            <div className="text-base font-semibold">{c.title}</div>
            <div className="text-xs text-muted-foreground mt-1">{c.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Recording page (full) ---------------- */

function RecordingPage() {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Record</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste a Teams meeting URL to join and record.
        </p>
      </div>
      <div className="rounded-xl border border-border bg-card p-6">
        <RecorderPanel size="large" />
      </div>
    </div>
  );
}

function AboutPage() {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold">About</h1>
      <p className="text-sm text-muted-foreground mt-1">e&amp; Meeting Assistant — Teams guest bot</p>
      <div className="mt-6 rounded-xl border border-border bg-card p-6 space-y-3 text-sm">
        <p>
          Joins Microsoft Teams meetings as a guest, records audio, and captures live captions into
          speaker-labeled meeting notes.
        </p>
        <p className="text-muted-foreground">
          Backend runs locally on port 3000. Start with <code className="text-xs bg-muted px-1 rounded">Start-Bot.cmd</code>.
        </p>
      </div>
    </div>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(d: string) {
  return new Date(d).toLocaleString();
}

function NotesPage() {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [textByFile, setTextByFile] = useState<Record<string, string>>({});
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<{ fileName: string; message: string } | null>(null);

  useEffect(() => {
    listTranscripts()
      .then(setItems)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const toggleView = async (fileName: string) => {
    if (expanded === fileName) {
      setExpanded(null);
      setLoadError(null);
      return;
    }

    setExpanded(fileName);
    setLoadError(null);
    if (textByFile[fileName]) return;

    setLoadingFile(fileName);
    try {
      const text = await fetchTranscript(fileName);
      setTextByFile((prev) => ({ ...prev, [fileName]: text }));
    } catch (e) {
      setLoadError({ fileName, message: (e as Error).message });
    } finally {
      setLoadingFile(null);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Meeting Notes</h1>
        <p className="text-sm text-muted-foreground mt-1">Speaker-labeled transcripts from your recordings.</p>
      </div>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center text-sm text-muted-foreground">
          No meeting notes yet. Record a meeting first.
        </div>
      )}
      <div className="space-y-2">
        {items.map((t) => {
          const isOpen = expanded === t.fileName;
          return (
            <div key={t.fileName} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{t.title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{t.type} · {formatDate(t.lastModified)}</div>
                </div>
                <button
                  className="shrink-0 inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md border border-input hover:bg-accent"
                  onClick={() => void toggleView(t.fileName)}
                  aria-expanded={isOpen}
                >
                  {isOpen ? "Hide" : "View"}
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
              </div>
              {isOpen && (
                <div className="border-t border-border bg-muted/20">
                  {loadingFile === t.fileName && (
                    <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading transcript…
                    </div>
                  )}
                  {loadError?.fileName === t.fileName && loadingFile !== t.fileName && (
                    <p className="px-4 py-3 text-sm text-destructive">{loadError.message}</p>
                  )}
                  {textByFile[t.fileName] && (
                    <pre className="p-4 text-xs overflow-auto max-h-96 whitespace-pre-wrap font-mono">
                      {textByFile[t.fileName]}
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecordingsPage() {
  const [items, setItems] = useState<RecordingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    listRecordings()
      .then(setItems)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Recordings</h1>
        <p className="text-sm text-muted-foreground mt-1">Play recordings in the browser or download WAV files.</p>
      </div>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center text-sm text-muted-foreground">
          No recordings yet.
        </div>
      )}
      <div className="space-y-2">
        {items.map((r) => {
          const isOpen = expanded === r.fileName;
          return (
            <div key={r.fileName} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{r.fileName}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{formatBytes(r.sizeBytes)} · {formatDate(r.lastModified)}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    className="inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md border border-input hover:bg-accent"
                    onClick={() => setExpanded(isOpen ? null : r.fileName)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? "Hide" : "Play"}
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </button>
                  <a
                    href={recordingDownloadUrl(r.fileName)}
                    download
                    className="inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md border border-input hover:bg-accent"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </a>
                </div>
              </div>
              {isOpen && (
                <div className="border-t border-border bg-muted/20 px-4 py-4">
                  <audio
                    controls
                    autoPlay
                    preload="metadata"
                    className="w-full"
                    src={recordingPlayUrl(r.fileName)}
                  >
                    Your browser does not support audio playback.
                  </audio>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Recorder logic (shared via context) ---------------- */

type Mode = "idle" | "joining" | "recording" | "saving" | "saved";

type RecorderValue = ReturnType<typeof useRecorder>;

const RecorderContext = createContext<RecorderValue | null>(null);

function useRecorderContext() {
  const ctx = useContext(RecorderContext);
  if (!ctx) throw new Error("RecorderContext missing");
  return ctx;
}

function useRecorder() {
  const [url, setUrl] = useState("");
  const [accurate, setAccurate] = useState(() => localStorage.getItem("whisperPref") === "1");
  const [mode, setMode] = useState<Mode>("idle");
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [countdown, setCountdown] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [localMicLevel, setLocalMicLevel] = useState(0);
  const [localMicOpen, setLocalMicOpen] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const joinedAtRef = useRef<number | null>(null);

  useEffect(() => {
    localStorage.setItem("whisperPref", accurate ? "1" : "0");
  }, [accurate]);

  useEffect(() => {
    getBotStatus().then((s) => {
      if (s.state === "in_meeting" || s.state === "joining") {
        setMode("recording");
        if (s.joinedAt) joinedAtRef.current = new Date(s.joinedAt).getTime();
        if (s.meetingUrl) setUrl(s.meetingUrl);
      }
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (mode === "recording" && !paused) {
      intervalRef.current = setInterval(() => {
        if (joinedAtRef.current) {
          setSeconds(Math.floor((Date.now() - joinedAtRef.current) / 1000));
        } else {
          setSeconds((s) => s + 1);
        }
      }, 1000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [mode, paused]);

  // Keep mini/large recorder in sync with the bot — including auto-leave when alone.
  // Without this, mode stays "recording" after the backend has already left.
  useEffect(() => {
    if (mode !== "recording" && mode !== "saving" && mode !== "joining") {
      setAudioLevel(0);
      return;
    }
    const id = setInterval(() => {
      getBotStatus()
        .then((s) => {
          if (s.state === "leaving") {
            // Bot is tearing down (alone-timeout or meeting ended) — show Saving… not Recording.
            if (mode === "recording" || mode === "joining") {
              setPaused(false);
              setMode("saving");
            }
            setAudioLevel(0);
            return;
          }
          if (s.state === "idle" || s.state === "error") {
            if (mode === "recording" || mode === "saving" || mode === "joining") {
              joinedAtRef.current = null;
              setPaused(false);
              setAudioLevel(0);
              if (s.state === "error" && s.lastError) setError(s.lastError);
              setMode("saved");
            }
            return;
          }
          if (mode === "saving") return;
          if (typeof s.paused === "boolean") setPaused(s.paused);
          if (typeof s.localMicOpen === "boolean") setLocalMicOpen(s.localMicOpen);
          setAudioLevel(typeof s.audioLevel === "number" ? s.audioLevel : 0);
        })
        .catch(() => undefined);
    }, 200);
    return () => clearInterval(id);
  }, [mode]);

  // Local mic analyser for the sound wave when *you* speak (loopback alone never includes your voice).
  useEffect(() => {
    if (mode !== "recording" || paused) {
      setLocalMicLevel(0);
      return;
    }
    let stopped = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          if (stopped) return;
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const v = Math.abs(data[i] - 128) / 128;
            if (v > peak) peak = v;
          }
          setLocalMicLevel(peak);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // Mic permission denied — wave still uses server loopback level for remote speakers.
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      setLocalMicLevel(0);
    };
  }, [mode, paused]);

  useEffect(() => {
    if (mode !== "saved") return;
    setCountdown(10);
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(id);
          setMode("idle");
          setUrl("");
          setSeconds(0);
          joinedAtRef.current = null;
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [mode]);

  const join = async (): Promise<boolean> => {
    if (!url.trim()) return false;
    setError(null);
    setMode("joining");
    try {
      const status = await joinMeeting(url.trim(), "Meeting Bot");
      // Wait until backend reports in_meeting (join already awaits, but re-check once).
      let confirmed = status;
      if (confirmed.state !== "in_meeting") {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          confirmed = await getBotStatus();
          if (confirmed.state === "in_meeting") break;
          if (confirmed.state === "idle" || confirmed.state === "error") {
            throw new Error(confirmed.lastError || "Bot left before joining the meeting.");
          }
        }
        if (confirmed.state !== "in_meeting") {
          throw new Error("Timed out waiting for bot to join the meeting.");
        }
      }
      joinedAtRef.current = confirmed.joinedAt ? new Date(confirmed.joinedAt).getTime() : Date.now();
      setSeconds(0);
      setPaused(false);
      setMode("recording");
      return true;
    } catch (e) {
      setError((e as Error).message);
      setMode("idle");
      return false;
    }
  };

  const stop = async () => {
    setPaused(false);
    setMode("saving");
    setError(null);
    try {
      await leaveMeeting();
      joinedAtRef.current = null;
      setMode("saved");
    } catch (e) {
      setError((e as Error).message);
      setMode("recording");
    }
  };

  const togglePause = async () => {
    if (mode !== "recording") return;
    setError(null);
    try {
      const next = !paused;
      const status = next ? await pauseRecording() : await resumeRecording();
      setPaused(Boolean(status.paused));
      if (next) setAudioLevel(0);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return {
    url,
    setUrl,
    accurate,
    setAccurate,
    mode,
    paused,
    setPaused,
    togglePause,
    seconds,
    countdown,
    error,
    audioLevel: Math.max(audioLevel, localMicOpen ? localMicLevel : 0),
    join,
    stop,
  };
}

function format(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/* ---------------- Recorder Panel (used by both mini & large) ---------------- */

function RecorderPanel({ size = "mini" }: { size?: "mini" | "large" }) {
  const r = useRecorderContext();
  const [showTip, setShowTip] = useState(false);

  const large = size === "large";
  const labelText = large ? "text-sm" : "text-xs";
  const inputPad = large ? "px-3 py-2 text-sm" : "px-2.5 py-1.5 text-xs";
  const btnPad = large ? "py-2.5 text-sm" : "py-1.5 text-xs";

  return (
    <div className={large ? "space-y-5" : "space-y-3"}>
      {r.error && (
        <p className={`${labelText} text-destructive`}>{r.error}</p>
      )}

      {r.mode === "idle" && (
        <>
          <div className="space-y-1.5">
            <label className={`${labelText} font-medium text-foreground`}>
              Paste Meeting URL:
            </label>
            <input
              type="url"
              value={r.url}
              onChange={(e) => r.setUrl(e.target.value)}
              placeholder="https://teams.microsoft.com/..."
              className={`w-full ${inputPad} rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring`}
            />
          </div>

          <label className={`flex items-center gap-1.5 ${large ? "text-xs" : "text-[10px]"} text-foreground cursor-pointer select-none leading-none`}>
            <input
              type="checkbox"
              checked={r.accurate}
              onChange={(e) => r.setAccurate(e.target.checked)}
              className={`${large ? "w-3.5 h-3.5" : "w-3 h-3"} rounded border-input accent-primary shrink-0`}
            />
            <span className="leading-none">More Accurate Transcription</span>
            <span
              className="relative inline-flex items-center"
              onMouseEnter={() => setShowTip(true)}
              onMouseLeave={() => setShowTip(false)}
            >
              <Info className={large ? "w-3.5 h-3.5 text-muted-foreground" : "w-3 h-3 text-muted-foreground"} />
              {showTip && (
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-[220px] rounded-md bg-foreground text-background text-[10px] leading-snug px-2 py-1 shadow-lg z-10 text-center">
                  Will take longer to transcribe and generate summaries and use more RAM and CPU once the meeting ends
                </span>
              )}
            </span>
          </label>

          <button
            onClick={() => void r.join()}
            disabled={!r.url.trim()}
            className={`w-full ${btnPad} rounded-md bg-red-500 text-white font-medium hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-2`}
            aria-label="Start recording"
          >
            <span className={`inline-flex items-center justify-center rounded-full bg-white/20 ${large ? "w-6 h-6" : "w-5 h-5"}`}>
              <span className={`${large ? "w-2.5 h-2.5" : "w-2 h-2"} rounded-full bg-white`} />
            </span>
            <span>Record</span>
          </button>
        </>
      )}

      {r.mode === "joining" && (
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className={`${large ? "w-8 h-8" : "w-6 h-6"} animate-spin text-red-500`} />
          <span className={`${labelText} font-medium text-foreground`}>Joining meeting…</span>
          <span className={`${large ? "text-xs" : "text-[10px]"} text-muted-foreground text-center`}>This can take up to a minute.</span>
        </div>
      )}

      {(r.mode === "recording" || r.mode === "saving") && (
        <>
          <div className="flex items-center justify-center gap-2">
            {r.mode === "recording" ? (
              <>
                <span className="relative flex h-2.5 w-2.5">
                  {!r.paused && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                  )}
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                </span>
                <span className={`${labelText} font-medium text-foreground`}>
                  {r.paused ? "Paused" : "Recording in progress"}
                </span>
                <span className={`${labelText} text-muted-foreground`}>•</span>
                <span className={`${labelText} font-mono font-semibold text-foreground tabular-nums`}>
                  {format(r.seconds)}
                </span>
              </>
            ) : (
              <span className={`${labelText} font-medium text-foreground animate-pulse`}>
                Saving...
              </span>
            )}
          </div>

          <SoundWave
            active={r.mode === "recording" && !r.paused}
            level={r.audioLevel}
            large={large}
          />

          <div className="flex gap-2">
            <button
              onClick={() => void r.togglePause()}
              disabled={r.mode === "saving"}
              className={`flex-1 ${btnPad} rounded-md border border-input bg-background text-foreground hover:bg-accent transition-colors inline-flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed`}
              aria-label={r.paused ? "Resume" : "Pause"}
            >
              {r.paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            </button>
            <button
              onClick={() => void r.stop()}
              disabled={r.mode === "saving"}
              className={`flex-1 ${btnPad} rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors inline-flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed`}
              aria-label="Stop"
            >
              <Square className="w-4 h-4 fill-current" />
            </button>
          </div>
        </>
      )}

      {r.mode === "saved" && (
        <div className={`${large ? "space-y-4" : "space-y-3"} text-center py-2`}>
          <div className="flex justify-center">
            <CheckCircle2 className={large ? "w-14 h-14 text-green-500" : "w-10 h-10 text-green-500"} />
          </div>
          <div className="space-y-1">
            <div className={large ? "text-lg font-semibold text-foreground" : "text-sm font-semibold text-foreground"}>
              Recording Saved
            </div>
            <div className={large ? "text-xs text-muted-foreground" : "text-[11px] text-muted-foreground"}>
              Duration {format(r.seconds)}
            </div>
            <div className={large ? "text-xs text-muted-foreground" : "text-[11px] text-muted-foreground"}>
              Saved in Recordings tab
            </div>
          </div>
          <div className={large ? "text-xs text-muted-foreground" : "text-[11px] text-muted-foreground"}>
            Returning in <span className="font-mono font-semibold text-foreground">{r.countdown}s</span>
          </div>
          <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-1000 ease-linear"
              style={{ width: `${(r.countdown / 10) * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Floating mini window ---------------- */

function MeetingAssistantWindow({
  forceVisible = false,
  highest = false,
  onChromeCollapseChange,
}: {
  forceVisible?: boolean;
  highest?: boolean;
  onChromeCollapseChange?: (collapsed: boolean) => void;
}) {
  const [closed, setClosed] = useState(false);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    if (forceVisible) {
      setClosed(false);
      setMinimized(false);
    }
  }, [forceVisible]);

  const collapseCb = useRef(onChromeCollapseChange);
  collapseCb.current = onChromeCollapseChange;
  useEffect(() => {
    collapseCb.current?.(minimized);
  }, [minimized]);

  if (closed && !forceVisible) return null;

  return (
    <div
      className={
        highest
          ? "fixed inset-0 z-[9999] overflow-hidden bg-card"
          : "fixed bottom-4 left-4 z-50 w-[260px] rounded-xl overflow-hidden shadow-2xl border border-border bg-card"
      }
    >
      <div className="flex items-center justify-between px-3 py-2 bg-[#1f1f1f] text-white text-xs">
        <span className="font-medium truncate">e& Meeting Assistant</span>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setMinimized((m) => !m)}
            className="p-1 rounded hover:bg-white/10"
            aria-label={minimized ? "Expand" : "Minimize"}
            title={minimized ? "Expand" : "Minimize"}
          >
            {minimized ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <Minus className="w-3.5 h-3.5" />
            )}
          </button>
          {!forceVisible && (
            <button
              onClick={() => setClosed(true)}
              className="p-1 rounded hover:bg-white/10"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {!minimized && (
        <div className={`${highest ? "px-3 pb-3 pt-1" : "px-3 pb-3 pt-1"} bg-card`}>
          <RecorderPanel size="mini" />
        </div>
      )}
    </div>
  );
}

/* ---------------- Sound wave ---------------- */

function SoundWave({
  active,
  level = 0,
  large = false,
}: {
  active: boolean;
  level?: number;
  large?: boolean;
}) {
  const bars = large ? 40 : 24;
  // Soften/noise-gate quiet room noise so the wave stays flat until real speech.
  const gated = active ? Math.max(0, (level - 0.015) / 0.25) : 0;
  const strength = Math.min(1, gated);

  return (
    <div className={`flex items-center justify-center gap-[3px] ${large ? "h-16" : "h-10"} rounded-md bg-red-500/5 px-2`}>
      {Array.from({ length: bars }).map((_, i) => {
        const center = bars / 2;
        const dist = Math.abs(i - center) / center;
        const shape = 1 - dist * 0.55;
        const wobble = 0.65 + 0.35 * Math.sin(i * 0.9 + strength * 8);
        const heightPct = strength > 0.02 ? Math.max(8, Math.min(95, strength * shape * wobble * 100)) : 8;
        return (
          <span
            key={i}
            className="w-[3px] rounded-full bg-red-500"
            style={{
              height: `${heightPct}%`,
              opacity: strength > 0.02 ? 0.55 + strength * 0.45 : 0.35,
              transition: "height 80ms linear, opacity 120ms linear",
            }}
          />
        );
      })}
    </div>
  );
}
