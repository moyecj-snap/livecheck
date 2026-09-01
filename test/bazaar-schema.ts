import { createRequire } from "node:module";
import assert from "node:assert/strict";

type AjvInstance = {
  compile: (schema: object) => ((data: unknown) => boolean) & { errors?: unknown };
  errorsText: (errors: unknown) => string;
};
type AjvCtor = new (opts?: { strict?: boolean; allErrors?: boolean }) => AjvInstance;

const require = createRequire(import.meta.url);
const loaded = require("ajv/dist/2020.js") as AjvCtor | { default: AjvCtor };
const Ajv2020: AjvCtor = typeof loaded === "function" ? loaded : loaded.default;

export type BazaarExt = {
  info?: { input?: Record<string, unknown> };
  schema?: { properties?: { input?: object } };
};

/** Same check CDP settle uses: info.input must validate against schema.properties.input. */
export function assertInfoInputMatchesSchema(bazaar: BazaarExt, label: string): void {
  const inputSchema = bazaar.schema?.properties?.input;
  const input = bazaar.info?.input;
  assert.ok(inputSchema, `${label}: missing schema.properties.input`);
  assert.ok(input, `${label}: missing info.input`);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(inputSchema);
  const ok = validate(input);
  assert.equal(
    ok,
    true,
    `${label}: info.input failed schema.properties.input: ${ajv.errorsText(validate.errors)}`,
  );
}

export function validateInfoInput(bazaar: BazaarExt): { valid: boolean; errors: string } {
  const inputSchema = bazaar.schema?.properties?.input;
  const input = bazaar.info?.input;
  if (!inputSchema || !input) {
    return { valid: false, errors: "missing schema.properties.input or info.input" };
  }
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(inputSchema);
  const ok = validate(input);
  return { valid: Boolean(ok), errors: ok ? "" : ajv.errorsText(validate.errors) };
}
