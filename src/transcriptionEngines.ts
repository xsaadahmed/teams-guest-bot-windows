import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type TranscriptionEngineId = 'faster_whisper' | 'parakeet';

export interface EngineRegistryEntry {
  id: TranscriptionEngineId;
  label: string;
  models: string[];
  defaultModel: string;
}

export interface DetectedEngineOnInterpreter {
  id: TranscriptionEngineId;
  label: string;
  installed: boolean;
  version: string | null;
  models: string[];
  defaultModel: string;
}

export interface InterpreterProbeResult {
  pythonPath: string;
  pythonVersion: string;
  engines: DetectedEngineOnInterpreter[];
}

export interface AvailableTranscriptionEngine {
  id: TranscriptionEngineId;
  label: string;
  pythonPath: string;
  pythonVersion: string;
  version: string | null;
  models: string[];
  defaultModel: string;
}

export interface SupportedTranscriptionEngine {
  id: TranscriptionEngineId;
  label: string;
  installed: boolean;
  models: string[];
  defaultModel: string;
  pythonPath?: string;
  pythonVersion?: string;
  version?: string | null;
}

export interface TranscriptionEnginesResponse {
  interpreters: InterpreterProbeResult[];
  available: AvailableTranscriptionEngine[];
  supported: SupportedTranscriptionEngine[];
}

const ENGINE_REGISTRY: EngineRegistryEntry[] = [
  {
    id: 'faster_whisper',
    label: 'faster-whisper',
    models: ['tiny', 'base', 'small', 'medium', 'large-v3'],
    defaultModel: 'small',
  },
  {
    id: 'parakeet',
    label: 'NVIDIA Parakeet (NeMo)',
    models: ['nvidia/parakeet-tdt-0.6b-v2'],
    defaultModel: 'nvidia/parakeet-tdt-0.6b-v2',
  },
];

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: TranscriptionEnginesResponse } | null = null;

function repoTranscribeDir(): string {
  return path.join(__dirname, '..', 'transcribe');
}

function detectScriptPath(): string {
  return path.join(repoTranscribeDir(), 'detect_engines.py');
}

function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const parse = (v: string | null | undefined): number[] => {
    if (!v) return [0];
    return v
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map((n) => Number(n));
  };
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function runProbe(pythonPath: string): Promise<InterpreterProbeResult | null> {
  return new Promise((resolve) => {
    const script = detectScriptPath();
    if (!fs.existsSync(script)) {
      resolve(null);
      return;
    }

    const proc = spawn(pythonPath, [script], {
      cwd: repoTranscribeDir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on('error', () => resolve(null));
    proc.on('exit', (code) => {
      if (code !== 0) {
        if (stderr.trim()) {
          console.warn(`[transcriptionEngines] probe failed for ${pythonPath}:`, stderr.trim());
        }
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as InterpreterProbeResult;
        if (!parsed?.pythonPath || !Array.isArray(parsed.engines)) {
          resolve(null);
          return;
        }
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
  });
}

async function resolvePythonLauncher(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    const proc = spawn('py', ['-3', '-c', 'import sys; print(sys.executable)'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.on('error', () => resolve(null));
    proc.on('exit', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const p = stdout.trim();
      resolve(p && fs.existsSync(p) ? p : null);
    });
  });
}

async function discoverPythonCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  const add = (p: string | undefined | null) => {
    const trimmed = (p ?? '').trim();
    if (!trimmed) return;
    const normalized = path.normalize(trimmed);
    if (!candidates.includes(normalized) && fs.existsSync(normalized)) {
      candidates.push(normalized);
    }
  };

  add(process.env.PYTHON_PATH);

  if (process.platform === 'win32') {
    add(await resolvePythonLauncher());
  }

  for (const cmd of ['python', 'python3']) {
    await new Promise<void>((resolve) => {
      const proc = spawn(cmd, ['-c', 'import sys; print(sys.executable)'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true,
      });
      let stdout = '';
      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.on('error', () => resolve());
      proc.on('exit', (code) => {
        if (code === 0) add(stdout.trim());
        resolve();
      });
    });
  }

  return candidates;
}

function mergeAvailable(interpreters: InterpreterProbeResult[]): AvailableTranscriptionEngine[] {
  const best = new Map<TranscriptionEngineId, AvailableTranscriptionEngine>();

  for (const interp of interpreters) {
    for (const engine of interp.engines) {
      if (!engine.installed) continue;
      const id = engine.id;
      const existing = best.get(id);
      const candidate: AvailableTranscriptionEngine = {
        id,
        label: engine.label,
        pythonPath: interp.pythonPath,
        pythonVersion: interp.pythonVersion,
        version: engine.version,
        models: engine.models,
        defaultModel: engine.defaultModel,
      };
      if (!existing || compareVersions(candidate.version, existing.version) > 0) {
        best.set(id, candidate);
      }
    }
  }

  return ENGINE_REGISTRY.map((reg) => best.get(reg.id)).filter(
    (e): e is AvailableTranscriptionEngine => Boolean(e),
  );
}

function buildSupported(
  available: AvailableTranscriptionEngine[],
): SupportedTranscriptionEngine[] {
  const byId = new Map(available.map((a) => [a.id, a]));
  return ENGINE_REGISTRY.map((reg) => {
    const found = byId.get(reg.id);
    if (found) {
      return {
        id: reg.id,
        label: reg.label,
        installed: true,
        models: found.models,
        defaultModel: found.defaultModel,
        pythonPath: found.pythonPath,
        pythonVersion: found.pythonVersion,
        version: found.version,
      };
    }
    return {
      id: reg.id,
      label: reg.label,
      installed: false,
      models: reg.models,
      defaultModel: reg.defaultModel,
    };
  });
}

export async function discoverTranscriptionEngines(
  options?: { refresh?: boolean },
): Promise<TranscriptionEnginesResponse> {
  if (!options?.refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const candidates = await discoverPythonCandidates();
  const interpreters: InterpreterProbeResult[] = [];
  for (const pythonPath of candidates) {
    const result = await runProbe(pythonPath);
    if (result) interpreters.push(result);
  }

  const available = mergeAvailable(interpreters);
  const value: TranscriptionEnginesResponse = {
    interpreters,
    available,
    supported: buildSupported(available),
  };
  cache = { at: Date.now(), value };
  return value;
}

export function isValidTranscriptionEngineId(id: string): id is TranscriptionEngineId {
  return ENGINE_REGISTRY.some((e) => e.id === id);
}

export function getEngineRegistry(): EngineRegistryEntry[] {
  return [...ENGINE_REGISTRY];
}

export function invalidateTranscriptionEnginesCache(): void {
  cache = null;
}
