import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Route =
  | string
  | { status?: number; headers?: Record<string, string>; body?: string | Buffer }
  | ((request: IncomingMessage, response: ServerResponse) => void);

export interface TestSite {
  /** e.g. http://localhost:54123 (no trailing slash) */
  origin: string;
  /** Paths requested, in order. */
  hits: string[];
  close(): Promise<void>;
}

/** A throwaway HTTP server on a random local port. Unknown paths return 404. String routes are served as HTML. */
export async function startSite(routes: Record<string, Route>): Promise<TestSite> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    hits.push(path);
    const route = routes[path];

    if (route === undefined) {
      response.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
    } else if (typeof route === "function") {
      route(request, response);
    } else if (typeof route === "string") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(route);
    } else {
      response.writeHead(route.status ?? 200, { "content-type": "text/html; charset=utf-8", ...route.headers }).end(route.body ?? "");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://localhost:${port}`,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
