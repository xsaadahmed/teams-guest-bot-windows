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
  Loader2,
  Download,
  AlertCircle,
  Moon,
  Sun,
  Sparkles,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchTranscript,
  getBotConfig,
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
  saveBotConfig,
  type RecordingItem,
  type TranscriptItem,
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
import { ScrollArea } from "@/components/ui/scroll-area";
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

export const Route = createFileRoute("/")({
  component: Index,
});

type Page = "home" | "recording" | "notes" | "recordings" | "summaries" | "info";

// Outer window size must fit Edge title bar + app chrome + recorder controls (tight).
const OVERLAY_EXPANDED = { width: 280, height: 188 };
const OVERLAY_COLLAPSED = { width: 280, height: 84 };
const OVERLAY_MARGIN = { left: 12, bottom: 12 };

type WindowGeometry = { width: number; height: number; x: number; y: number };

const DEFAULT_MAIN_GEOMETRY: WindowGeometry = { width: 1100, height: 720, x: 80, y: 80 };
const MIN_MAIN_WIDTH = 640;
const MIN_MAIN_HEIGHT = 480;

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

/**
 * null = not probed yet, true = Edge/OS accepts resize or Win32 layout,
 * false = corp/locked browser — use in-page floating card only (no PowerShell spam).
 */
let osWindowLayoutCapable: boolean | null = null;

function overlayTargetRect(collapsed: boolean) {
  const size = collapsed ? OVERLAY_COLLAPSED : OVERLAY_EXPANDED;
  const availLeft = window.screen.availLeft ?? 0;
  const availTop = window.screen.availTop ?? 0;
  const availH = window.screen.availHeight;
  const left = availLeft + OVERLAY_MARGIN.left;
  const top = availTop + Math.max(0, availH - size.height - OVERLAY_MARGIN.bottom);
  return { ...size, left, top };
}

function windowMatchesSize(size: { width: number; height: number }, slack = 56): boolean {
  return (
    Math.abs(window.outerWidth - size.width) <= slack &&
    Math.abs(window.outerHeight - size.height) <= slack + 24
  );
}

function tryBrowserWindowLayout(size: { width: number; height: number }, left: number, top: number): boolean {
  try {
    window.resizeTo(size.width, size.height);
    window.moveTo(left, top);
  } catch {
    return false;
  }
  return windowMatchesSize(size);
}

/**
 * Prefer shrinking the Edge --app window (home). If that fails (common on corporate
 * Edge where resizeTo is a silent no-op and PowerShell is EPERM), fall back to the
 * in-page fixed bottom-left mini card — same as the DevTools floating-div test.
 */
function placeOverlayWindow(collapsed: boolean): "os" | "inpage" {
  const { width, height, left, top } = overlayTargetRect(collapsed);
  const size = { width, height };

  if (osWindowLayoutCapable === false) {
    return "inpage";
  }

  if (tryBrowserWindowLayout(size, left, top)) {
    osWindowLayoutCapable = true;
    void positionUiWindow({ ...size, left, top, topmost: true }).catch(() => undefined);
    return "os";
  }

  // One Win32 attempt on machines where resizeTo fails but PowerShell works.
  if (osWindowLayoutCapable === null) {
    void positionUiWindow({ ...size, left, top, topmost: true })
      .then(() => {
        window.setTimeout(() => {
          if (windowMatchesSize(size)) {
            osWindowLayoutCapable = true;
          } else {
            osWindowLayoutCapable = false;
          }
        }, 200);
      })
      .catch(() => {
        osWindowLayoutCapable = false;
      });
  }

  return "inpage";
}

function restoreMainWindow(g: WindowGeometry | null) {
  const geometry = normalizeMainGeometry(g);
  try {
    window.resizeTo(geometry.width, geometry.height);
    window.moveTo(geometry.x, geometry.y);
  } catch {
    // ignore
  }
  // Skip PowerShell when we already know corp policy blocks it.
  if (osWindowLayoutCapable === false) return;
  void positionUiWindow({
    width: geometry.width,
    height: geometry.height,
    left: geometry.x,
    top: geometry.y,
    topmost: false,
  }).catch(() => {
    osWindowLayoutCapable = false;
  });
}

function exitOverlayMode(
  geometry: WindowGeometry | null,
  onRestored: () => void,
): () => void {
  const g = normalizeMainGeometry(geometry);
  const restore = () => restoreMainWindow(g);
  restore();
  const timers = [50, 120, 220, 400, 800, 1400].map((ms) => window.setTimeout(restore, ms));
  // Resize via Win32 before painting the full app into the tiny overlay frame.
  const reveal = window.setTimeout(onRestored, 260);
  return () => {
    timers.forEach((id) => window.clearTimeout(id));
    window.clearTimeout(reveal);
  };
}

