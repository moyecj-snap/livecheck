import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { livecheckVerifyUrl, verifyListing } from "./mcp-client.js";

function createLivecheckMcp(): McpServer {
  const server = new McpServer({
    name: "livecheck",
    version: "0.1.0",
  });

  server.registerTool(
    "verify_listing",
    {
      title: "Verify listing",
      description:
        "Ask Livecheck whether a specific URL is still a live primary source. POSTs {url} to LIVECHECK_URL. Does not pay. An unpaid server returns a structured HTTP 402 (paid: false) with decoded x402 payment-required fields. A settled request returns the verify JSON as-is.",
      inputSchema: {
        url: z
          .string()
          .describe("Absolute http(s) URL of the page to check. You already have this URL."),
      },
    },
    async ({ url }) => {
      try {
        const result = await verifyListing(url);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Livecheck request failed.";
        const extra =
          error instanceof Error && "http" in error
            ? { http: (error as Error & { http?: number }).http, body: (error as Error & { body?: unknown }).body }
            : undefined;
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(extra ? { error: message, ...extra } : { error: message }, null, 2),
            },
          ],
        };
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createLivecheckMcp();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`livecheck MCP stdio ready → ${livecheckVerifyUrl()}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
