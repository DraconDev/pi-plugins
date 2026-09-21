/**
 * Minimal TypeBox-compatible `Type` surface for testing pi extensions
 * outside pi. Mirrors real TypeBox semantics: Type.Object computes
 * `required` from properties NOT wrapped in Optional (verified against
 * typebox 1.3.27 bundled with pi).
 */
const OPTIONAL = Symbol("optional");

export const Type = {
  Object: (props) => ({
    type: "object",
    properties: props,
    required: Object.keys(props).filter((k) => !(props[k] && props[k][OPTIONAL])),
  }),
  Optional: (schema) => ({ ...schema, [OPTIONAL]: true }),
  String: (opts) => ({ type: "string", ...opts }),
  Number: (opts) => ({ type: "number", ...opts }),
  Integer: (opts) => ({ type: "integer", ...opts }),
  Boolean: (opts) => ({ type: "boolean", ...opts }),
  Array: (items, opts) => ({ type: "array", items, ...opts }),
  Union: (schemas, opts) => ({ anyOf: schemas, ...opts }),
  Literal: (value) => ({ const: value }),
};

/** Unused by schema tests; present so the extension module loads. */
export function createAssistantMessageEventStream() {
  throw new Error("stub: not implemented");
}

/** Unused by schema tests; present so the extension module loads. */
export function openAICompletionsApi() {
  throw new Error("stub: not implemented");
}
