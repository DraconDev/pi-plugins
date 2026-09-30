import { test } from "node:test";
import assert from "node:assert/strict";
test("audit: deliberately failing assertion", () => { assert.equal(1, 2); });
