import { createFileRoute } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Pause,
  Play,
  Square,
  X,
  Minus,
  ChevronUp,
  Settings,
  Info,
  CheckCircle2,
  Home,
  Mic,
  FileText,
  Folder,
  Loader2,
  Download,
  AlertCircle,
  Moon,
  Sun,
  Sparkles,
  Search,
  Upload,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchTranscript,
  fetchSummary,
  generateSummary,
  getBotConfig,
  getBotStatus,
  joinMeeting,
  leaveMeeting,
  listRecordings,
  listAvailableModels,
  listSummaries,
  listTranscripts,
  listTranscriptionEngines,
  pauseRecording,
  resumeRecording,
  positionUiWindow,
  recordingDownloadUrl,
  recordingPlayUrl,
  saveBotConfig,
  testLlmConnection,
  uploadTranscript,
  type RecordingItem,
  type SummaryItem,
  type TranscriptItem,
  type AvailableTranscriptionEngine,
  type TranscriptionEnginesResponse,
  type TranscriptionEngineId,
} from "../lib/bot-api";
import { applyTheme, resolveTheme, toggleTheme, type Theme } from "../lib/theme";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CopyButton } from "@/components/copy-button";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/")({
  component: Index,
});

type Page = "home" | "recording" | "notes" | "recordings" | "summaries" | "settings";

// Outer window size must fit Edge title bar + app chrome + recorder controls (tight).
const OVERLAY_EXPANDED = { width: 280, height: 188 };
const OVERLAY_COLLAPSED = { width: 280, height: 84 };
const OVERLAY_MARGIN = { left: 12, bottom: 12 };

type WindowGeometry = { width: number; height: number; x: number; y: number };

const DEFAULT_MAIN_GEOMETRY: WindowGeometry = { width: 1100, height: 720, x: 80, y: 80 };
const MIN_MAIN_WIDTH = 640;
const MIN_MAIN_HEIGHT = 480;
/** Soft minimum for the main app window — snaps back on resize (not a native OS constraint). */
const MIN_WINDOW_WIDTH = 800;

function startMainWindowMinWidthGuard(): () => void {
  let timer: number | null = null;

  const enforce = () => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      try {
        if (window.outerWidth < MIN_WINDOW_WIDTH) {
          window.resizeTo(MIN_WINDOW_WIDTH, window.outerHeight);
        }
      } catch {
        // resizeTo may be blocked in some environments.
      }
    }, 100);
  };

  window.addEventListener("resize", enforce);
  enforce();
  return () => {
    window.removeEventListener("resize", enforce);
    if (timer != null) window.clearTimeout(timer);
  };
}

function captureWindowGeometry(): WindowGeometry {
  return {
    width: window.outerWidth,
    height: window.outerHeight,
    x: window.screenX,
    y: window.screenY,
  };
}

function normalizeMainGeometry(g: WindowGeometry | null): WindowGeometry {
  if (!g || g.width < MIN_MAIN_WIDTH || g.height < MIN_MAIN_HEIGHT) {
    return {
      ...DEFAULT_MAIN_GEOMETRY,
      x: g && g.x > 0 ? g.x : DEFAULT_MAIN_GEOMETRY.x,
      y: g && g.y > 0 ? g.y : DEFAULT_MAIN_GEOMETRY.y,
    };
  }
  return g;
}

function overlayTargetRect(collapsed: boolean) {
  const size = collapsed ? OVERLAY_COLLAPSED : OVERLAY_EXPANDED;
  const availLeft = window.screen.availLeft ?? 0;
  const availTop = window.screen.availTop ?? 0;
  const availH = window.screen.availHeight;
  const left = availLeft + OVERLAY_MARGIN.left;
  const top = availTop + Math.max(0, availH - size.height - OVERLAY_MARGIN.bottom);
  return { ...size, left, top };
}

function applyBrowserMiniWindowGeometry(collapsed: boolean): void {
  const { width, height, left, top } = overlayTargetRect(collapsed);
  try {
    window.resizeTo(width, height);
    window.moveTo(left, top);
  } catch {
    // Some corporate browsers block resizeTo on the main app window.
  }
}

function windowMatchesMiniSize(collapsed: boolean, slack = 48): boolean {
  const size = collapsed ? OVERLAY_COLLAPSED : OVERLAY_EXPANDED;
  return (
    Math.abs(window.outerWidth - size.width) <= slack &&
    Math.abs(window.outerHeight - size.height) <= slack + 28
  );
}

/** Keep the mini recorder at one fixed size (non-resizable) while recording. */
function startMiniWindowSizeLock(getCollapsed: () => boolean): () => void {
  const apply = () => {
    if (!windowMatchesMiniSize(getCollapsed())) {
      placeOverlayWindow(getCollapsed());
    }
  };
  apply();
  const onResize = () => apply();
  window.addEventListener("resize", onResize);
  const id = window.setInterval(apply, 250);
  return () => {
    window.removeEventListener("resize", onResize);
    window.clearInterval(id);
  };
}

/** Snap this window to the fixed mini recorder size (browser + Win32). */
function placeOverlayWindow(collapsed: boolean): void {
  const { width, height, left, top } = overlayTargetRect(collapsed);
  applyBrowserMiniWindowGeometry(collapsed);
  void positionUiWindow({ width, height, left, top, topmost: true }).catch(() => undefined);
}

function restoreMainWindow(g: WindowGeometry | null): void {
  const geo = normalizeMainGeometry(g ?? captureWindowGeometry());
  try {
    window.resizeTo(geo.width, geo.height);
    window.moveTo(geo.x, geo.y);
  } catch {
    // ignore
  }
  void positionUiWindow({
    width: geo.width,
    height: geo.height,
    left: geo.x,
    top: geo.y,
    topmost: false,
  }).catch(() => undefined);
}

function exitOverlayMode(
  geometry: WindowGeometry | null,
  onRestored: () => void,
): () => void {
  const g = normalizeMainGeometry(geometry);
  const restore = () => restoreMainWindow(g);
  restore();
  const timers = [50, 120, 220, 400, 800, 1400].map((ms) => window.setTimeout(restore, ms));
  // Reveal full UI after first restore attempts (don't wait for last retry).
  const reveal = window.setTimeout(onRestored, 280);
  return () => {
    timers.forEach((id) => window.clearTimeout(id));
    window.clearTimeout(reveal);
  };
}

function Index() {
  const [collapsed, setCollapsed] = useState(true);
  const [page, setPage] = useState<Page>("home");
  /** Open this summary detail when navigating to AI Summaries (toast / View Summary). */
  const [summaryFocusId, setSummaryFocusId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("auto");
  const [overlayOnly, setOverlayOnly] = useState(false);
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document !== "undefined" ? resolveTheme() : "light",
  );
  const [namePromptOpen, setNamePromptOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const recorder = useRecorder();
  const savedGeometry = useRef<WindowGeometry | null>(null);
  const pendingOverlay = useRef(false);
  const miniCollapsedRef = useRef(false);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Reactive minimum width for the main shell (skipped while the mini overlay is active).
  useEffect(() => {
    if (overlayOnly) return;
    return startMainWindowMinWidthGuard();
  }, [overlayOnly]);

  // First open: ask for the user's Teams display name (mute gating).
  useEffect(() => {
    getBotConfig()
      .then((cfg) => {
        if (!cfg.localParticipantName.trim()) {
          setNameDraft("");
          setNamePromptOpen(true);
        }
      })
      .catch(() => undefined);
  }, []);

  const saveLocalName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      toast.error("Enter your name exactly as it appears in Teams.");
      return;
    }
    setNameSaving(true);
    try {
      await saveBotConfig({ localParticipantName: trimmed });
      setNamePromptOpen(false);
      toast.success(`Saved as "${trimmed}"`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setNameSaving(false);
    }
  };

  // Shrink to fixed mini size shortly after join (same single window as before).
  useEffect(() => {
    if (recorder.mode !== "recording" || !pendingOverlay.current) return;

    const t = window.setTimeout(() => {
      pendingOverlay.current = false;
      if (!savedGeometry.current) {
        savedGeometry.current = captureWindowGeometry();
      }
      miniCollapsedRef.current = false;
      setOverlayOnly(true);
      placeOverlayWindow(false);
    }, 1500);

    return () => window.clearTimeout(t);
  }, [recorder.mode]);

  // Keep window pinned to mini dimensions while recording (user cannot resize away).
  useEffect(() => {
    if (!overlayOnly) return;
    return startMiniWindowSizeLock(() => miniCollapsedRef.current);
  }, [overlayOnly]);

  useEffect(() => {
    if (!overlayOnly) return;
    if (recorder.mode !== "idle" && recorder.mode !== "saved") return;

    const g = savedGeometry.current;
    savedGeometry.current = null;
    return exitOverlayMode(g, () => {
      setOverlayOnly(false);
    });
  }, [recorder.mode, overlayOnly]);

  const joinAndPrepareOverlay = async () => {
    if (!savedGeometry.current) {
      savedGeometry.current = captureWindowGeometry();
    }
    pendingOverlay.current = true;
    const ok = await recorder.join();
    if (!ok) pendingOverlay.current = false;
  };

  const value = { ...recorder, join: joinAndPrepareOverlay };

  const shell = (children: React.ReactNode) => (
    <RecorderContext.Provider value={value}>
      <TooltipProvider>
        <Toaster />
        {children}
      </TooltipProvider>
    </RecorderContext.Provider>
  );

  if (overlayOnly) {
    return shell(
      <div className="h-full w-full overflow-hidden bg-background">
        <MeetingAssistantWindow
          forceVisible
          highest
          miniWindow
          onChromeCollapseChange={(miniCollapsed) => {
            miniCollapsedRef.current = miniCollapsed;
            placeOverlayWindow(miniCollapsed);
          }}
        />
      </div>,
    );
  }

  return shell(
    <>
      <Dialog open={namePromptOpen} onOpenChange={() => undefined}>
        <DialogContent
          className="sm:max-w-md [&>button.absolute]:hidden"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>What’s your Teams name?</DialogTitle>
            <DialogDescription>
              Enter your name exactly as it appears in the meeting roster. We use this so your mic
              is muted in recordings when you mute in Teams.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="local-participant-name">Display name</Label>
            <Input
              id="local-participant-name"
              autoFocus
              placeholder="e.g. Saad Ahmed"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveLocalName();
              }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button disabled={nameSaving || !nameDraft.trim()} onClick={() => void saveLocalName()}>
              {nameSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Continue"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <SidebarProvider open={!collapsed} onOpenChange={(open) => setCollapsed(!open)} defaultOpen={false}>
        <AppSidebar
          page={page}
          setPage={setPage}
          theme={theme}
          onToggleTheme={() => setTheme((t) => toggleTheme(t))}
        />
        <SidebarInset className="flex min-h-0 flex-1 flex-col overflow-auto">
          {page === "home" && <HomePage setPage={setPage} />}
          {page === "recording" && <RecordingPage />}
          {page === "notes" && (
            <NotesPage
              setPage={setPage}
              selectedModel={selectedModel}
              onSelectedModelChange={setSelectedModel}
            />
          )}
          {page === "recordings" && <RecordingsPage setPage={setPage} />}
          {page === "summaries" && (
            <SummariesPage
              setPage={setPage}
              focusSummaryId={summaryFocusId}
              onFocusConsumed={() => setSummaryFocusId(null)}
              selectedModel={selectedModel}
              onSelectedModelChange={setSelectedModel}
            />
          )}
          {page === "settings" && <SettingsPage />}
        </SidebarInset>
        <DockedMeetingAssistant chromeCollapsed={page === "recording"} />
      </SidebarProvider>
    </>,
  );
}

