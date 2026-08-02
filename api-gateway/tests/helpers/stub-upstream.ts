import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";

export interface ReceivedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface StubUpstream {
  /** Base URL a proxy can target, e.g. `http://127.0.0.1:53211`. */
  url: string;
  /** Every request the stub received, in arrival order. */
  received: ReceivedRequest[];
  /** Delays the next response by `ms`, to exercise the proxy timeout. */
  delayNextBy(ms: number): void;
  close(): Promise<void>;
}

/**
 * A real HTTP server standing in for a downstream service.
 *
 * Deliberately not a mock: the proxy pipes raw sockets, so the only way to
 * prove that a request survives the hop intact — path, method, headers, and an
 * unparsed body — is to have something on the other end actually receive it.
 */
export async function startStubUpstream(): Promise<StubUpstream> {
  const received: ReceivedRequest[] = [];
  let delayMs = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });

      const respond = (): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { path: req.url } }));
      };

      if (delayMs > 0) {
        const pending = delayMs;
        delayMs = 0;
        setTimeout(respond, pending);
        return;
      }
      respond();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    delayNextBy(ms: number) {
      delayMs = ms;
    },
    async close() {
      // `closeAllConnections` matters here: a delayed response leaves a socket
      // open, and `close()` alone would wait for it and hang the suite.
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** A port with nothing listening on it, for connection-refused assertions. */
export async function findClosedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}
