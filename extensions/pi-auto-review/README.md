# pi-auto-review

Event-driven project review for [Pi](https://pi.dev) — automatically scans for problems after work completes, writes findings to `TODO.md`, and optionally auto-fixes them.

## The Point

This extension is **invisible to the agent**. No commands, no skills, no markers, no branding. Reviews trigger automatically when configured conditions are met — the agent just receives a follow-up message and does the work.

## Install

```bash
pi install /path/to/pi-auto-review
```

## How It Works

```
Ralph loop done → review → TODO.md → fix → re-review → fix → re-review (clean) → ✅
```

1. **Work completes** (Ralph loop done, agent finishes, session starts)
2. **Review triggers automatically** — scans for problems, writes TODO.md
3. **If `autoFix: true`** — agent fixes items, then re-reviews
4. **Fix loop continues** until project is clean or max rounds hit
5. **Convergence check** — if fixes cause MORE problems, bail immediately

### The fix loop is bounded

- **maxFixRounds** (default 3) — hard cap
- **Divergence detection** — if a re-review finds MORE items than before, stops immediately
- **Clean exit** — 0 items → done right away

## Triggers

| Trigger | Default | Description |
|---------|---------|-------------|
| `onRalphDone` | `true` | Auto-review when a Ralph loop completes |
| `onAgentEnd` | `false` | Auto-review after any agent finishes (after `minTurns`) |
| `onSessionStart` | `false` | Auto-review when a session starts |

## Configuration

Add to `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "autoReview": {
    "enabled": true,
    "todoPath": "TODO.md",
    "autoFix": false,
    "maxFixRounds": 3,
    "onRalphDone": true,
    "onAgentEnd": false,
    "onSessionStart": false,
    "minTurns": 3,
    "cooldownMs": 120000,
    "scope": "full",
    "excludePatterns": ["node_modules", ".git", "dist", "build", "coverage"]
  }
}
```

### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Master toggle — disable without uninstalling |
| `todoPath` | `string` | `"TODO.md"` | Path to the todo file |
| `autoFix` | `boolean` | `false` | After building the todo, go fix the problems |
| `maxFixRounds` | `number` | `3` | Max review→fix→re-review loops |
| `onRalphDone` | `boolean` | `true` | Auto-review when Ralph loop completes |
| `onAgentEnd` | `boolean` | `false` | Auto-review after agent finishes |
| `onSessionStart` | `boolean` | `false` | Auto-review on session start |
| `minTurns` | `number` | `3` | Minimum turns before `onAgentEnd` fires |
| `cooldownMs` | `number` | `120000` | Minimum ms between auto-reviews |
| `scope` | `"full"\|"staged"\|"diff"` | `"full"` | Review scope |
| `excludePatterns` | `string[]` | `["node_modules", ...]` | Directories to skip |
| `prompt` | `string\|null` | `null` | Custom first-review prompt |
| `rereviewPrompt` | `string\|null` | `null` | Custom re-review prompt. Placeholders: `{round}`, `{maxRounds}`, `{previousItems}`, `{focusAreas}` |
| `fixInstruction` | `string\|null` | `null` | Custom instruction appended when autoFix is on |
| `focusAreas` | `string[]\|null` | `null` | Override default list of things to look for |

## Fix-Only Philosophy

Auto-review finds **what's broken**, not what's missing:
- ✅ Build errors, type errors, lint failures
- ✅ Failing tests, missing tests
- ✅ Security vulnerabilities, hardcoded secrets
- ✅ Broken imports, dead code
- ✅ FIXME/HACK markers (bugs, not ideas)
- ✅ Debug leftovers (console.log in prod)
- ❌ Feature requests ("add dark mode")
- ❌ Architecture proposals ("should use microservices")
- ❌ Nice-to-haves ("consider using X pattern")

## Custom Prompts

All prompts are customizable. Use `null` or omit to keep defaults.

```json
{
  "autoReview": {
    "prompt": "Focus on TypeScript strict mode errors and security issues in the API routes.",
    "rereviewPrompt": "Check round {round}/{maxRounds}. Previously found {previousItems} issues.",
    "fixInstruction": "Fix each item, then run the test suite to verify.",
    "focusAreas": [
      "Type errors in src/api/",
      "Security issues (hardcoded secrets, eval usage)",
      "Failing tests"
    ]
  }
}
```

Note: format instructions (TODO.md markers, `_Items found: N_`) are always appended, even with custom prompts. This ensures the fix loop's item counting works correctly.

## Cooldown

2-minute cooldown by default (`cooldownMs: 120000`). Prevents review spam when multiple events fire close together.

## License

MIT