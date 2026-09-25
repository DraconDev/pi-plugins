#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const SCHEMA_VERSION = 1;

export class BenchmarkError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "BenchmarkError";
    this.code = code;
  }
}

export function parseArgs(argv, spec = {}) {
  const values = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      values._.push(token);
      continue;
    }
    if (!token.startsWith("--") || token === "--") throw new BenchmarkError("invalid_arguments", `Invalid argument: ${token}`);
    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    if (!key || Object.hasOwn(spec, key) === false) throw new BenchmarkError("invalid_arguments", `Unknown option: --${key}`);
    if (spec[key] === "boolean") {
      if (inline !== undefined) throw new BenchmarkError("invalid_arguments", `--${key} does not accept a value.`);
      values[key] = true;
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined || value.startsWith("--")) throw new BenchmarkError("invalid_arguments", `--${key} requires a value.`);
    if (spec[key] === "number") values[key] = parseStrictNumber(value, key);
    else values[key] = value;
  }
  return values;
}

export function parseStrictNumber(value, name) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new BenchmarkError("invalid_count", `${name} must be a number.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new BenchmarkError("invalid_count", `${name} must be finite.`);
  return number;
}

export function parseCount(value, fallback = 1000) {
  const count = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
    throw new BenchmarkError("invalid_count", "--count must be an integer from 1 through 100000.");
  }
  return count;
}

export function parseSeed(value, fallback = 20260925) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new BenchmarkError("invalid_seed", "--seed must be an integer from 0 through 4294967295.");
  }
  return value;
}

export function parsePositiveLimit(value, fallback, maximum = 600) {
  const limit = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum) {
    throw new BenchmarkError("invalid_limit", `limit must be an integer from 0 through ${maximum}.`);
  }
  return limit;
}

export function assertNoCredentials(value, path = "$") {
  const visit = (item, itemPath) => {
    if (typeof item === "string") {
      if (/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(item) || /\bsk-[A-Za-z0-9_-]{8,}\b/.test(item) ||
          /\bAKIA[0-9A-Z]{16}\b/.test(item) || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(item)) {
        throw new BenchmarkError("credential_detected", `Credential-shaped value is forbidden at ${itemPath}.`);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, `${itemPath}[${index}]`));
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, entry] of Object.entries(item)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (["apikey", "token", "accesstoken", "refreshtoken", "password", "passwd", "secret", "clientsecret", "authorization", "credential", "credentials", "privatekey"].includes(normalized)) {
        throw new BenchmarkError("credential_detected", `Credential-shaped key is forbidden at ${itemPath}.${key}.`);
      }
      visit(entry, `${itemPath}.${key}`);
    }
  };
  visit(value, path);
}

export async function readJson(path, missingCode = "manifest_missing") {
  const absolute = resolve(path);
  let text;
  try {
    text = await readFile(absolute, "utf8");
  } catch (cause) {
    if (cause?.code === "ENOENT") throw new BenchmarkError(missingCode, `Required JSON file is missing: ${absolute}`, { cause });
    throw new BenchmarkError("io_error", `Unable to read ${absolute}.`, { cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new BenchmarkError("invalid_json", `Invalid JSON in ${absolute}.`, { cause });
  }
}

export async function writeJson(path, value) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return absolute;
}

export function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BenchmarkError("invalid_shape", `${label} must be an object.`);
  return value;
}

export function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new BenchmarkError("invalid_shape", `${label} must be a non-empty string.`);
  return value;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function wilsonLowerBound(successes, total, z = 1.959963984540054) {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || total < 1 || successes < 0 || successes > total) {
    throw new BenchmarkError("invalid_shape", "Wilson bound requires integer successes >= 0 and total >= 1.");
  }
  const proportion = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = proportion + z2 / (2 * total);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denominator);
}
