import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { describe, it } from "node:test";
import { formatListenBinding, listenHttp } from "../src/listen.js";

const fetchHandler = (request: Request): Response => {
  const url = new URL(request.url);
  if (url.pathname === "/health") return new Response("ok");
  return new Response("no", { status: 404 });
};

function connect(host: string, port: number, family: 4 | 6): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, family });
    socket.setTimeout(2_000);
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("timeout", () => fail(new Error(`timeout connecting to ${host}:${port}`)));
    socket.once("error", fail);
  });
}

function closeAll(servers: Array<{ close: (callback?: () => void) => void }>): Promise<void> {
  return Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  ).then(() => undefined);
}

describe("HTTP listen addresses", () => {
  it("refuses IPv6 when the process is bound only to 0.0.0.0", async () => {
    const server = createServer((_req, res) => {
      res.end("ok");
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: 0, host: "0.0.0.0" }, () => {
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
    try {
      await connect("127.0.0.1", port, 4);
      await assert.rejects(connect("::1", port, 6), (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "ECONNREFUSED");
        return true;
      });
    } finally {
      await closeAll([server]);
    }
  });

  it("accepts Fly Proxy IPv4 and 6PN IPv6 on the same port", async () => {
    const listened = await listenHttp({ fetch: fetchHandler, port: 0, requireIPv6: true });
    const port = listened.bindings[0]?.port;
    assert.ok(port);
    try {
      assert.deepEqual(
        listened.bindings.map((binding) => binding.host),
        ["0.0.0.0", "::"],
      );
      assert.equal(listened.bindings[1]?.port, port);
      assert.equal(listened.bindings[1]?.family, "IPv6");
      assert.equal(formatListenBinding(listened.bindings[0]!), `0.0.0.0:${port}`);
      assert.equal(formatListenBinding(listened.bindings[1]!), `[::]:${port}`);
      await connect("127.0.0.1", port, 4);
      await connect("::1", port, 6);
      const v4 = await fetch(`http://127.0.0.1:${port}/health`);
      const v6 = await fetch(`http://[::1]:${port}/health`);
      assert.equal(v4.status, 200);
      assert.equal(await v4.text(), "ok");
      assert.equal(v6.status, 200);
      assert.equal(await v6.text(), "ok");
    } finally {
      await closeAll(listened.servers);
    }
  });
});
