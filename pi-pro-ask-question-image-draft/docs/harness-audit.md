# Harness audit: how the alternatives do it

Scope: what other tools do when an agent needs a human to decide something, and
where this package stands against them. Checked on 2026-09-27.

**Two grades of evidence in this document, kept apart on purpose.**

- *Read directly* — claims about `@juicesharp/rpiv-ask-user-question`, which is
  installed on this machine, so every claim is a file:line in its source.
- *Reported by the package* — every row about the other tools comes from that
  project's own published README. None of them is installed here, so nothing in
  the competitor table has been re-derived independently. The token counts in
  particular (1,245 / 215 / 1,258) are **the packages' own claims about
  themselves**, not a measurement made here; treat them as indicative.

## The reference: rpiv-ask-user-question v2.11.0

Local source: `~/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question`.

| | Detail |
|---|---|
| Tool parameters | `questions[]` only (`tool/types.ts:87`). Per question: `question`, `header` (≤16), `options[]` (2–4), `multiSelect`. Per option: `label`, `description`, `preview` (markdown text). |
| **Image / file / attachment** | **None.** Grep-verified across the whole package: no `image`, `attach`, `upload`, `base64` or content-block support anywhere. The result envelope emits text only (`tool/response-envelope.ts:53`). |
| Overlay | Full width, anchored `bottom-center`, takes the bottom of the terminal (`ask-user-question.ts:372`). |
| Preview | Markdown in a 4-sided ASCII box beside the list, side-by-side only when both panes are ≥100 columns, max 20 rows (`view/components/preview/preview-box-renderer.ts:36`, `preview-layout-decider.ts:7`). |
| Tabs | `■`/`□` per question plus a `✓ Submit` chip; the Submit tab lists answers and names what is still blank (`view/components/tab-bar.ts:33`, `submit-picker.ts:53`). |
| Keys | Host keymap actions plus hard-coded `Tab`/`→`, `Shift+Tab`/`←`, `n` for notes, `Space` for multi-toggle. One configurable key: `collapseKey`, default `ctrl+]` (`config.ts:7`). |
| Notes | `n` per question, `n` on Submit for a global one; reach the model as `user notes: …` / `global note: …` and never mark a question answered (`tool/response-envelope.ts:34,49`). |
| Multi-select | `[✔]`/`[ ]` glyphs, `Space` or `Enter` toggles, only the appended `Next` row commits (`view/components/multi-select-view.ts:10`). |
| Fallbacks | No UI → tool removed from the model's list (`reconcile.ts:25`); RPC/ACP → sequential `ui.select()`/`ui.input()` with **no notes, no tabs, no previews**; nothing renderable → an explicit `no_custom_ui` error, never a silent decline. |
| Also has | 9 locales, a BEL attention ping, CR-normalisation of model text, sticky header/footer with overflow glyphs. |

Two of its behaviours are deliberate and worth keeping in mind: **submit is not
gated on every question being answered** (partial answers always flow), and
`multiSelect` questions get **no preview pane**.

## The field

