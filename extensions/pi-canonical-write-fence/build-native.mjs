import * as fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
if (process.platform !== 'linux') throw Error('canonical fence requires Linux');
const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.env.PI_CANONICAL_NATIVE_BINDING || join(here, 'build/fence.node'));
const headers = process.env.NODE_INCLUDE_DIR || join(dirname(await fs.realpath(process.execPath)), '../include/node');
await fs.access(join(headers, 'node_api.h'));
await fs.mkdir(dirname(output), { recursive: true });
const scratch = await fs.mkdtemp(join(dirname(output), '.native-fence-'));
try {
  const binary = join(scratch, 'fence.node');
  await promisify(execFile)(process.env.CC || 'cc', ['-std=c11', '-shared', '-fPIC', '-Wall', '-Wextra', '-Werror',
    '-DNAPI_VERSION=8', '-I', headers, join(here, 'native/fence.c'), '-o', binary], { timeout: 30000 });
  await fs.rename(binary, output);
  console.log(output);
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
