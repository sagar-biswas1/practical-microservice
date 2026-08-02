import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpInventoryClient } from "../../src/clients/inventory.client.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface Received {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Exercises the real transport against a throwaway HTTP server. The fake
 * client used elsewhere proves the orchestration; this proves the wire
 * format — envelope unwrapping, headers, and status mapping.
 */
describe("HttpInventoryClient", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  async function start(handler: Handler): Promise<{ url: string; received: Received[] }> {
    const received: Received[] = [];

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        handler(req, res);
      });
    });

    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server?.address() as AddressInfo;

    return { url: `http://127.0.0.1:${port}`, received };
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  const item = {
    id: "1c9e6679-7425-40de-944b-e07fc1f90ae7",
    sku: "SKU-1",
    productId: "2c9e6679-7425-40de-944b-e07fc1f90ae8",
    warehouse: "default",
    quantity: 10,
    reserved: 2,
    reorderLevel: 5,
    available: 8,
    lowStock: false,
  };

  it("unwraps the success envelope and forwards correlation headers", async () => {
    const { url, received } = await start((_req, res) => json(res, 201, { success: true, data: item }));
    const client = new HttpInventoryClient(url);

    const created = await client.create(
      { sku: "SKU-1", productId: item.productId, quantity: 10 },
      { requestId: "req-1", actor: "ops@example.com" },
    );

    expect(created).toEqual(item);
    expect(received[0]?.method).toBe("POST");
    expect(received[0]?.headers["x-request-id"]).toBe("req-1");
    expect(received[0]?.headers["x-actor-id"]).toBe("ops@example.com");
    expect(JSON.parse(received[0]?.body ?? "{}")).toMatchObject({ sku: "SKU-1", quantity: 10 });
  });

  it("returns null instead of throwing when a lookup 404s", async () => {
    const { url } = await start((_req, res) =>
      json(res, 404, { success: false, error: { message: "not found" } }),
    );

    await expect(new HttpInventoryClient(url).findById(item.id)).resolves.toBeNull();
  });

  it("maps a 409 to a conflict the caller can surface", async () => {
    const { url } = await start((_req, res) =>
      json(res, 409, { success: false, error: { message: "SKU already exists" } }),
    );

    await expect(
      new HttpInventoryClient(url).create({ sku: "SKU-1", productId: item.productId }),
    ).rejects.toMatchObject({ statusCode: 409, message: "SKU already exists" });
  });

  it("turns a downstream 500 into a 503", async () => {
    const { url } = await start((_req, res) =>
      json(res, 500, { success: false, error: { message: "boom" } }),
    );

    await expect(new HttpInventoryClient(url).findById(item.id)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("reports a 4xx as a bad request rather than a dependency outage", async () => {
    const { url } = await start((_req, res) =>
      json(res, 422, { success: false, error: { message: "quantity must be an integer" } }),
    );

    await expect(
      new HttpInventoryClient(url).create({ sku: "SKU-1", productId: item.productId }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("handles a 204 with no body", async () => {
    const { url, received } = await start((_req, res) => {
      res.writeHead(204);
      res.end();
    });

    await expect(new HttpInventoryClient(url).delete(item.id)).resolves.toBeUndefined();
    expect(received[0]?.method).toBe("DELETE");
  });

  it("sends the bulk filter as one request and keys the result by product", async () => {
    const { url, received } = await start((_req, res) =>
      json(res, 200, { success: true, data: [item] }),
    );

    const found = await new HttpInventoryClient(url).findByProductIds([item.productId]);

    expect(found.get(item.productId)).toEqual(item);
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toContain(`productIds=${item.productId}`);
  });

  it("reports an unreachable service as a 503", async () => {
    // Port 1 is reserved and never listening.
    const client = new HttpInventoryClient("http://127.0.0.1:1", 250);

    await expect(client.findById(item.id)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("reports a timeout as a 503 rather than hanging the caller", async () => {
    const { url } = await start(() => {
      // Never responds: the client's own timeout has to fire.
    });
    const client = new HttpInventoryClient(url, 100);

    await expect(client.findById(item.id)).rejects.toMatchObject({ statusCode: 503 });
  });
});
