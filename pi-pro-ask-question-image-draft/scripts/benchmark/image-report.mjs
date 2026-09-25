#!/usr/bin/env node
import { reportMain } from "./images.mjs";

reportMain().catch((error) => {
  process.stderr.write(`benchmark:images:report: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
  process.exitCode = 1;
});
