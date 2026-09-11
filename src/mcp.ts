import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLivecheckMcp, mcpReadyMessage } from "./mcp-server.js";

export { createLivecheckMcp, MCP_TOOL_NAMES } from "./mcp-server.js";

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