function Index() {
  const [collapsed, setCollapsed] = useState(true);
  const [page, setPage] = useState<Page>("home");
  const [overlayOnly, setOverlayOnly] = useState(false);
  /** When OS can't shrink Edge (corp), keep the mini recorder as an in-page floating card. */
  const [inPageOverlay, setInPageOverlay] = useState(false);
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
      await saveBotConfig(trimmed);
      setNamePromptOpen(false);
      toast.success(`Saved as "${trimmed}"`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setNameSaving(false);
    }
  };

  // On first load of the full UI, clear always-on-top when Win32 layout is available.
  useEffect(() => {
    if (osWindowLayoutCapable === false) return;
    const g = captureWindowGeometry();
    void positionUiWindow({
      width: g.width,
      height: g.height,
      left: g.x,
      top: g.y,
      topmost: false,
    }).catch(() => {
      osWindowLayoutCapable = false;
    });
  }, []);

  useEffect(() => {
    if (recorder.mode !== "recording" || !pendingOverlay.current) return;

    const t = window.setTimeout(() => {
      pendingOverlay.current = false;
      if (!savedGeometry.current) {
        savedGeometry.current = captureWindowGeometry();
      }
      miniCollapsedRef.current = false;
      setOverlayOnly(true);
    }, 1500);

    return () => window.clearTimeout(t);
  }, [recorder.mode]);

  // Probe OS resize once; if blocked, lock into in-page floating card (Option A).
  useEffect(() => {
    if (!overlayOnly) return;

    const apply = () => {
      const mode = placeOverlayWindow(miniCollapsedRef.current);
      if (mode === "inpage" || osWindowLayoutCapable === false) {
        setInPageOverlay(true);
      } else {
        setInPageOverlay(false);
      }
    };

    apply();
    // Few short retries only while capability is still unknown (home Edge often needs a beat).
    const delays =
      osWindowLayoutCapable === false ? [] : [80, 200, 500, 1000];
    const timers = delays.map((ms) =>
      window.setTimeout(() => {
        if (osWindowLayoutCapable === false) {
          setInPageOverlay(true);
          return;
        }
        apply();
      }, ms),
    );
    // After probes, decide: OS-shrunk window vs in-page floating card.
    const finalize = window.setTimeout(() => {
      const size = miniCollapsedRef.current ? OVERLAY_COLLAPSED : OVERLAY_EXPANDED;
      if (windowMatchesSize(size)) {
        osWindowLayoutCapable = true;
        setInPageOverlay(false);
      } else {
        osWindowLayoutCapable = false;
        setInPageOverlay(true);
      }
    }, 1400);

    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      window.clearTimeout(finalize);
    };
  }, [overlayOnly]);

  useEffect(() => {
    if (!overlayOnly) return;
    if (recorder.mode !== "idle" && recorder.mode !== "saved") return;

    const g = savedGeometry.current;
    savedGeometry.current = null;
    return exitOverlayMode(g, () => {
      setOverlayOnly(false);
      setInPageOverlay(false);
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
      <div
        className={cn(
          "h-full w-full overflow-hidden",
          // In-page fallback: leave a quiet canvas so the fixed mini card reads as floating.
          inPageOverlay ? "bg-transparent" : "bg-background",
        )}
      >
        <MeetingAssistantWindow
          forceVisible
          highest
          preferInPage={inPageOverlay}
          onChromeCollapseChange={(miniCollapsed) => {
            miniCollapsedRef.current = miniCollapsed;
            const mode = placeOverlayWindow(miniCollapsed);
            if (mode === "inpage") setInPageOverlay(true);
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
          {page === "notes" && <NotesPage setPage={setPage} />}
          {page === "recordings" && <RecordingsPage setPage={setPage} />}
          {page === "summaries" && <SummariesPage setPage={setPage} />}
          {page === "info" && <AboutPage />}
        </SidebarInset>
        <DockedMeetingAssistant chromeCollapsed={page === "recording"} />
      </SidebarProvider>
    </>,
  );
}

/** Floats the mini recorder just to the right of the sidebar so it never covers Dark mode / About. */
function DockedMeetingAssistant({ chromeCollapsed }: { chromeCollapsed: boolean }) {
  const { state } = useSidebar();
  // Explicit rem values (match SIDEBAR_WIDTH / SIDEBAR_WIDTH_ICON) — more reliable than CSS vars on fixed elements.
  const leftClass = state === "expanded" ? "left-[12.75rem]" : "left-[3.75rem]";
  return <MeetingAssistantWindow chromeCollapsed={chromeCollapsed} dockClassName={leftClass} />;
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
              isActive={page === "info"}
              tooltip="About"
              onClick={() => setPage("info")}
              className={
                page === "info"
                  ? "bg-sidebar-accent font-semibold shadow-sm ring-1 ring-sidebar-border"
                  : undefined
              }
            >
              <Info />
              <span>About</span>
            </SidebarMenuButton>
            {page === "info" && (
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

/** Wide pages (Home grid, Summaries). */
const PAGE_WIDE = "mx-auto w-full max-w-[1400px] px-6 py-8 lg:px-10";
/** Single centered shell for Transcripts + Recordings list pages. */
const LIST_PAGE = "mx-auto w-full max-w-5xl px-6 py-8";
/** Summaries table block (unchanged from round 3). */
const TABLE_BLOCK = "max-w-3xl";
const LIST_PAGE_SIZE = 18;

const BROWSE_CARD_ACCENT = "text-muted-foreground bg-secondary";
const BROWSE_CARD_CLASS =
  "border-border/80 bg-secondary/30 hover:border-border hover:bg-secondary/40 hover:shadow-sm";

/** Narrow/form pages (Record, About) — fill the inset and center the panel. */
function PageFormCenter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 min-h-0 w-full items-center justify-center px-6 py-8">
      {children}
    </div>
  );
}

function PageWide({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn(PAGE_WIDE, className)}>{children}</div>;
}

function ListPageShell({ children }: { children: React.ReactNode }) {
  return <div className={LIST_PAGE}>{children}</div>;
}

function PageHeader({
  title,
  description,
  count,
  countLabel,
}: {
  title: string;
  description?: string;
  count?: number;
  countLabel?: string;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold leading-none">{title}</h1>
        {count != null && countLabel && (
          <Badge
            variant="secondary"
            className="shrink-0 leading-none translate-y-[-1px]"
          >
            {count} {countLabel}
          </Badge>
        )}
      </div>
      {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
    </div>
  );
}

function ListSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative mb-4 max-w-sm">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8"
        aria-label={placeholder}
      />
    </div>
  );
}

function TruncatedTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="min-w-0 max-w-md">
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
  onRecord,
}: {
  message: string;
  onRecord: () => void;
}) {
  return (
    <div className="flex max-w-md flex-col items-center rounded-md border border-dashed bg-muted/20 px-6 py-12 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button className="mt-4" variant="default" onClick={onRecord}>
        <Mic className="h-4 w-4" />
        Go to Record
      </Button>
    </div>
  );
}

function ListTableSkeleton({ variant }: { variant: "transcripts" | "recordings" }) {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <TableRow key={i}>
          <TableCell className="max-w-md">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-16 mt-2" />
          </TableCell>
          {variant === "recordings" && (
            <TableCell>
              <Skeleton className="h-4 w-10" />
            </TableCell>
          )}
          <TableCell>
            <Skeleton className="h-4 w-28" />
          </TableCell>
          <TableCell className="text-right">
            <Skeleton className="ml-auto h-8 w-16" />
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

type SummaryItem = {
  id: string;
  title: string;
  text: string;
  lastModified: string;
};

function SummariesPage({ setPage }: { setPage: (p: Page) => void }) {
  const [items] = useState<SummaryItem[]>([]);
  const [query, setQuery] = useState("");
  const [viewingId, setViewingId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter((s) => s.title.toLowerCase().includes(q) || s.text.toLowerCase().includes(q))
    : items;
  const { page, totalPages, pageItems, setPage: setListPage } = useListPagination(filtered, query);

  const activeItem = items.find((s) => s.id === viewingId);

  return (
    <PageWide>
      <PageHeader
        title="AI Summaries"
        description="AI-generated summaries of your recorded meetings"
        count={items.length > 0 ? items.length : undefined}
        countLabel="summaries"
      />

      {items.length === 0 ? (
        <ListEmptyState
          message="No AI summaries yet — record a meeting first"
          onRecord={() => setPage("recording")}
        />
      ) : (
        <>
          <ListSearch value={query} onChange={setQuery} placeholder="Search summaries" />
          <div className={cn("rounded-md border", TABLE_BLOCK)}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-md">Title</TableHead>
                  <TableHead className="w-[11rem] whitespace-nowrap">Date</TableHead>
                  <TableHead className="w-[5.5rem]" />
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
                      onClick={() => setViewingId(s.id)}
                    >
                      <TableCell className="max-w-md">
                        <TruncatedTitle
                          title={s.title}
                          subtitle={formatRelativeTime(s.lastModified)}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap">
                        {formatDate(s.lastModified)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setViewingId(s.id);
                          }}
                        >
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className={TABLE_BLOCK}>
            <ListPagination page={page} totalPages={totalPages} onPageChange={setListPage} />
          </div>
        </>
      )}

      <Dialog open={viewingId !== null} onOpenChange={(open) => !open && setViewingId(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader className="gap-2">
            <div className="flex items-start justify-between gap-2 pr-8">
              <div className="min-w-0">
                <DialogTitle>{activeItem?.title ?? "AI Summary"}</DialogTitle>
                <DialogDescription>
                  {activeItem ? formatDate(activeItem.lastModified) : ""}
                </DialogDescription>
              </div>
              {activeItem && <CopyButton text={activeItem.text} />}
            </div>
          </DialogHeader>
          {activeItem && (
            <ScrollArea className="flex-1 min-h-0 max-h-[60vh] rounded-md border bg-muted/20">
              <pre className="p-4 text-sm whitespace-pre-wrap">{activeItem.text}</pre>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </PageWide>
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

function AboutPage() {
  return (
    <PageFormCenter>
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-semibold">About</h1>
        <p className="text-sm text-muted-foreground mt-1">e&amp; Meeting Assistant — Teams guest bot</p>
        <Card className="mt-6">
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

function NotesPage({ setPage }: { setPage: (p: Page) => void }) {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [textByFile, setTextByFile] = useState<Record<string, string>>({});
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    listTranscripts()
      .then(setItems)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
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

  return (
    <ListPageShell>
      <PageHeader
        title="Transcripts"
        description="Speaker-labeled transcripts from your recordings"
        count={loading ? undefined : items.length}
        countLabel="transcripts"
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
          <ListSearch value={query} onChange={setQuery} placeholder="Search transcripts" />
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-md">Title</TableHead>
                  <TableHead className="w-[11rem] whitespace-nowrap">Date</TableHead>
                  <TableHead className="w-[5.5rem]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <ListTableSkeleton variant="transcripts" />
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {!loading && !error && items.length === 0 && (
        <ListEmptyState
          message="No transcripts yet — record a meeting first"
          onRecord={() => setPage("recording")}
        />
      )}

      {!loading && items.length > 0 && (
        <>
          <ListSearch value={query} onChange={setQuery} placeholder="Search transcripts" />
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-md">Title</TableHead>
                  <TableHead className="w-[11rem] whitespace-nowrap">Date</TableHead>
                  <TableHead className="w-[5.5rem]" />
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
                  pageItems.map((t) => (
                    <TableRow
                      key={t.fileName}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => void openTranscript(t.fileName)}
                    >
                      <TableCell className="max-w-md">
                        <TruncatedTitle
                          title={t.title}
                          subtitle={formatRelativeTime(t.lastModified)}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap">
                        {formatDate(t.lastModified)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openTranscript(t.fileName);
                          }}
                        >
                          View
                        </Button>
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

      <Dialog open={viewingFile !== null} onOpenChange={(open) => !open && setViewingFile(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader className="gap-2">
            <div className="flex items-start justify-between gap-2 pr-8">
              <div className="min-w-0">
                <DialogTitle>{activeItem?.title ?? "Transcript"}</DialogTitle>
                <DialogDescription>
                  {activeItem ? formatDate(activeItem.lastModified) : ""}
                </DialogDescription>
              </div>
              {activeText && <CopyButton text={activeText} />}
            </div>
          </DialogHeader>
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
            <ScrollArea className="flex-1 min-h-0 max-h-[60vh] rounded-md border bg-muted/20">
              <pre className="p-4 text-xs whitespace-pre-wrap font-mono">{textByFile[viewingFile]}</pre>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
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

  return (
    <ListPageShell>
      <PageHeader
        title="Recordings"
        description="Play recordings in the browser or download WAV files"
        count={loading ? undefined : items.length}
        countLabel="recordings"
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
          <ListSearch value={query} onChange={setQuery} placeholder="Search recordings" />
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-md">Title</TableHead>
                  <TableHead className="w-[5.5rem] whitespace-nowrap">Duration</TableHead>
                  <TableHead className="w-[11rem] whitespace-nowrap">Date</TableHead>
                  <TableHead className="w-[11.5rem]" />
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
        <ListEmptyState message="No recordings yet" onRecord={() => setPage("recording")} />
      )}

      {!loading && items.length > 0 && (
        <>
          <ListSearch value={query} onChange={setQuery} placeholder="Search recordings" />
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-md">Title</TableHead>
                  <TableHead className="w-[5.5rem] whitespace-nowrap">Duration</TableHead>
                  <TableHead className="w-[11rem] whitespace-nowrap">Date</TableHead>
                  <TableHead className="w-[11.5rem]" />
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
                        <TableCell className="max-w-md">
                          <TruncatedTitle
                            title={title}
                            subtitle={formatRelativeTime(r.lastModified)}
                          />
                        </TableCell>
                        <TableCell className="tabular-nums whitespace-nowrap">
                          {formatDuration(r.durationSeconds)}
                        </TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">
                          {formatDate(r.lastModified)}
                        </TableCell>
                        <TableCell className="p-2">
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
  const [accurate, setAccurate] = useState(() => localStorage.getItem("whisperPref") === "1");
  // Default on; remembered so the slider matches the last Record choice.
  const [announceInChat, setAnnounceInChat] = useState(
    () => localStorage.getItem("announceRecordingInChat") !== "0",
  );
  const [mode, setMode] = useState<Mode>("idle");
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [countdown, setCountdown] = useState(10);
  const [returnProgress, setReturnProgress] = useState(100);
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
            return;
          }
          if (s.state === "idle" || s.state === "error") {
            if (mode === "recording" || mode === "saving" || mode === "joining") {
              joinedAtRef.current = null;
              setPaused(false);
              setAudioLevel(0);
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
    const totalMs = 10_000;
    const started = Date.now();
    setCountdown(10);
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
          <div className="space-y-2">
            <Label htmlFor="meeting-url" className={compact ? "text-xs" : undefined}>
              Paste Meeting URL:
            </Label>
            <Input
              id="meeting-url"
              type="url"
              value={r.url}
              onChange={(e) => r.setUrl(e.target.value)}
              placeholder="https://teams.microsoft.com/..."
              className={compact ? "h-8 text-xs" : undefined}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Switch
                id="accurate-transcription"
                checked={r.accurate}
                onCheckedChange={r.setAccurate}
                className={compact ? "scale-90 origin-left" : undefined}
              />
              <Label
                htmlFor="accurate-transcription"
                className={cn("cursor-pointer", compact ? "text-[11px]" : "text-xs")}
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
              <TooltipContent side="top" className="max-w-[220px] text-center">
                Will take longer to transcribe and generate summaries and use more RAM and CPU once the
                meeting ends
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
  preferInPage = false,
  chromeCollapsed,
  dockClassName,
  onChromeCollapseChange,
}: {
  forceVisible?: boolean;
  highest?: boolean;
  /**
   * When true, always use the in-page fixed mini card (corporate Edge can't resize
   * the outer window). Ignores osSized / fill-window mode.
   */
  preferInPage?: boolean;
  /** When true, show only the title bar (used on Record page so the large panel is the focus). */
  chromeCollapsed?: boolean;
  /** Overrides default bottom-left docking (e.g. clear of the sidebar). */
  dockClassName?: string;
  onChromeCollapseChange?: (collapsed: boolean) => void;
}) {
  const [closed, setClosed] = useState(false);
  const [minimized, setMinimized] = useState(Boolean(chromeCollapsed));
  // Only fill the Edge window when OS resize actually made it overlay-sized.
  // Otherwise keep a compact card so we don't stretch the mini UI across a full window.
  const [osSized, setOsSized] = useState(false);

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

  useEffect(() => {
    if (!highest || preferInPage) {
      setOsSized(false);
      return;
    }
    const check = () => {
      const maxW = OVERLAY_EXPANDED.width + 48;
      const maxH = OVERLAY_EXPANDED.height + 64;
      setOsSized(window.outerWidth <= maxW && window.outerHeight <= maxH);
    };
    check();
    const id = window.setInterval(check, 250);
    window.addEventListener("resize", check);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", check);
    };
  }, [highest, preferInPage]);

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

  // Corp / locked Edge: preferInPage forces the floating card (DevTools Option A).
  const fillWindow = highest && osSized && !preferInPage;

  return (
    <Card
      className={cn(
        "overflow-hidden gap-0 py-0",
        fillWindow
          ? "fixed inset-0 z-[9999] flex h-full w-full flex-col rounded-none border-0 shadow-none"
          : cn("fixed bottom-4 z-50 w-[260px] shadow-2xl", dockClassName ?? "left-4"),
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
