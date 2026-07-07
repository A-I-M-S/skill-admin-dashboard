import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

export interface MockSpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface MockSpawnScriptedResult {
  stdout?: string;
  stderr?: string;
  code?: number;
  signal?: NodeJS.Signals | null;
  /** Error to emit from the child (e.g. ENOENT) — surfaces as a spawn_failed. */
  error?: Error;
}

export type MockSpawnMatcher = (call: MockSpawnCall) => boolean;

export interface MockSpawnHandler {
  match: MockSpawnMatcher;
  respond: (call: MockSpawnCall) => MockSpawnScriptedResult;
}

/**
 * Module-level shared state used by the script-driven fake `mockRunSubprocess`.
 * Tests push handlers (or a default) and read call history.
 */
const calls: MockSpawnCall[] = [];
const handlers: MockSpawnHandler[] = [];
let defaultHandler: ((call: MockSpawnCall) => MockSpawnScriptedResult) | null = null;

/**
 * Replacement for `subprocess.runSubprocess`. Wire it up with
 * `vi.mock('../src/lib/subprocess', () => ({ runSubprocess: mockRunSubprocess, ... }))`.
 */
export async function mockRunSubprocess(
  command: string,
  options: { args: string[]; env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; maxBufferBytes?: number },
): Promise<{ stdout: string; stderr: string; code: number; signal: NodeJS.Signals | null; timedOut: boolean; durationMs: number }> {
  const call: MockSpawnCall = {
    command,
    args: options.args,
    env: options.env ?? process.env,
    cwd: options.cwd,
  };
  calls.push(call);

  const handler = handlers.find((h) => h.match(call));
  const responder = handler ? handler.respond : defaultHandler;
  const script: MockSpawnScriptedResult = responder ? responder(call) : { code: 0, stdout: '{}' };

  return await new Promise((resolve, reject) => {
    queueMicrotask(() => {
      if (script.error) {
        reject(new Error(`mock spawn error: ${script.error.message}`));
        return;
      }
      resolve({
        stdout: script.stdout ?? '',
        stderr: script.stderr ?? '',
        code: script.code ?? 0,
        signal: script.signal ?? null,
        timedOut: false,
        durationMs: 0,
      });
    });
  });
}

export interface MockSubprocessHandle {
  calls: MockSpawnCall[];
  install(): void;
  restore(): void;
  whenMatch(matcher: MockSpawnMatcher, respond: (call: MockSpawnCall) => MockSpawnScriptedResult): void;
  /** Convenience: program a single response, no matcher (matches any call). */
  setDefault(respond: ((call: MockSpawnCall) => MockSpawnScriptedResult) | null): void;
}

export function mockSubprocess(): MockSubprocessHandle {
  const handle: MockSubprocessHandle = {
    calls,
    install(): void {
      // No-op: state is module-scoped, set up via whenMatch / setDefault
      // before each test runs.
    },
    restore(): void {
      calls.length = 0;
      handlers.length = 0;
      defaultHandler = null;
    },
    whenMatch(matcher, respond): void {
      handlers.push({ match: matcher, respond });
    },
    setDefault(respond): void {
      defaultHandler = respond;
    },
  };
  return handle;
}

// Suppress unused-import warnings for types re-exported in the public surface.
void EventEmitter;
void Readable;
