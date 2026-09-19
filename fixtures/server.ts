import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serves fixtures/sites as several company sites under one local origin, the
 * way the brief says evaluation sites may be served:
 *
 *   /acme/      hiring process two clicks deep, at a path nobody would guess
 *   /globex/    no careers or hiring page anywhere
 *   /initech/   process described in a blog post; careers page needs JavaScript; /internal/ is disallowed by robots.txt
 *   /umbrella/  pages carrying text that tries to instruct whatever reads them
 *   /hooli/     works, but its careers page answers 500
 *   anything else: 404
 */
const SITES = path.join(path.dirname(fileURLToPath(import.meta.url)), "sites");
const BROKEN = new Set(["/hooli/careers/", "/hooli/careers"]);
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml" };

export interface FixtureServer {
  origin: string;
  hits: string[];
  close(): Promise<void>;
}

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const hits: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://fixture").pathname);
    hits.push(pathname);

    if (BROKEN.has(pathname)) return void response.writeHead(500, { "content-type": "text/html" }).end("<h1>Internal Server Error</h1>");

    const file = await resolveFile(pathname);
    if (!file) return void response.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
    response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    origin: `http://localhost:${(server.address() as AddressInfo).port}`,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function resolveFile(pathname: string): Promise<string | undefined> {
  const target = path.normalize(path.join(SITES, pathname));
  if (!target.startsWith(SITES)) return undefined; // no escaping the fixtures directory

  for (const candidate of [target, path.join(target, "index.html")]) {
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile()) return candidate;
  }
  return undefined;
}

// `npm run fixtures` serves the sites on the port the brief's example uses.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { origin } = await startFixtureServer(Number(process.env.FIXTURE_PORT ?? 8099));
  console.log(`Fixture company sites on ${origin}/  (acme, globex, initech, umbrella, hooli)`);
}
