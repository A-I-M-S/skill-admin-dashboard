import { spawn } from 'node:child_process';

export interface SpawnOptions {
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

export class SpawnError extends Error {
  public readonly result: SpawnResult;
  public override readonly cause?: unknown;
  constructor(message: string, result: SpawnResult, cause?: unknown) {
    super(message);
    this.name = 'SpawnError';
    this.result = result;
    this.cause = cause;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024; // 2 MiB

export async function runSubprocess(
  command: string,
  options: SpawnOptions,
): Promise<SpawnResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

  const start = Date.now();
  const child = spawn(command, options.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env ?? process.env,
    cwd: options.cwd,
    shell: false,
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let bufferOverflow = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    // Escalate to SIGKILL if SIGTERM didn't take effect after 1s.
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 1_000).unref();
  }, timeoutMs);
  timer.unref();

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > maxBuffer) {
      bufferOverflow = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > maxBuffer) {
      bufferOverflow = true;
      child.kill('SIGTERM');
    }
  });

  return await new Promise<SpawnResult>((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      const result: SpawnResult = {
        stdout,
        stderr,
        code: -1,
        signal: null,
        timedOut,
        durationMs: Date.now() - start,
      };
      if (bufferOverflow) {
        reject(new SpawnError('subprocess_max_buffer_exceeded', result, err));
        return;
      }
      reject(new SpawnError(`subprocess_spawn_failed: ${err.message}`, result, err));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const result: SpawnResult = {
        stdout,
        stderr,
        code: code ?? -1,
        signal,
        timedOut,
        durationMs: Date.now() - start,
      };
      if (bufferOverflow) {
        reject(new SpawnError('subprocess_max_buffer_exceeded', result));
        return;
      }
      if (timedOut) {
        reject(new SpawnError('subprocess_timeout', result));
        return;
      }
      resolve(result);
    });
  });
}

export function isZeroExit(result: SpawnResult): boolean {
  return result.code === 0 && !result.timedOut;
}
