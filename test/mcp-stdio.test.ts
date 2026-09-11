import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  MCP_COMPAT_TOOLS,
  MCP_PAID_TOOLS,
  MCP_TOOL_NAMES,
  MCP_WATCH_FOLLOWUP_TOOLS,
  MCP_WATCH_PAID_FOLLOWUP_TOOLS,
} from "../src/mcp-server.js";

function send(child: ReturnType<typeof spawn>, message: unknown): void {
  child.stdin!.write(`${JSON.stringify(message)}\n`);
}

async function readJsonLine(
  child: ReturnType<typeof spawn>,
  timeoutMs = 8_000,
): Promise<Record<string, unknown>> {
  let buffer = "";
  return await new Promise((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdio timeout. so far: ${buffer}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        child.stdout!.off("data", onData);
        clearTimeout(timer);
        reject(error);
        return;
      }
      if (parsed.method && parsed.id === undefined) return;
      child.stdout!.off("data", onData);
      clearTimeout(timer);
      resolveLine(parsed);
    };
    child.stdout!.on("data", onData);
  });
}

describe("livecheck MCP stdio", () => {
  it("exports the Gap 7 tool catalog (compat + paid + watch follow-ups)", () => {
    assert.deepEqual([...MCP_PAID_TOOLS], ["verify", "check", "confirm", "watch"]);
    assert.deepEqual([...MCP_COMPAT_TOOLS], ["verify_listing"]);
    assert.deepEqual([...MCP_WATCH_FOLLOWUP_TOOLS], ["watch_get", "watch_events", "watch_stop"]);
    assert.deepEqual([...MCP_WATCH_PAID_FOLLOWUP_TOOLS], ["watch_chain_topup"]);
    for (const name of MCP_TOOL_NAMES) {
      assert.equal(MCP_TOOL_NAMES.filter((item) => item === name).length, 1);
    }
  });

  it("advertises verify_listing plus verify/check/confirm/watch over stdio", async () => {
    const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("src/mcp.ts")], {
      cwd: resolve("."),
      env: { ...process.env, LIVECHECK_URL: "http://127.0.0.1:43127/v1/verify" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "livecheck-test", version: "0.1.0" },
        },
      });
      const initialized = await readJsonLine(child);
      assert.equal(initialized.id, 1);
      assert.ok(initialized.result);

      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listed = await readJsonLine(child);
      assert.equal(listed.id, 2);
      const tools = (listed.result as { tools?: Array<{ name: string }> })?.tools ?? [];
      const names = tools.map((tool) => tool.name);
      for (const name of MCP_TOOL_NAMES) {
        assert.ok(names.includes(name), `missing MCP tool ${name}`);
      }
    } finally {
      child.kill("SIGTERM");
    }
  });
});
