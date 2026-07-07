import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Resolve the absolute path of the dashboard's repo-local temp root.
 *
 * Project convention (Risk #15, Phase 0 plan): the dashboard NEVER reads
 * from or writes to /tmp. All ephemeral scratch space lives under
 * `<cwd>/runtime/tmp/<uuid>/` so test cleanup (`runtime/` is in .gitignore)
 * and `make verify-no-tmp` (`grep -R /tmp /os.tmpdir`) pass.
 *
 * The root can be overridden with `SKILL_ADMIN_TMP_DIR`. The override MUST
 * be relative to cwd or an absolute path under cwd; we always resolve()
 * to an absolute path so the returned `dir()` always uses absolute paths.
 */
function resolveTmpRoot(): string {
  const fromEnv = (process.env.SKILL_ADMIN_TMP_DIR ?? '').trim();
  if (fromEnv !== '') return resolve(fromEnv);
  return resolve(process.cwd(), 'runtime', 'tmp');
}

export interface TmpDir {
  path: string;
  /** Lazily-created absolute path under the temp root. */
  file: (name: string) => string;
  /** Cleanup the directory and everything under it. */
  cleanup: () => Promise<void>;
}

/**
 * Create a fresh `runtime/tmp/<uuid>/` directory with mode 0o700. Returns
 * helpers for joining files and cleaning up. The directory is created
 * immediately; cleanup() removes it.
 */
export async function createTmpDir(prefix = 'skill-admin-'): Promise<TmpDir> {
  const root = resolveTmpRoot();
  await mkdirRootIfMissing(root);
  const path = await mkdtemp(join(root, `${prefix}${randomUUID()}-`));
  await chmod(path, 0o700);

  return {
    path,
    file: (name: string): string => {
      if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        throw new Error(`unsafe tmp file name: ${name}`);
      }
      return join(path, name);
    },
    cleanup: async (): Promise<void> => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

async function mkdirRootIfMissing(root: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root, { recursive: true, mode: 0o700 });
}