/** Floats the mini recorder just to the right of the sidebar so it never covers Dark mode / Settings. */
function DockedMeetingAssistant({ chromeCollapsed }: { chromeCollapsed: boolean }) {
  const { state } = useSidebar();
  // Explicit rem values (match SIDEBAR_WIDTH / SIDEBAR_WIDTH_ICON) — more reliable than CSS vars on fixed elements.
  const leftClass = state === "expanded" ? "left-[12.75rem]" : "left-[3.75rem]";
  return (
    <MeetingAssistantWindow chromeCollapsed={chromeCollapsed} dockClassName={leftClass} />
  );
}

/* ---------------- Sidebar ---------------- */

function AppSidebar({
  page,
  setPage,
  theme,
  onToggleTheme,
}: {
  page: Page;
  setPage: (p: Page) => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const items: {
    id: Page;
    label: string;
    icon: React.ReactNode;
    record?: boolean;
    summaries?: boolean;
  }[] = [
    { id: "home", label: "Home", icon: <Home /> },
    { id: "recording", label: "Record", icon: <Mic />, record: true },
    { id: "summaries", label: "AI Summaries", icon: <Sparkles />, summaries: true },
    { id: "notes", label: "Transcripts", icon: <FileText /> },
    { id: "recordings", label: "Recordings", icon: <Folder /> },
  ];
  const isDark = theme === "dark";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center justify-between gap-1 px-1 py-1">
          <span className="text-sm font-semibold truncate group-data-[collapsible=icon]:hidden">
            e& Assistant
          </span>
          <SidebarTrigger className="ml-auto" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((it) => {
                const active = page === it.id;
                return (
                  <SidebarMenuItem key={it.id} className="relative">
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={it.label}
                      onClick={() => setPage(it.id)}
                      className={cn(
                        active &&
                          !it.record &&
                          !it.summaries &&
                          "bg-sidebar-accent font-semibold shadow-sm ring-1 ring-sidebar-border",
                        it.record &&
                          "!bg-destructive !text-destructive-foreground hover:!bg-destructive/90 hover:!text-destructive-foreground data-[active=true]:!bg-destructive data-[active=true]:!text-destructive-foreground",
                        it.summaries &&
                          "!bg-gradient-to-r !from-violet-600 !to-blue-500 !text-white hover:!from-violet-500 hover:!to-blue-400 hover:!text-white data-[active=true]:!from-violet-600 data-[active=true]:!to-blue-500 data-[active=true]:!text-white",
                      )}
                    >
                      {it.icon}
                      <span>{it.label}</span>
                    </SidebarMenuButton>
                    {active && (
                      <span
                        aria-hidden
                        className={cn(
                          "pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full",
                          it.record || it.summaries ? "bg-white" : "bg-foreground",
                        )}
                      />
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={isDark ? "Switch to light mode" : "Switch to dark mode"}
              onClick={onToggleTheme}
            >
              {isDark ? <Sun /> : <Moon />}
              <span>{isDark ? "Light mode" : "Dark mode"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem className="relative">
            <SidebarMenuButton
              isActive={page === "settings"}
              tooltip="Settings"
              onClick={() => setPage("settings")}
              className={
                page === "settings"
                  ? "bg-sidebar-accent font-semibold shadow-sm ring-1 ring-sidebar-border"
                  : undefined
              }
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
            {page === "settings" && (
              <span
                aria-hidden
                className="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full bg-foreground"
              />
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

/* ---------------- Page layout shells ---------------- */

/** Wide pages (Home grid). */
const PAGE_WIDE = "mx-auto w-full max-w-[1400px] px-6 py-8 lg:px-10";
/** Shared centered shell for Transcripts, Recordings, and AI Summaries. */
const LIST_PAGE = "mx-auto w-full max-w-5xl px-6 py-8";
const LIST_PAGE_SIZE = 18;
/** Space reserved to the right of transcript tables for the floating resummarize control. */
const TRANSCRIPT_RESUMMARIZE_GUTTER = "pr-11";
const LIST_TABLE_CLASS = "table-fixed";
const LIST_COL_TITLE_HEAD = "min-w-0";
const LIST_COL_TITLE_CELL = "min-w-0 overflow-hidden";
/** Fits longest formatDate() output, e.g. "31/12/2026 12:59 PM" (19 chars) + cell p-2 padding. */
const LIST_COL_DATE = "w-[calc(19ch+1rem)] shrink-0 whitespace-nowrap";
const LIST_COL_DURATION = "w-[5.5rem] shrink-0 whitespace-nowrap";
const LIST_COL_ACTIONS_TRANSCRIPTS = "w-[17.5rem] shrink-0";
const LIST_COL_ACTIONS_SUMMARIES = "w-[11rem] shrink-0";
const LIST_COL_ACTIONS_RECORDINGS = "w-[12.5rem] shrink-0";
/** Fixed width only for Summarize ↔ View Summary (label changes); View sizes naturally. */
const SUMMARIZE_ACTION_BTN = "w-[122px] justify-center gap-1 px-3 [&_svg]:size-3.5";
const SUMMARIZE_OUTLINE =
  "border-violet-500/40 text-violet-700 hover:bg-violet-500/10 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200";
const SUMMARIZE_FILLED =
  "border-transparent bg-violet-600 text-white shadow-sm hover:bg-violet-500 hover:text-white dark:bg-violet-500 dark:hover:bg-violet-400";

function summarizationModelLabel(model: string): string {
  return model === "auto" ? "Auto" : model;
}

function summariesByTranscript(summaries: SummaryItem[]): Record<string, SummaryItem> {
  const map: Record<string, SummaryItem> = {};
  for (const s of summaries) {
    if (s.transcriptFileName) map[s.transcriptFileName] = s;
  }
  return map;
}

function useAvailableModels() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    listAvailableModels()
      .then((models) => {
        if (!cancelled) setAvailableModels(models);
      })
      .catch((e) => {
        if (!cancelled) setModelsError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { availableModels, modelsLoading, modelsError };
}

function SummarizationModelSelect({
  selectedModel,
  onSelectedModelChange,
  availableModels,
  modelsLoading,
  modelsError,
}: {
  selectedModel: string;
  onSelectedModelChange: (model: string) => void;
  availableModels: string[];
  modelsLoading: boolean;
  modelsError: string | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Model</span>
      <Select value={selectedModel} onValueChange={onSelectedModelChange}>
        <SelectTrigger
          className="h-8 w-[100px] px-3 text-xs"
          aria-label="Summarization model"
          disabled={modelsLoading && selectedModel !== "auto"}
        >
          <SelectValue placeholder="Auto" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto</SelectItem>
          {modelsLoading ? (
            <SelectItem value="__loading__" disabled>
              Loading...
            </SelectItem>
          ) : null}
          {!modelsLoading && modelsError ? (
            <SelectItem value="__error__" disabled>
              Models unavailable
            </SelectItem>
          ) : null}
          {!modelsLoading &&
            !modelsError &&
            availableModels.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ResummarizeIconButton({
  busy,
  disabled,
  onClick,
  className,
}: {
  busy?: boolean;
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={cn("h-8 w-8 shrink-0", className)}
          disabled={disabled || busy}
          onClick={onClick}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          <span className="sr-only">Resummarize</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Resummarize</TooltipContent>
    </Tooltip>
  );
}

const BROWSE_CARD_ACCENT = "text-muted-foreground bg-secondary";
const BROWSE_CARD_CLASS =
  "border-border/80 bg-secondary/30 hover:border-border hover:bg-secondary/40 hover:shadow-sm";

/** Narrow/form pages (Record, Settings) — fill the inset and center the panel. */
function PageFormCenter({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 min-h-0 w-full items-center justify-center px-6 py-8">
      {children}
    </div>
  );
}

function PageWide({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(PAGE_WIDE, className)}>{children}</div>;
}

function ListPageShell({ children }: { children: ReactNode }) {
  return <div className={LIST_PAGE}>{children}</div>;
}

/** Shared Transcript / AI Summary detail chrome: copy top-right, close floats outside. */
function DetailViewerDialog({
  open,
  onOpenChange,
  title,
  description,
  copyText,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  copyText?: string | null;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeOutside
        className="flex max-h-[85vh] max-w-2xl flex-col gap-4 overflow-visible"
      >
        <div className="flex shrink-0 items-center gap-3">
          <DialogHeader className="min-w-0 flex-1 space-y-1.5 text-left sm:text-left">
            <DialogTitle className="truncate">{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          {copyText ? <CopyButton text={copyText} className="shrink-0" /> : null}
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** "1 summary" / "2 summaries" (and transcript/recording). */
function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  /** Optional control vertically centered against title + description. */
  action?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

function listSearchPlaceholder(
  count: number | undefined,
  countLabel: string,
  countLabelPlural?: string,
): string {
  const fallbackPlural = countLabelPlural ?? `${countLabel}s`;
  if (count == null) return `Search ${fallbackPlural}...`;
  return `Search ${count} ${pluralize(count, countLabel, countLabelPlural)}...`;
}

function ListSearch({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** Static label for screen readers (placeholders are unreliable). */
  ariaLabel: string;
}) {
  return (
    <div className="relative mb-4 max-w-sm">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8"
        aria-label={ariaLabel}
      />
    </div>
  );
}

function TruncatedTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="min-w-0 w-full overflow-hidden">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="truncate font-medium">{title}</div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm break-all">
          {title}
        </TooltipContent>
      </Tooltip>
      {subtitle ? (
        <div className="truncate text-xs text-muted-foreground mt-0.5">{subtitle}</div>
      ) : null}
    </div>
  );
}

function ListEmptyState({
  message,
  ctaLabel = "Go to Record",
  ctaIcon,
  onCta,
}: {
  message: string;
  ctaLabel?: string;
  ctaIcon?: ReactNode;
  onCta: () => void;
}) {
  return (
    <div className="flex max-w-md flex-col items-center rounded-md border border-dashed bg-muted/20 px-6 py-12 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button className="mt-4" variant="default" onClick={onCta}>
        {ctaIcon ?? <Mic className="h-4 w-4" />}
        {ctaLabel}
      </Button>
    </div>
  );
}

function ListTableSkeleton({ variant }: { variant: "transcripts" | "summaries" | "recordings" }) {
  const actionsCol =
    variant === "recordings"
      ? LIST_COL_ACTIONS_RECORDINGS
      : variant === "summaries"
        ? LIST_COL_ACTIONS_SUMMARIES
        : LIST_COL_ACTIONS_TRANSCRIPTS;

  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <TableRow key={i}>
          <TableCell className={LIST_COL_TITLE_CELL}>
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3 w-16 mt-2 max-w-full" />
          </TableCell>
          {variant === "recordings" && (
            <TableCell className={LIST_COL_DURATION}>
              <Skeleton className="h-4 w-10" />
            </TableCell>
          )}
          <TableCell className={LIST_COL_DATE}>
            <Skeleton className="h-4 w-28" />
          </TableCell>
          <TableCell className={cn("text-right", actionsCol)}>
            <Skeleton className="ml-auto h-8 w-36" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function ListPagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;

  const go = (next: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (next >= 1 && next <= totalPages) onPageChange(next);
  };

  return (
    <Pagination className="mx-0 mt-4 w-full justify-end">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href="#"
            onClick={go(page - 1)}
            className={cn("cursor-pointer", page <= 1 && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#" isActive onClick={(e) => e.preventDefault()} size="default">
            {page} / {totalPages}
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            href="#"
            onClick={go(page + 1)}
            className={cn("cursor-pointer", page >= totalPages && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

function useListPagination<T>(items: T[], query: string, pageSize = LIST_PAGE_SIZE) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  return { page: safePage, totalPages, pageItems, setPage };
}

/* ---------------- Home ---------------- */

function useTypewriter(text: string, speed = 30) {
  const [displayed, setDisplayed] = useState("");
  useEffect(() => {
    setDisplayed("");
    let i = 0;
    const id = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);
  return displayed;
}

function HomePage({ setPage }: { setPage: (p: Page) => void }) {
  const welcome = "Welcome to e& Meeting Assistant";
  const typed = useTypewriter(welcome, 32);

  const cards: {
    id: Page;
    title: string;
    desc: string;
    icon: React.ReactNode;
    accent?: string;
    cardClass?: string;
  }[] = [
    {
      id: "recording",
      title: "Record",
      desc: "Start a new meeting recording",
      icon: <Mic className="h-6 w-6" />,
      accent: "text-destructive-foreground bg-destructive shadow-sm shadow-destructive/30",
      cardClass: "border-destructive/40 bg-destructive/5 hover:border-destructive hover:shadow-destructive/20",
    },
    {
      id: "summaries",
      title: "AI Summaries",
      desc: "Get AI-generated meeting summaries",
      icon: <Sparkles className="h-6 w-6" />,
      accent: "text-white bg-gradient-to-br from-violet-600 to-blue-500 shadow-sm shadow-violet-500/25",
      cardClass:
        "border-violet-500/35 bg-gradient-to-br from-violet-500/10 to-blue-500/10 hover:border-violet-500/60",
    },
    {
      id: "notes",
      title: "Transcripts",
      desc: "Review speaker-labeled transcripts",
      icon: <FileText className="h-6 w-6" />,
      accent: BROWSE_CARD_ACCENT,
      cardClass: BROWSE_CARD_CLASS,
    },
    {
      id: "recordings",
      title: "Recordings",
      desc: "Browse past recordings",
      icon: <Folder className="h-6 w-6" />,
      accent: BROWSE_CARD_ACCENT,
      cardClass: BROWSE_CARD_CLASS,
    },
  ];

  return (
    <div className="flex flex-1 min-h-0 w-full items-center justify-center">
      <PageWide className="flex flex-col items-center py-10">
        <div className="mb-8 text-center px-2">
          <h1 className="text-2xl font-semibold">
            <span className="sr-only">{welcome}</span>
            <span aria-hidden>{typed}</span>
            <span
              aria-hidden
              className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-foreground animate-pulse"
            />
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Choose an option to get started</p>
        </div>

        <div className="grid w-full max-w-5xl grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          {cards.map((c) => (
            <Card
              key={c.id}
              className={cn(
                "min-w-0 w-full cursor-pointer transition-shadow hover:shadow-md",
                c.cardClass ?? "hover:border-primary/40",
              )}
              onClick={() => setPage(c.id)}
            >
              <CardHeader className="space-y-2 p-5">
                <div
                  className={cn(
                    "inline-flex h-11 w-11 items-center justify-center rounded-lg",
                    c.accent,
                  )}
                >
                  {c.icon}
                </div>
                <CardTitle className="text-base">{c.title}</CardTitle>
                <CardDescription className="text-xs leading-snug">{c.desc}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </PageWide>
    </div>
  );
}

function SummariesPage({
  setPage,
  focusSummaryId,
  onFocusConsumed,
  selectedModel,
  onSelectedModelChange,
}: {
  setPage: (p: Page) => void;
  focusSummaryId?: string | null;
  onFocusConsumed?: () => void;
  selectedModel: string;
  onSelectedModelChange: (model: string) => void;
}) {
  const [items, setItems] = useState<SummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewedSummary, setViewedSummary] = useState<SummaryItem | null>(null);
  const [summaryViewerLoading, setSummaryViewerLoading] = useState(false);
  const [resummarizingIds, setResummarizingIds] = useState<Record<string, boolean>>({});
  const { availableModels, modelsLoading, modelsError } = useAvailableModels();

  const openSummaryViewer = async (id: string, fallback?: SummaryItem) => {
    setViewingId(id);
    setSummaryViewerLoading(true);
    setViewedSummary(fallback ?? null);
    try {
      const summary = await fetchSummary(id);
      setViewedSummary(summary);
      setItems((prev) => prev.map((item) => (item.id === summary.id ? summary : item)));
    } catch (e) {
      if (!fallback) {
        setViewingId(null);
        setViewedSummary(null);
        toast.error((e as Error).message || "Could not load summary");
      }
    } finally {
      setSummaryViewerLoading(false);
    }
  };

  useEffect(() => {
    listSummaries()
      .then(setItems)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const handleResummarize = async (s: SummaryItem) => {
    if (!s.transcriptFileName || resummarizingIds[s.id]) return;
    const modelToUse = selectedModel === "auto" ? undefined : selectedModel;
    const modelLabel = summarizationModelLabel(selectedModel);
    setResummarizingIds((prev) => ({ ...prev, [s.id]: true }));
    const toastId = toast.loading(`Resummarizing with ${modelLabel}…`);
    try {
      const summary = await generateSummary(s.transcriptFileName, modelToUse, { force: true });
      setItems((prev) => prev.map((item) => (item.id === summary.id ? summary : item)));
      if (viewingId === summary.id) setViewedSummary(summary);
      toast.success(`Summary updated for ${summary.title || s.title}`, {
        id: toastId,
        action: {
          label: "View",
          onClick: () => void openSummaryViewer(summary.id, summary),
        },
      });
    } catch (e) {
      toast.error((e as Error).message || "Could not resummarize", { id: toastId });
    } finally {
      setResummarizingIds((prev) => {
        const next = { ...prev };
        delete next[s.id];
        return next;
      });
    }
  };

  useEffect(() => {
    if (!focusSummaryId) return;
    void openSummaryViewer(focusSummaryId);
    onFocusConsumed?.();
  }, [focusSummaryId, onFocusConsumed]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter((s) => s.title.toLowerCase().includes(q) || s.text.toLowerCase().includes(q))
    : items;
  const { page, totalPages, pageItems, setPage: setListPage } = useListPagination(filtered, query);

  const summarySearchPlaceholder = listSearchPlaceholder(
    loading ? undefined : items.length,
    "summary",
    "summaries",
  );

  return (
    <ListPageShell>
      <PageHeader
        title="AI Summaries"
        description="AI-generated summaries of your recorded meetings"
        action={
          <div className="flex shrink-0 items-center gap-3">
            <SummarizationModelSelect
              selectedModel={selectedModel}
              onSelectedModelChange={onSelectedModelChange}
              availableModels={availableModels}
              modelsLoading={modelsLoading}
              modelsError={modelsError}
            />
            <Button size="sm" className={SUMMARIZE_FILLED} onClick={() => setPage("notes")}>
              <Sparkles className="h-4 w-4" />
              Summarize a transcript
            </Button>
          </div>
        }
      />

      <LlmSetupBanner setPage={setPage} />

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && (
        <>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder={summarySearchPlaceholder}
            ariaLabel="Search summaries"
          />
          <div className="rounded-md border">
            <Table className={LIST_TABLE_CLASS}>
              <TableHeader>
                <TableRow>
                  <TableHead className={LIST_COL_TITLE_HEAD}>Title</TableHead>
                  <TableHead className={LIST_COL_DATE}>Date</TableHead>
                  <TableHead className={LIST_COL_ACTIONS_SUMMARIES} />
                </TableRow>
              </TableHeader>
              <TableBody>
                <ListTableSkeleton variant="summaries" />
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {!loading && !error && items.length === 0 && (
        <ListEmptyState
          message="No AI summaries yet — generate one from a transcript"
          ctaLabel="Go to Transcripts"
          ctaIcon={<FileText className="h-4 w-4" />}
          onCta={() => setPage("notes")}
        />
      )}

      {!loading && items.length > 0 && (
        <>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder={summarySearchPlaceholder}
            ariaLabel="Search summaries"
          />
          <div className="rounded-md border">
            <Table className={LIST_TABLE_CLASS}>
              <TableHeader>
                <TableRow>
                  <TableHead className={LIST_COL_TITLE_HEAD}>Title</TableHead>
                  <TableHead className={LIST_COL_DATE}>Date</TableHead>
                  <TableHead className={LIST_COL_ACTIONS_SUMMARIES} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                      No summaries match your search
                    </TableCell>
                  </TableRow>
                ) : (
                  pageItems.map((s) => (
                    <TableRow
                      key={s.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => void openSummaryViewer(s.id, s)}
                    >
                      <TableCell className={LIST_COL_TITLE_CELL}>
                        <TruncatedTitle
                          title={s.title}
                          subtitle={formatRelativeTime(s.lastModified)}
                        />
                      </TableCell>
                      <TableCell className={cn("text-muted-foreground", LIST_COL_DATE)}>
                        {formatDate(s.lastModified)}
                      </TableCell>
                      <TableCell className={cn("text-right", LIST_COL_ACTIONS_SUMMARIES)}>
                        <div className="inline-flex items-center justify-end">
                          <Button
                            variant="outline"
                            size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openSummaryViewer(s.id, s);
                          }}
                          >
                            View
                          </Button>
                          {s.transcriptFileName ? (
                            <ResummarizeIconButton
                              className="ml-2"
                              busy={!!resummarizingIds[s.id]}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleResummarize(s);
                              }}
                            />
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <ListPagination page={page} totalPages={totalPages} onPageChange={setListPage} />
        </>
      )}

      <DetailViewerDialog
        key={viewedSummary?.lastModified ?? viewingId ?? "closed"}
        open={viewingId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewingId(null);
            setViewedSummary(null);
          }
        }}
        title={viewedSummary?.title ?? "AI Summary"}
        description={viewedSummary ? formatDate(viewedSummary.lastModified) : undefined}
        copyText={viewedSummary?.text}
      >
        {summaryViewerLoading && !viewedSummary ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading summary…
          </div>
        ) : null}
        {viewedSummary && (
          <div className="min-h-0 max-h-[60vh] flex-1 overflow-y-auto rounded-md border bg-muted/20">
            <pre className="p-4 text-sm whitespace-pre-wrap">{viewedSummary.text}</pre>
          </div>
        )}
      </DetailViewerDialog>
    </ListPageShell>
  );
}

/* ---------------- Recording page (full) ---------------- */

function RecordingPage() {
  return (
    <PageFormCenter>
      <div className="w-full max-w-lg">
        <div className="mb-5 text-center sm:text-left">
          <h1 className="text-2xl font-semibold">Record</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Paste any Microsoft Teams meeting link
          </p>
        </div>
        <Card>
          <CardContent className="pt-6">
            <RecorderPanel size="large" />
          </CardContent>
        </Card>
      </div>
    </PageFormCenter>
  );
}

function LlmSetupBanner({ setPage }: { setPage: (p: Page) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    getBotConfig()
      .then((cfg) => setConfigured(cfg.llm.configured))
      .catch(() => setConfigured(null));
  }, []);

  if (configured !== false) return null;

  return (
    <Alert className="mb-4">
      <Sparkles className="h-4 w-4" />
      <AlertTitle>AI summarization not configured</AlertTitle>
      <AlertDescription>
        Add your API key in{" "}
        <button
          type="button"
          className="font-medium underline underline-offset-2 hover:text-foreground"
          onClick={() => setPage("settings")}
        >
          Settings
        </button>{" "}
        to generate summaries.
      </AlertDescription>
    </Alert>
  );
}

function TranscriptionSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [engines, setEngines] = useState<TranscriptionEnginesResponse | null>(null);
  const [engineId, setEngineId] = useState<TranscriptionEngineId | "">("");
  const [model, setModel] = useState("");
  const [device, setDevice] = useState<"cpu" | "cuda">("cpu");

  const available = engines?.available ?? [];
  const hasEngines = available.length > 0;

  const selectedAvailable = available.find((e) => e.id === engineId) ?? available[0];
  const modelOptions = selectedAvailable?.models ?? [];

  const loadAll = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [cfg, detected] = await Promise.all([
        getBotConfig(),
        listTranscriptionEngines(refresh),
      ]);
      setEngines(detected);
      const saved = cfg.transcription.saved;
      setDevice(saved.device === "cuda" ? "cuda" : "cpu");

      const savedEngine = saved.engine;
      const pick =
        detected.available.find((e) => e.id === savedEngine) ?? detected.available[0];
      if (pick) {
        setEngineId(pick.id);
        const savedModel = saved.model;
        setModel(
          savedModel && pick.models.includes(savedModel) ? savedModel : pick.defaultModel,
        );
      } else {
        setEngineId("");
        setModel("");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const handleEngineChange = (id: string) => {
    const next = available.find((e) => e.id === id);
    if (!next) return;
    setEngineId(next.id);
    setModel(next.defaultModel);
  };

  const handleSave = async () => {
    if (!hasEngines) {
      toast.error("No transcription engine found on this PC.");
      return;
    }
    if (!selectedAvailable) {
      toast.error("Select a transcription engine.");
      return;
    }

    setSaving(true);
    try {
      await saveBotConfig({
        transcriptionEngine: selectedAvailable.id,
        transcriptionModel: model || selectedAvailable.defaultModel,
        transcriptionPythonPath: selectedAvailable.pythonPath,
        transcriptionDevice: device,
      });
      toast.success("Transcription settings saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Transcription</CardTitle>
            <CardDescription>
              Choose which local STT engine and model to use. Turn it on per meeting from the Record
              page — the app does not install anything.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            onClick={() => void loadAll(true)}
            disabled={loading || refreshing}
            aria-label="Refresh engine detection"
          >
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Detecting installed engines…
          </div>
        ) : (
          <>
            {!hasEngines ? (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  No supported transcription engines were found. Live captions still produce a
                  transcript. Ask IT to install faster-whisper or NVIDIA NeMo in a Python environment,
                  then refresh.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-2">
              <Label>Engine</Label>
              <Select
                value={engineId || undefined}
                onValueChange={handleEngineChange}
                disabled={!hasEngines}
              >
                <SelectTrigger>
                  <SelectValue placeholder="No engine detected" />
                </SelectTrigger>
                <SelectContent>
                  {(engines?.supported ?? []).map((row) => (
                    <SelectItem key={row.id} value={row.id} disabled={!row.installed}>
                      {row.installed
                        ? `${row.label}${row.version ? ` (${row.version})` : ""}`
                        : `${row.label} — not found on this PC`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedAvailable ? (
                <p className="text-xs text-muted-foreground truncate" title={selectedAvailable.pythonPath}>
                  Python: {selectedAvailable.pythonPath}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label>Model</Label>
              <Select
                value={model || undefined}
                onValueChange={setModel}
                disabled={!hasEngines || modelOptions.length === 0}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>CPU/GPU</Label>
              <Select value={device} onValueChange={(v) => setDevice(v as "cpu" | "cuda")} disabled={!hasEngines}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cpu">CPU</SelectItem>
                  <SelectItem value="cuda">GPU</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button onClick={() => void handleSave()} disabled={saving || loading || !hasEngines}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save transcription settings
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [model, setModel] = useState("");
  const [apiKeySet, setApiKeySet] = useState(false);
  const [apiKeyPreview, setApiKeyPreview] = useState<string | null>(null);
  const [fromEnv, setFromEnv] = useState({ apiKey: false, gatewayUrl: false, model: false });
  const [uiOverride, setUiOverride] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const loadConfig = () => {
    setLoading(true);
    return getBotConfig()
      .then((cfg) => {
        setGatewayUrl(cfg.llm.gatewayUrl);
        setModel(cfg.llm.model);
        setApiKeySet(cfg.llm.apiKeySet);
        setApiKeyPreview(cfg.llm.apiKeyPreview);
        setFromEnv(cfg.llm.fromEnv);
        setUiOverride(cfg.llm.uiOverride);
        setConfigured(cfg.llm.configured);
        setApiKeyDraft("");
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  const handleSave = async () => {
    const payload: {
      llmGatewayUrl?: string;
      llmApiKey?: string;
      llmModel?: string;
    } = {};

    const canEditGateway = uiOverride || !fromEnv.gatewayUrl;
    const canEditModel = uiOverride || !fromEnv.model;
    const canEditApiKey = uiOverride || !fromEnv.apiKey;

    if (canEditGateway) payload.llmGatewayUrl = gatewayUrl.trim();
    if (canEditModel) payload.llmModel = model.trim();
    if (canEditApiKey && apiKeyDraft.trim()) payload.llmApiKey = apiKeyDraft.trim();

    if (canEditGateway && !payload.llmGatewayUrl) {
      toast.error("Gateway URL is required.");
      return;
    }
    if (canEditApiKey && !apiKeySet && !payload.llmApiKey) {
      toast.error("API key is required.");
      return;
    }

    setSaving(true);
    try {
      const cfg = await saveBotConfig(payload);
      setGatewayUrl(cfg.llm.gatewayUrl);
      setModel(cfg.llm.model);
      setApiKeySet(cfg.llm.apiKeySet);
      setApiKeyPreview(cfg.llm.apiKeyPreview);
      setFromEnv(cfg.llm.fromEnv);
      setUiOverride(cfg.llm.uiOverride);
      setConfigured(cfg.llm.configured);
      setApiKeyDraft("");
      toast.success("Settings saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await testLlmConnection(model.trim() || undefined);
      if (result.ok) {
        toast.success(`Connected (${result.model})`);
      } else {
        toast.error(result.error || "Connection test failed");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const envLocked =
    !uiOverride && (fromEnv.apiKey || fromEnv.gatewayUrl || fromEnv.model);
  const fieldLocked = (fromEnvKey: boolean) => !uiOverride && fromEnvKey;

  return (
    <PageFormCenter>
      <div className="w-full max-w-lg space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">e&amp; Meeting Assistant — Teams guest bot</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI Summarization</CardTitle>
            <CardDescription>
              Connect an OpenAI-compatible API to generate meeting summaries from transcripts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : (
              <>
                {uiOverride && (
                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertDescription>
                      <code className="text-xs bg-muted px-1 rounded">LLM_ALLOW_UI_OVERRIDE</code>{" "}
                      is on — values saved here override your <code className="text-xs bg-muted px-1 rounded">.env</code>{" "}
                      file.
                    </AlertDescription>
                  </Alert>
                )}

                {envLocked && (
                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertDescription>
                      Some LLM settings are managed by environment variables (.env) and cannot be
                      changed here. Set{" "}
                      <code className="text-xs bg-muted px-1 rounded">LLM_ALLOW_UI_OVERRIDE=true</code>{" "}
                      in <code className="text-xs bg-muted px-1 rounded">.env</code> to test overrides
                      from Settings.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex items-center gap-2">
                  <Badge variant={configured ? "default" : "secondary"}>
                    {configured ? "Configured" : "Not configured"}
                  </Badge>
                  {apiKeySet && apiKeyPreview ? (
                    <span className="text-xs text-muted-foreground">Key {apiKeyPreview}</span>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="llm-gateway">Gateway URL</Label>
                  <Input
                    id="llm-gateway"
                    type="url"
                    placeholder="https://api.x.ai/v1"
                    value={gatewayUrl}
                    onChange={(e) => setGatewayUrl(e.target.value)}
                    disabled={fieldLocked(fromEnv.gatewayUrl)}
                    autoComplete="off"
                  />
                  {fieldLocked(fromEnv.gatewayUrl) ? (
                    <p className="text-xs text-muted-foreground">Set via LLM_GATEWAY_URL</p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="llm-api-key">API key</Label>
                  <Input
                    id="llm-api-key"
                    type="password"
                    placeholder={apiKeySet ? "Enter a new key to replace the saved one" : "sk-…"}
                    value={apiKeyDraft}
                    onChange={(e) => setApiKeyDraft(e.target.value)}
                    disabled={fieldLocked(fromEnv.apiKey)}
                    autoComplete="off"
                  />
                  {fieldLocked(fromEnv.apiKey) ? (
                    <p className="text-xs text-muted-foreground">Set via LLM_API_KEY</p>
                  ) : apiKeySet ? (
                    <p className="text-xs text-muted-foreground">
                      Leave blank to keep the current key ({apiKeyPreview})
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="llm-model">Default model</Label>
                  <Input
                    id="llm-model"
                    placeholder="grok-2-latest"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={fieldLocked(fromEnv.model)}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Used when the model picker is set to Auto on the Summaries page.
                  </p>
                  {fieldLocked(fromEnv.model) ? (
                    <p className="text-xs text-muted-foreground">Set via LLM_MODEL</p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button onClick={() => void handleSave()} disabled={saving || loading}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Save
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void handleTest()}
                    disabled={testing || loading || !configured}
                  >
                    {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Test connection
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <TranscriptionSettingsCard />

        <Card>
          <CardContent className="pt-6 space-y-3 text-sm">
            <p>
              Joins Microsoft Teams meetings as a guest, records audio, and captures live captions into
              speaker-labeled transcripts.
            </p>
            <p className="text-muted-foreground">
              Backend runs locally on port 3000. Start with{" "}
              <code className="text-xs bg-muted px-1 rounded">Start-Bot.cmd</code>.
            </p>
          </CardContent>
        </Card>
      </div>
    </PageFormCenter>
  );
}

function formatDate(d: string) {
  const dt = new Date(d);
  const day = dt.getDate();
  const month = dt.getMonth() + 1;
  const year = dt.getFullYear();
  let hours = dt.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const mm = dt.getMinutes().toString().padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${mm} ${ampm}`;
}

function formatRelativeTime(d: string) {
  const ms = Date.now() - new Date(d).getTime();
  if (!Number.isFinite(ms)) return "";
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function recordingDisplayTitle(fileName: string) {
  return fileName.replace(/\.wav$/i, "");
}

function NotesPage({
  setPage,
  selectedModel,
  onSelectedModelChange,
}: {
  setPage: (p: Page) => void;
  selectedModel: string;
  onSelectedModelChange: (model: string) => void;
}) {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [summaryByTranscript, setSummaryByTranscript] = useState<Record<string, SummaryItem>>({});
  const [summarizingFiles, setSummarizingFiles] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [textByFile, setTextByFile] = useState<Record<string, string>>({});
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [viewingSummaryId, setViewingSummaryId] = useState<string | null>(null);
  const [viewedSummary, setViewedSummary] = useState<SummaryItem | null>(null);
  const [summaryViewerLoading, setSummaryViewerLoading] = useState(false);
  const { availableModels, modelsLoading, modelsError } = useAvailableModels();

  const openSummaryViewer = async (id: string, fallback?: SummaryItem) => {
    setViewingSummaryId(id);
    setSummaryViewerLoading(true);
    setViewedSummary(fallback ?? null);
    try {
      const summary = await fetchSummary(id);
      setViewedSummary(summary);
      if (summary.transcriptFileName) {
        setSummaryByTranscript((prev) => ({ ...prev, [summary.transcriptFileName]: summary }));
      }
    } catch (e) {
      if (!fallback) {
        setViewingSummaryId(null);
        setViewedSummary(null);
        toast.error((e as Error).message || "Could not load summary");
      }
    } finally {
      setSummaryViewerLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listTranscripts()
      .then((transcripts) => {
        if (!cancelled) setItems(transcripts);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    listSummaries()
      .then((summaries) => {
        if (cancelled) return;
        setSummaryByTranscript((prev) => ({ ...summariesByTranscript(summaries), ...prev }));
      })
      .catch(() => {
        /* Summarize actions still work; map stays empty until generate succeeds. */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const openTranscript = async (fileName: string) => {
    setViewingFile(fileName);
    setLoadError(null);
    if (textByFile[fileName]) return;

    setLoadingFile(fileName);
    try {
      const text = await fetchTranscript(fileName);
      setTextByFile((prev) => ({ ...prev, [fileName]: text }));
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoadingFile(null);
    }
  };

  const handleSummarize = async (t: TranscriptItem) => {
    if (summaryByTranscript[t.fileName] || summarizingFiles[t.fileName]) return;
    setSummarizingFiles((prev) => ({ ...prev, [t.fileName]: true }));
    try {
      const modelToUse = selectedModel === "auto" ? undefined : selectedModel;
      const summary = await generateSummary(t.fileName, modelToUse);
      setSummaryByTranscript((prev) => ({ ...prev, [t.fileName]: summary }));
      toast.success(`Summary ready for ${summary.title || t.title}`, {
        action: {
          label: "View",
          onClick: () => void openSummaryViewer(summary.id, summary),
        },
      });
    } catch (e) {
      toast.error((e as Error).message || "Could not generate summary");
    } finally {
      setSummarizingFiles((prev) => {
        const next = { ...prev };
        delete next[t.fileName];
        return next;
      });
    }
  };

  const handleResummarize = async (t: TranscriptItem) => {
    if (summarizingFiles[t.fileName]) return;
    const modelToUse = selectedModel === "auto" ? undefined : selectedModel;
    const modelLabel = summarizationModelLabel(selectedModel);
    setSummarizingFiles((prev) => ({ ...prev, [t.fileName]: true }));
    const toastId = toast.loading(`Resummarizing with ${modelLabel}…`);
    try {
      const summary = await generateSummary(t.fileName, modelToUse, { force: true });
      setSummaryByTranscript((prev) => ({ ...prev, [t.fileName]: summary }));
      if (viewingSummaryId === summary.id) setViewedSummary(summary);
      toast.success(`Summary updated for ${summary.title || t.title}`, {
        id: toastId,
        action: {
          label: "View",
          onClick: () => void openSummaryViewer(summary.id, summary),
        },
      });
    } catch (e) {
      toast.error((e as Error).message || "Could not resummarize", { id: toastId });
    } finally {
      setSummarizingFiles((prev) => {
        const next = { ...prev };
        delete next[t.fileName];
        return next;
      });
    }
  };

  const handleUploadFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".txt")) {
      toast.error("Only .txt files are accepted");
      return;
    }
    setUploading(true);
    try {
      const item = await uploadTranscript(file);
      setItems((prev) => [item, ...prev.filter((t) => t.fileName !== item.fileName)]);
      toast.success(`Uploaded “${item.title}”`);
    } catch (e) {
      toast.error((e as Error).message || "Upload failed");
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.type.toLowerCase().includes(q) ||
          t.fileName.toLowerCase().includes(q),
      )
    : items;
  const { page, totalPages, pageItems, setPage: setListPage } = useListPagination(filtered, query);

  const activeItem = items.find((t) => t.fileName === viewingFile);
  const activeText = viewingFile ? textByFile[viewingFile] : "";

  const transcriptSearchPlaceholder = listSearchPlaceholder(
    loading ? undefined : items.length,
    "transcript",
  );

  return (
    <ListPageShell>
      <PageHeader
        title="Transcripts"
        description="Speaker-labeled transcripts from your recordings"
        action={
          <div className="flex shrink-0 items-center gap-3">
            <SummarizationModelSelect
              selectedModel={selectedModel}
              onSelectedModelChange={onSelectedModelChange}
              availableModels={availableModels}
              modelsLoading={modelsLoading}
              modelsError={modelsError}
            />
            <input
              ref={uploadInputRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={(e) => void handleUploadFile(e.target.files?.[0])}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => uploadInputRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </div>
        }
      />

      <LlmSetupBanner setPage={setPage} />

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && (
        <>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder={transcriptSearchPlaceholder}
            ariaLabel="Search transcripts"
          />
          <div className={cn("relative", TRANSCRIPT_RESUMMARIZE_GUTTER)}>
            <div className="rounded-md border">
              <Table className={LIST_TABLE_CLASS} containerClassName="overflow-visible">
              <TableHeader>
                <TableRow>
                  <TableHead className={LIST_COL_TITLE_HEAD}>Title</TableHead>
                  <TableHead className={LIST_COL_DATE}>Date</TableHead>
                  <TableHead className={LIST_COL_ACTIONS_TRANSCRIPTS} />
                </TableRow>
              </TableHeader>
              <TableBody>
                <ListTableSkeleton variant="transcripts" />
              </TableBody>
            </Table>
            </div>
          </div>
        </>
      )}

      {!loading && !error && items.length === 0 && (
        <ListEmptyState
          message="No transcripts yet — record a meeting first"
          onCta={() => setPage("recording")}
        />
      )}

      {!loading && items.length > 0 && (
        <>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder={transcriptSearchPlaceholder}
            ariaLabel="Search transcripts"
          />
          <div className={cn("relative", TRANSCRIPT_RESUMMARIZE_GUTTER)}>
            <div className="rounded-md border">
              <Table className={LIST_TABLE_CLASS} containerClassName="overflow-visible">
              <TableHeader>
                <TableRow>
                  <TableHead className={LIST_COL_TITLE_HEAD}>Title</TableHead>
                  <TableHead className={LIST_COL_DATE}>Date</TableHead>
                  <TableHead className={LIST_COL_ACTIONS_TRANSCRIPTS} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                      No transcripts match your search
                    </TableCell>
                  </TableRow>
                ) : (
                  pageItems.map((t) => {
                    const existing = summaryByTranscript[t.fileName];
                    const busy = !!summarizingFiles[t.fileName];
                    return (
                      <TableRow
                        key={t.fileName}
                        className="relative cursor-pointer hover:bg-muted/50"
                        onClick={() => void openTranscript(t.fileName)}
                      >
                        <TableCell className={LIST_COL_TITLE_CELL}>
                          <TruncatedTitle
                            title={t.title}
                            subtitle={formatRelativeTime(t.lastModified)}
                          />
                        </TableCell>
                        <TableCell className={cn("text-muted-foreground", LIST_COL_DATE)}>
                          {formatDate(t.lastModified)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "relative overflow-visible text-right",
                            LIST_COL_ACTIONS_TRANSCRIPTS,
                          )}
                        >
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              className="px-4"
                              onClick={(e) => {
                                e.stopPropagation();
                                void openTranscript(t.fileName);
                              }}
                            >
                              View
                            </Button>
                            {existing ? (
                              <>
                                <Button
                                  size="sm"
                                  className={cn(SUMMARIZE_ACTION_BTN, SUMMARIZE_FILLED)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void openSummaryViewer(existing.id, existing);
                                  }}
                                >
                                  <Sparkles className="h-3.5 w-3.5 shrink-0" />
                                  View Summary
                                </Button>
                                <span className="sm:hidden">
                                  <ResummarizeIconButton
                                    busy={busy}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleResummarize(t);
                                    }}
                                  />
                                </span>
                              </>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                className={cn(SUMMARIZE_ACTION_BTN, SUMMARIZE_OUTLINE)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleSummarize(t);
                                }}
                              >
                                {busy ? (
                                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                                ) : (
                                  <Sparkles className="h-3.5 w-3.5 shrink-0" />
                                )}
                                {busy ? "Summarizing…" : "Summarize"}
                              </Button>
                            )}
                          </div>
                          {existing ? (
                            <div className="absolute top-1/2 left-full z-10 ml-3 hidden -translate-y-1/2 sm:block">
                              <ResummarizeIconButton
                                busy={busy}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleResummarize(t);
                                }}
                              />
                            </div>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            </div>
          </div>
          <ListPagination page={page} totalPages={totalPages} onPageChange={setListPage} />
        </>
      )}

      <DetailViewerDialog
        open={viewingFile !== null}
        onOpenChange={(open) => !open && setViewingFile(null)}
        title={activeItem?.title ?? "Transcript"}
        description={activeItem ? formatDate(activeItem.lastModified) : undefined}
        copyText={activeText || null}
      >
        {loadingFile === viewingFile && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading transcript…
          </div>
        )}
        {loadError && viewingFile && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Could not load transcript</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        {viewingFile && textByFile[viewingFile] && (
          <div className="min-h-0 max-h-[60vh] flex-1 overflow-y-auto rounded-md border bg-muted/20">
            <pre className="p-4 text-xs whitespace-pre-wrap font-mono">{textByFile[viewingFile]}</pre>
          </div>
        )}
      </DetailViewerDialog>

      <DetailViewerDialog
        key={viewedSummary?.lastModified ?? viewingSummaryId ?? "closed"}
        open={viewingSummaryId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewingSummaryId(null);
            setViewedSummary(null);
          }
        }}
        title={viewedSummary?.title ?? "AI Summary"}
        description={viewedSummary ? formatDate(viewedSummary.lastModified) : undefined}
        copyText={viewedSummary?.text}
      >
        {summaryViewerLoading && !viewedSummary ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading summary…
          </div>
        ) : null}
        {viewedSummary && (
          <div className="min-h-0 max-h-[60vh] flex-1 overflow-y-auto rounded-md border bg-muted/20">
            <pre className="p-4 text-sm whitespace-pre-wrap">{viewedSummary.text}</pre>
          </div>
        )}
      </DetailViewerDialog>
    </ListPageShell>
  );
}

function RecordingsPage({ setPage }: { setPage: (p: Page) => void }) {
  const [items, setItems] = useState<RecordingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [playingFile, setPlayingFile] = useState<string | null>(null);

  useEffect(() => {
    listRecordings()
      .then(setItems)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter((r) => r.fileName.toLowerCase().includes(q))
    : items;
  const { page, totalPages, pageItems, setPage: setListPage } = useListPagination(filtered, query);

  const activeItem = items.find((r) => r.fileName === playingFile);

  const recordingSearchPlaceholder = listSearchPlaceholder(
    loading ? undefined : items.length,
    "recording",
  );

  return (
    <ListPageShell>
      <PageHeader
        title="Recordings"
        description="Play recordings in the browser or download WAV files"
      />

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && (
        <>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder={recordingSearchPlaceholder}
            ariaLabel="Search recordings"
          />
          <div className="rounded-md border">
            <Table className={LIST_TABLE_CLASS}>
              <TableHeader>
                <TableRow>
                  <TableHead className={LIST_COL_TITLE_HEAD}>Title</TableHead>
                  <TableHead className={LIST_COL_DURATION}>Duration</TableHead>
                  <TableHead className={LIST_COL_DATE}>Date</TableHead>
                  <TableHead className={LIST_COL_ACTIONS_RECORDINGS} />
                </TableRow>
              </TableHeader>
              <TableBody>
                <ListTableSkeleton variant="recordings" />
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {!loading && !error && items.length === 0 && (
        <ListEmptyState message="No recordings yet" onCta={() => setPage("recording")} />
      )}

      {!loading && items.length > 0 && (
        <>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder={recordingSearchPlaceholder}
            ariaLabel="Search recordings"
          />
          <div className="rounded-md border">
            <Table className={LIST_TABLE_CLASS}>
              <TableHeader>
                <TableRow>
                  <TableHead className={LIST_COL_TITLE_HEAD}>Title</TableHead>
                  <TableHead className={LIST_COL_DURATION}>Duration</TableHead>
                  <TableHead className={LIST_COL_DATE}>Date</TableHead>
                  <TableHead className={LIST_COL_ACTIONS_RECORDINGS} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                      No recordings match your search
                    </TableCell>
                  </TableRow>
                ) : (
                  pageItems.map((r) => {
                    const title = recordingDisplayTitle(r.fileName);
                    return (
                      <TableRow
                        key={r.fileName}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setPlayingFile(r.fileName)}
                      >
                        <TableCell className={LIST_COL_TITLE_CELL}>
                          <TruncatedTitle
                            title={title}
                            subtitle={formatRelativeTime(r.lastModified)}
                          />
                        </TableCell>
                        <TableCell className={cn("tabular-nums", LIST_COL_DURATION)}>
                          {formatDuration(r.durationSeconds)}
                        </TableCell>
                        <TableCell className={cn("text-muted-foreground", LIST_COL_DATE)}>
                          {formatDate(r.lastModified)}
                        </TableCell>
                        <TableCell className={cn("p-2", LIST_COL_ACTIONS_RECORDINGS)}>
                          <div className="flex flex-row flex-nowrap items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="shrink-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPlayingFile(r.fileName);
                              }}
                            >
                              Play
                            </Button>
                            <Button variant="outline" size="sm" className="shrink-0" asChild>
                              <a
                                href={recordingDownloadUrl(r.fileName)}
                                download
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Download className="h-3.5 w-3.5" />
                                Download
                              </a>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
          <ListPagination page={page} totalPages={totalPages} onPageChange={setListPage} />
        </>
      )}

      <Dialog open={playingFile !== null} onOpenChange={(open) => !open && setPlayingFile(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {activeItem ? recordingDisplayTitle(activeItem.fileName) : "Recording"}
            </DialogTitle>
            <DialogDescription>
              {activeItem
                ? `${formatDuration(activeItem.durationSeconds)} · ${formatDate(activeItem.lastModified)}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {playingFile && (
            <audio
              controls
              autoPlay
              preload="metadata"
              className="w-full"
              src={recordingPlayUrl(playingFile)}
            >
              Your browser does not support audio playback
            </audio>
          )}
        </DialogContent>
      </Dialog>
    </ListPageShell>
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
  const [accurate, setAccurateState] = useState(false);
  const [transcriptionAvailable, setTranscriptionAvailable] = useState(false);
  const transcriptionPickRef = useRef<AvailableTranscriptionEngine | null>(null);
  // Default on; remembered so the slider matches the last Record choice.
  const [announceInChat, setAnnounceInChat] = useState(
    () => localStorage.getItem("announceRecordingInChat") !== "0",
  );
  const [mode, setMode] = useState<Mode>("idle");
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [countdown, setCountdown] = useState(5);
  const [returnProgress, setReturnProgress] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [localMicLevel, setLocalMicLevel] = useState(0);
  const [localMicOpen, setLocalMicOpen] = useState(true);
  const [aloneLeaveInSeconds, setAloneLeaveInSeconds] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const joinedAtRef = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [cfg, engines] = await Promise.all([getBotConfig(), listTranscriptionEngines()]);
        const pick =
          engines.available.find((e) => e.id === cfg.transcription.saved.engine) ??
          engines.available[0] ??
          null;
        transcriptionPickRef.current = pick;
        const hasEngines = engines.available.length > 0;
        setTranscriptionAvailable(hasEngines);

        const legacyPref = localStorage.getItem("whisperPref") === "1";
        const saved = cfg.transcription.saved;

        if (hasEngines && legacyPref && !saved.engine && pick) {
          await saveBotConfig({
            transcriptionEnabled: true,
            transcriptionEngine: pick.id,
            transcriptionModel: pick.defaultModel,
            transcriptionPythonPath: pick.pythonPath,
            transcriptionDevice: saved.device,
          });
          localStorage.removeItem("whisperPref");
          setAccurateState(true);
          return;
        }

        setAccurateState(hasEngines && saved.enabled);
        if (!hasEngines && saved.enabled) {
          await saveBotConfig({ transcriptionEnabled: false });
        }
      } catch {
        setTranscriptionAvailable(false);
        setAccurateState(false);
      }
    })();
  }, []);

  const setAccurate = (next: boolean) => {
    if (!transcriptionAvailable) return;

    void (async () => {
      if (!next) {
        setAccurateState(false);
        try {
          await saveBotConfig({ transcriptionEnabled: false });
        } catch (e) {
          toast.error((e as Error).message);
        }
        return;
      }

      try {
        const cfg = await getBotConfig();
        const saved = cfg.transcription.saved;
        const pick =
          transcriptionPickRef.current ??
          (saved.engine
            ? (await listTranscriptionEngines()).available.find((e) => e.id === saved.engine)
            : null);

        if (!pick) {
          toast.error("Pick a transcription engine in Settings first.");
          return;
        }

        transcriptionPickRef.current = pick;
        setAccurateState(true);
        await saveBotConfig({
          transcriptionEnabled: true,
          transcriptionEngine: pick.id,
          transcriptionModel:
            saved.model && pick.models.includes(saved.model) ? saved.model : pick.defaultModel,
          transcriptionPythonPath: pick.pythonPath,
          transcriptionDevice: saved.device,
        });
      } catch (e) {
        setAccurateState(false);
        toast.error((e as Error).message);
      }
    })();
  };

  useEffect(() => {
    localStorage.setItem("announceRecordingInChat", announceInChat ? "1" : "0");
  }, [announceInChat]);

  useEffect(() => {
    getBotStatus()
      .then((s) => {
        if (s.state === "in_meeting" || s.state === "joining") {
          setMode("recording");
          if (s.joinedAt) joinedAtRef.current = new Date(s.joinedAt).getTime();
          if (s.meetingUrl) setUrl(s.meetingUrl);
        }
      })
      .catch(() => undefined);
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
  useEffect(() => {
    if (mode !== "recording" && mode !== "saving" && mode !== "joining") {
      setAudioLevel(0);
      setAloneLeaveInSeconds(null);
      return;
    }
    const id = setInterval(() => {
      getBotStatus()
        .then((s) => {
          if (s.state === "leaving") {
            if (mode === "recording" || mode === "joining") {
              setPaused(false);
              setMode("saving");
            }
            setAudioLevel(0);
            setAloneLeaveInSeconds(null);
            return;
          }
          if (s.state === "idle" || s.state === "error") {
            if (mode === "recording" || mode === "saving" || mode === "joining") {
              joinedAtRef.current = null;
              setPaused(false);
              setAudioLevel(0);
              setAloneLeaveInSeconds(null);
              if (s.state === "error" && s.lastError) {
                setError(s.lastError);
                toast.error(s.lastError);
              }
              setMode("saved");
            }
            return;
          }
          if (mode === "saving") return;
          if (typeof s.paused === "boolean") setPaused(s.paused);
          if (typeof s.localMicOpen === "boolean") setLocalMicOpen(s.localMicOpen);
          setAudioLevel(typeof s.audioLevel === "number" ? s.audioLevel : 0);
          setAloneLeaveInSeconds(
            typeof s.aloneLeaveInSeconds === "number" ? s.aloneLeaveInSeconds : null,
          );
        })
        .catch(() => undefined);
    }, 200);
    return () => clearInterval(id);
  }, [mode]);

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
    const totalMs = 5_000;
    const started = Date.now();
    setCountdown(5);
    setReturnProgress(100);

    let raf = 0;
    const tick = () => {
      const left = Math.max(0, totalMs - (Date.now() - started));
      setReturnProgress((left / totalMs) * 100);
      setCountdown(Math.max(0, Math.ceil(left / 1000)));
      if (left <= 0) {
        setMode("idle");
        setUrl("");
        setSeconds(0);
        joinedAtRef.current = null;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  const join = async (): Promise<boolean> => {
    if (!url.trim()) return false;
    setError(null);
    try {
      const cfg = await getBotConfig();
      if (!cfg.localParticipantName.trim()) {
        toast.error("Set your Teams display name first (required for mute-aware recording).");
        return false;
      }
    } catch {
      // config endpoint unavailable — still attempt join
    }
    setMode("joining");
    try {
      const status = await joinMeeting(url.trim(), "e& Assistant", {
        announceRecordingInChat: announceInChat,
      });
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
      const message = (e as Error).message;
      setError(message);
      toast.error(message);
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
      const message = (e as Error).message;
      setError(message);
      toast.error(message);
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
      const message = (e as Error).message;
      setError(message);
      toast.error(message);
    }
  };

  return {
    url,
    setUrl,
    accurate,
    setAccurate,
    transcriptionAvailable,
    announceInChat,
    setAnnounceInChat,
    mode,
    paused,
    setPaused,
    togglePause,
    seconds,
    countdown,
    returnProgress,
    error,
    aloneLeaveInSeconds,
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

function RecorderPanel({ size = "mini", overlay = false }: { size?: "mini" | "large"; overlay?: boolean }) {
  const r = useRecorderContext();
  const large = size === "large";
  const compact = !large;

  return (
    <div className={cn(large ? "space-y-5" : overlay ? "space-y-1.5" : "space-y-2.5")}>
      {r.error && (
        <Alert variant="destructive" className={compact ? "py-2" : undefined}>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle className={compact ? "text-xs" : undefined}>Error</AlertTitle>
          <AlertDescription className={compact ? "text-xs" : undefined}>{r.error}</AlertDescription>
        </Alert>
      )}

      {r.mode === "idle" && (
        <>
          <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="space-y-2">
            <Label htmlFor="meeting-url" className={compact ? "text-xs" : undefined}>
              Paste Meeting URL:
            </Label>
            <Input
              id="meeting-url"
              name="teams-meeting-link"
              type="text"
              inputMode="url"
              value={r.url}
              onChange={(e) => r.setUrl(e.target.value)}
              placeholder="https://teams.microsoft.com/..."
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              data-lpignore="true"
              data-1p-ignore
              className={compact ? "h-8 text-xs" : undefined}
            />
          </form>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Switch
                id="accurate-transcription"
                checked={r.accurate}
                onCheckedChange={r.setAccurate}
                disabled={!r.transcriptionAvailable}
                className={compact ? "scale-90 origin-left" : undefined}
              />
              <Label
                htmlFor="accurate-transcription"
                className={cn(
                  "cursor-pointer",
                  compact ? "text-[11px]" : "text-xs",
                  !r.transcriptionAvailable && "text-muted-foreground cursor-not-allowed",
                )}
              >
                More Accurate Transcription
              </Label>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className={compact ? "h-7 w-7 shrink-0" : "h-8 w-8 shrink-0"}>
                  <Info className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                  <span className="sr-only">Transcription info</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[240px] text-center">
                {r.transcriptionAvailable
                  ? "Runs a local STT pass after the meeting ends. Takes longer and uses more RAM/CPU."
                  : "No transcription engine detected on this PC. Install faster-whisper or NeMo in Python, then check Settings."}
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Switch
                id="announce-in-chat"
                checked={r.announceInChat}
                onCheckedChange={r.setAnnounceInChat}
                className={compact ? "scale-90 origin-left" : undefined}
              />
              <Label
                htmlFor="announce-in-chat"
                className={cn("cursor-pointer", compact ? "text-[11px]" : "text-xs")}
              >
                Announce recording in chat
              </Label>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className={compact ? "h-7 w-7 shrink-0" : "h-8 w-8 shrink-0"}>
                  <Info className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                  <span className="sr-only">Chat announce info</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[220px] text-center">
                When on, posts &quot;This meeting is being recorded&quot; in the Teams meeting chat after
                joining. Turn off to skip chat entirely.
              </TooltipContent>
            </Tooltip>
          </div>

          <Button
            variant="destructive"
            className="w-full"
            size={compact ? "sm" : "default"}
            onClick={() => void r.join()}
            disabled={!r.url.trim()}
            aria-label="Start recording"
          >
            <span
              className={cn(
                "inline-flex items-center justify-center rounded-full bg-destructive-foreground/20",
                compact ? "h-5 w-5" : "h-6 w-6",
              )}
            >
              <span
                className={cn("rounded-full bg-destructive-foreground", compact ? "h-2 w-2" : "h-2.5 w-2.5")}
              />
            </span>
            Record
          </Button>
        </>
      )}

      {r.mode === "joining" && (
        <div className="flex flex-col items-center gap-2 py-3">
          <Loader2 className={cn("animate-spin text-destructive", compact ? "h-6 w-6" : "h-8 w-8")} />
          <span className={cn("font-medium", compact ? "text-xs" : "text-sm")}>Joining meeting…</span>
          <span className={cn("text-muted-foreground text-center", compact ? "text-[10px]" : "text-xs")}>
            This can take up to a minute
          </span>
        </div>
      )}

      {(r.mode === "recording" || r.mode === "saving") && (
        <>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {r.mode === "recording" ? (
              <>
                {r.paused ? (
                  <Badge variant="secondary">Paused</Badge>
                ) : (
                  <Badge variant="destructive" className="gap-1.5">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive-foreground opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive-foreground" />
                    </span>
                    Recording
                  </Badge>
                )}
                <span className={cn("font-mono font-semibold tabular-nums", compact ? "text-xs" : "text-sm")}>
                  {format(r.seconds)}
                </span>
              </>
            ) : (
              <Badge variant="secondary" className="animate-pulse">
                Saving…
              </Badge>
            )}
          </div>

          {r.mode === "recording" &&
            r.aloneLeaveInSeconds != null &&
            r.aloneLeaveInSeconds >= 0 && (
              <p
                className={cn(
                  "rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-center text-amber-800 dark:text-amber-200",
                  compact ? "text-[10px] leading-snug" : "text-xs",
                )}
              >
                Bot alone in meeting, leaving in {r.aloneLeaveInSeconds}{" "}
                {r.aloneLeaveInSeconds === 1 ? "second" : "seconds"}
              </p>
            )}

          <SoundWave
            active={r.mode === "recording" && !r.paused}
            level={r.audioLevel}
            large={large}
            compact={overlay}
          />

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              className="flex-1"
              onClick={() => void r.togglePause()}
              disabled={r.mode === "saving"}
              aria-label={r.paused ? "Resume" : "Pause"}
            >
              {r.paused ? <Play /> : <Pause />}
            </Button>
            <Button
              variant="destructive"
              size="icon"
              className="flex-1"
              onClick={() => void r.stop()}
              disabled={r.mode === "saving"}
              aria-label="Stop"
            >
              <Square className="fill-current" />
            </Button>
          </div>
        </>
      )}

      {r.mode === "saved" && (
        <div className={cn("text-center py-1", large ? "space-y-4" : "space-y-2.5")}>
          <div className="flex justify-center">
            <CheckCircle2
              className={cn("text-success", large ? "h-14 w-14" : "h-10 w-10")}
            />
          </div>
          <div className="space-y-1">
            <div className={large ? "text-lg font-semibold" : "text-sm font-semibold"}>Recording Saved</div>
            <div className={cn("text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
              Duration {format(r.seconds)}
            </div>
            <div className={cn("text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
              Saved in Recordings tab
            </div>
          </div>
          <div className={cn("text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
            Returning in <span className="font-mono font-semibold text-foreground">{r.countdown}s</span>
          </div>
          <Progress
            value={r.returnProgress}
            className={cn(compact ? "h-1" : undefined, "[&>div]:transition-none")}
          />
        </div>
      )}
    </div>
  );
}

/* ---------------- Floating mini window ---------------- */

function MeetingAssistantWindow({
  forceVisible = false,
  highest = false,
  miniWindow = false,
  chromeCollapsed,
  dockClassName,
  onChromeCollapseChange,
}: {
  forceVisible?: boolean;
  highest?: boolean;
  /** Dedicated mini popup (?mini=1) or same-window compact mode — fixed size, non-resizable. */
  miniWindow?: boolean;
  chromeCollapsed?: boolean;
  dockClassName?: string;
  onChromeCollapseChange?: (collapsed: boolean) => void;
}) {
  const [closed, setClosed] = useState(false);
  const [minimized, setMinimized] = useState(Boolean(chromeCollapsed));

  const minimizedRef = useRef(minimized);
  minimizedRef.current = minimized;
  /** User's minimize preference outside the Record-page force-collapse. */
  const userMinimizedPrefRef = useRef(Boolean(chromeCollapsed));
  const pageForcedRef = useRef(Boolean(chromeCollapsed));

  useEffect(() => {
    if (forceVisible) {
      setClosed(false);
      setMinimized(false);
    }
  }, [forceVisible]);

  // Record page forces the mini chrome collapsed, but must not wipe the user's
  // minimize preference — leaving Record restores whatever they had before.
  useEffect(() => {
    if (forceVisible || highest) return;
    if (chromeCollapsed === undefined) return;

    const forced = chromeCollapsed === true;
    if (forced && !pageForcedRef.current) {
      userMinimizedPrefRef.current = minimizedRef.current;
      setMinimized(true);
    } else if (!forced && pageForcedRef.current) {
      setMinimized(userMinimizedPrefRef.current);
    }
    pageForcedRef.current = forced;
  }, [chromeCollapsed, forceVisible, highest]);

  const collapseCb = useRef(onChromeCollapseChange);
  collapseCb.current = onChromeCollapseChange;
  useEffect(() => {
    collapseCb.current?.(minimized);
  }, [minimized]);

  const toggleMinimized = () => {
    setMinimized((m) => {
      const next = !m;
      // Only persist preference when the page isn't forcing collapse (Record).
      if (!chromeCollapsed) {
        userMinimizedPrefRef.current = next;
      }
      return next;
    });
  };

  if (closed && !forceVisible) return null;

  const fillWindow = miniWindow || highest;

  return (
    <Card
      className={cn(
        "overflow-hidden gap-0 py-0",
        fillWindow
          ? "flex h-full w-full flex-col rounded-none border-0 shadow-none"
          : cn("fixed bottom-4 z-50 w-[280px] shadow-2xl", dockClassName ?? "left-4"),
      )}
    >
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5 bg-foreground text-background text-xs">
        <span className="font-medium truncate">e& Meeting Assistant</span>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-background hover:bg-background/10 hover:text-background"
            onClick={toggleMinimized}
            aria-label={minimized ? "Expand" : "Minimize"}
            title={minimized ? "Expand" : "Minimize"}
          >
            {minimized ? <ChevronUp className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
          </Button>
          {!forceVisible && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-background hover:bg-background/10 hover:text-background"
              onClick={() => setClosed(true)}
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {!minimized && (
        <CardContent
          className={cn(
            "px-3 pt-1",
            fillWindow ? "flex flex-1 flex-col justify-center pb-2" : "pb-3",
          )}
        >
          <RecorderPanel size="mini" overlay={fillWindow} />
        </CardContent>
      )}
    </Card>
  );
}

/* ---------------- Sound wave ---------------- */

function SoundWave({
  active,
  level = 0,
  large = false,
  compact = false,
}: {
  active: boolean;
  level?: number;
  large?: boolean;
  compact?: boolean;
}) {
  const bars = large ? 40 : compact ? 20 : 24;
  const gated = active ? Math.max(0, (level - 0.015) / 0.25) : 0;
  const strength = Math.min(1, gated);

  return (
    <div
      className={cn(
        "flex items-center justify-center gap-[3px] rounded-md bg-destructive/5 px-2",
        large ? "h-16" : compact ? "h-7" : "h-9",
      )}
    >
      {Array.from({ length: bars }).map((_, i) => {
        const center = bars / 2;
        const dist = Math.abs(i - center) / center;
        const shape = 1 - dist * 0.55;
        const wobble = 0.65 + 0.35 * Math.sin(i * 0.9 + strength * 8);
        const heightPct =
          strength > 0.02 ? Math.max(8, Math.min(95, strength * shape * wobble * 100)) : 8;
        return (
          <span
            key={i}
            className="w-[3px] rounded-full bg-destructive"
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
