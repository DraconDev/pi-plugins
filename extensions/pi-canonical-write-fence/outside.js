// Preserve ordinary non-repository tool writes without following an unowned
// alias into a repository. Reject unsupported links before truncation.
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
async function opened(path, flags, callback) {
  const file = await fs.open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o666);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.geteuid()) throw Error('unowned-context link or special-file mutation is unsupported');
    return await callback(file);
  } finally { await file.close(); }
}
export const outsideOperations = {
  access: path => fs.access(path, constants.R_OK | constants.W_OK),
  mkdir: path => fs.mkdir(path, { recursive: true }).then(() => {}),
  readFile: path => opened(path, constants.O_RDONLY, file => file.readFile()),
  writeFile: (path, content) => opened(path, constants.O_WRONLY | constants.O_CREAT, async file => {
    await file.truncate(0);
    await file.writeFile(content, 'utf8');
  }),
};
