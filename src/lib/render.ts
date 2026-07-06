import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ejs from 'ejs';
import type { FastifyReply, FastifyRequest } from 'fastify';

// `__dirname` is a CommonJS global; the project compiles with
// `"module": "commonjs"`, so it is available at runtime.
const VIEWS_DIR: string = resolve(__dirname, '..', '..', 'src', 'views');

export interface RenderContext {
  user?: { userId: string } | null;
  csrfToken?: string;
  flash?: string | null;
  readonlyMode?: boolean;
  title?: string;
  [key: string]: unknown;
}

export interface PageSpec {
  view: string;
  context: RenderContext;
  layout?: string;
}

export async function renderPage(spec: PageSpec): Promise<string> {
  const layoutName = spec.layout ?? 'layout';
  const viewPath = join(VIEWS_DIR, spec.view);
  const layoutPath = join(VIEWS_DIR, `${layoutName}.ejs`);

  const [viewSource, layoutSource] = await Promise.all([
    readFile(viewPath, 'utf8'),
    readFile(layoutPath, 'utf8'),
  ]);

  // EJS auto-escapes on `<%= %>` — Risk #14. Layouts may use `<%- include('partials/x') %>`
  // to inline a partial file (the partial is a known trusted source).
  const innerContext = { ...spec.context, layout: false };
  const body = ejs.render(viewSource, innerContext, {
    filename: viewPath,
    async: false,
    root: VIEWS_DIR,
  });

  return ejs.render(
    layoutSource,
    { ...spec.context, body },
    { filename: layoutPath, async: false, root: VIEWS_DIR },
  );
}

export async function sendPage(
  reply: FastifyReply,
  spec: PageSpec,
): Promise<FastifyReply> {
  const html = await renderPage(spec);
  return reply.type('text/html; charset=utf-8').send(html);
}

const PUBLIC_PATHS = new Set(['/login', '/healthz']);

export function requireAuthForPages() {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(url)) return;
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return;
    const user = (req.session?.get?.('user') as { userId?: string } | undefined) ?? undefined;
    if (user?.userId) return;
    void reply.redirect('/login', 302);
  };
}
