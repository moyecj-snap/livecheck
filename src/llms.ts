import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Agent discovery copy for GET /llms.txt.
 * Edit public/llms.txt. Do not inline product copy in this module.
 */
export const LLMS_TXT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/llms.txt"), "utf8");

export function llmsTxtHeaders(): Record<string, string> {
  return {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  };
}
