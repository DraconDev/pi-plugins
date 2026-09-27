/**
 * Parsers for the inline-image escapes this package emits.
 *
 * Deliberately free of side effects: the regression suite imports these to prove
 * that what the wizard wrote is what a terminal would read, and a module that
 * renders and reports on import would make the suite's exit code depend on the
 * machine it ran on. The command that *uses* them is
 * `scripts/benchmark/verify-image-protocol.mjs`.
 */

/**
 * Kitty APC escapes: `ESC _ G <keys> ; <payload> ESC \`, optionally inside tmux's
 * `ESC P tmux ; ... ESC \` passthrough envelope.
 *
 * A large image is transmitted in chunks: every chunk but the last carries
 * `m=1`, the last carries `m=0` or nothing. The protocol mixes two kinds of
 * escape in the same family - data transmissions (which carry a payload) and
 * control commands such as `a=d,d=I,i=<id>` (which do not) - so the two are
 * returned separately rather than pretending a command is a broken image.
 *
 * Getting the chunk boundary wrong is not a cosmetic bug: a parser that starts a
 * new image on the final chunk reports one 527 KB picture as 525,312 bytes plus
 * 2,003, and the package looks broken when the bytes were fine.
 */
export function parseKitty(text) {
  const images = [];
  const commands = [];
  // The data section is optional: a control command such as `a=d,d=I,i=7`
  // carries keys and no payload at all, and the `;` with it.
  const pattern = /(\u001bPtmux;)?\u001b_G([^;]*)(?:;([^\u001b]*))?\u001b\\/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const keys = Object.fromEntries(match[2].split(",").map((pair) => pair.split("=")).filter((pair) => pair.length === 2));
    const payload = match[3] ?? "";
    const wrapped = match[1] === "\u001bPtmux;";
    // An open transmission continues, whatever its final chunk says.
    const open = images.at(-1);
    if (open && open.more) {
      open.payload += payload;
      open.chunks += 1;
      open.more = keys.m === "1";
      continue;
    }
    if (payload === "") {
      commands.push({ keys, wrapped });
      continue;
    }
    images.push({ keys, payload, chunks: 1, more: keys.m === "1", wrapped });
  }
  return { images, commands };
}

/**
 * iTerm2 inline images: `ESC ] 1337 ; File=<args> :<base64>` closed by BEL or
 * ST. The sequence must be closed: pi-tui emits it open, and a terminal that
 * takes the protocol literally finds no end of image at all.
 */
export function parseITerm2(text) {
  const images = [];
  const pattern = /\u001b\]1337;File=([^:]*):([A-Za-z0-9+/=]*)(?:\u0007|\u001b\\)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const keys = Object.fromEntries(match[1].split(";").map((pair) => pair.split("=")).filter((pair) => pair.length === 2));
    images.push({ keys, payload: match[2] });
  }
  return { images };
}