| Tool | What it is | Affordances | The one thing it does that a plain list cannot |
|---|---|---|---|
| `@hank-warren/pi-ask-user-question` | Pi questionnaire, composes its own selector library | 1–4 tabs, multi-select, digit hotkeys `1`–`9`, `n` notes, preview pane | **Digit hotkeys: `1`–`9` select immediately** (toggle on multi-select). No model round trip, no highlight-then-Enter. |
| `@hank-warren/pi-permission-selector` | The *library* behind the above, also used for permission prompts | numbered options, digit hotkeys, inline notes, opt-in checkbox multi-select | **Tab-to-comment** while browsing: Tab annotates instead of switching tab. Reused across tools, so it is a proven pattern. |
| `@tylerho/pi-ask-user-question` | Claude Code-shaped batch questions | 1–4 tabs, headers ≤12, 2–4 options, multi-select, previews, `ctrl+r` | **Token discipline**: measured upstream at 1,245 always-on tokens / 4,980 model-visible characters and tuned the schema down; plus a `ctrl+r` "chat about this" escape that abandons the questionnaire and hands the model a message, and an entry renderer so a finished questionnaire leaves a transcript record. |
| `avtc-pi-ask-user-question` | Questionnaire with ecosystem integrations | single/multi-select, free text, multiline via `Ctrl/Shift/Cmd+Enter`, 4 tabs | **Subagent forwarding**: a question raised inside a subagent is bridged into the parent UI, plus attention alerts and a dialog coordinator that stops two dialogs overlapping. |
| `@jqwn/pi-ask-user-question` | Straightforward questionnaire | 1–4 tabs, 2–4 options, descriptions, previews, multi-select, `Other` row | Nothing beyond the baseline; a useful "this is the common denominator" data point. |
| `@juicesharp/rpiv-btw` | `/btw <question>` side question | bottom panel, same model, read-only clone of the conversation | **The answer never enters the transcript and never touches disk** — a side question that cannot pollute context. |
| `@ssk_dev/rpiv-ask-user-question-lean` | A trimmed fork of rpiv | same UI, schema and previews kept | *Reports* 215 prompt tokens vs 1,258 (82.9% less) by trimming the tool description. Unverified here, but the direction matches the one measurement we can make: our own tool description is 1,641 characters. |
| Claude Code `AskUserQuestion` | The origin of the shape | 1–4 questions, 2–4 options, `multiSelect`, per-option preview, `Chat about this` row | The batch shape itself, plus a per-question chat escape. |
| MCP elicitation | Protocol-level, host-native | Schema-driven forms, single/multi choice, free text, URLs | **Host-native**: the host renders it, so an image is just a MIME-typed field, and there is no terminal to fight. |

## What the field agrees on

1. **Tabs, not dialogs.** Every multi-question tool ships a tab strip with an
   answered/unanswered marker, and a final review step.
2. **A guaranteed escape hatch.** `Type something.` / `Other` on every question,
   in every mode, plus an external-editor round trip.
3. **Notes that do not consume an answer.** `n` everywhere.
4. **Checkbox multi-select** with an explicit commit row.
5. **Collapse the overlay to read the transcript**, keeping the answers.

## The three that appear only once

1. **Digit hotkeys** (`@hank-warren`) — answer in one keystroke.
2. **Subagent forwarding + attention alerts** (`avtc`) — a question from a worker
   surfaces in the parent's UI instead of being lost.
3. **A side question that never enters the transcript** (`rpiv-btw`).

## Where this package stands

**Ahead of the field:** inline images, in a real terminal, end to end — the only
one of these tools that can show a picture at all. Every other affordance above
is implemented: full-screen dashboard, tab strip, review step, notes (per-stage
and global, as rows and keys), checkbox multi-select, a typed escape hatch, the
external editor, collapse-to-one-line, revision rounds, and an off-by-default
auto-resolve onto a model-recommended option.

**Behind, and worth taking:**

| Gap | Why it matters | Cost |
|---|---|---|
| **No digit hotkeys** | `1`–`9` to answer in one keystroke is the field's best trick and ours is the only one without it. | small: one key handler, rows are already numbered |
| **No tab-to-comment** | Tab currently switches stage; annotating while browsing is a proven pattern. | small, but it collides with stage switching — a keymap decision |
| **No "chat about this"** | RPiV and Claude Code both give an escape that abandons the form and hands the model a sentence. Our `Request revision` asks for a *regenerated* option instead, which is a different promise. | small |
| **No subagent forwarding / attention alert** | A question raised by a subagent has nowhere to go. | larger, and depends on host seams |
| **Tool description not token-budgeted** | The lean fork cut 1,258 tokens to 215 by trimming ours-shaped text. Ours is 1,641 characters of description plus 1,214 of field text. | small, measurable |
| **No transcript entry renderer** | A finished review leaves a tool result only. | small |

## What this does not cover

The audit compared *harnesses*: what they offer, how they interrupt, how they
degrade. It did not re-open the visual-quality question — whether the generated
images are decision-useful is a separate, still-open problem, and no tool in
this survey shows a real image either.
