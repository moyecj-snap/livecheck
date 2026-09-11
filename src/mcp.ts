/** Gap #7 MCP entrypoint.
 * Tools (via ./mcp-server): verify, check, confirm, watch,
 * plus verify_listing compat and watch_get/events/stop/chain_topup.
 * npm run mcp → tsx src/mcp.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLivecheckMcp, mcpReadyMessage } from "./mcp-server.js";

export {
  createLivecheckMcp,
  MCP_TOOL_NAMES,
  MCP_PAID_TOOLS,
  MCP_COMPAT_TOOLS,
  MCP_WATCH_FOLLOWUP_TOOLS,
  MCP_WATCH_PAID_FOLLOWUP_TOOLS,
} from "./mcp-server.js";

async function main(): Promise<void> {
  const server = createLivecheckMcp();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(mcpReadyMessage());
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
