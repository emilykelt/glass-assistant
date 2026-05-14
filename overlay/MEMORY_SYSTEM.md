# Memory storage system

How the overlay persists long-term memory across sessions.

## On-disk layout

Everything lives under Electron's per-app `userData` directory:

```
<userData>/memory/
├── memory.md           ← curated index, read into every system prompt
├── general.md          ← stable user preferences, identity, environment
├── domain/<topic>.md   ← topic-specific knowledge (one file per topic)
└── tools/<tool>.md     ← tool configs, CLI patterns, workarounds
```

On macOS `userData` resolves to `~/Library/Application Support/<app name>/`. The directory and the two seed files (`memory.md`, `general.md`) are created on first launch by `ensureMemoryBootstrap()` in `overlay/main.js:164`.

Files are plain Markdown. They are intended to be hand-readable and hand-editable — nothing is encrypted, indexed, or chunked.

## Migration from the legacy store

Earlier builds stored memory as `userData/memory.json` (an array of `{content, updated_at}` entries). On startup, `migrateLegacyMemory()` (`overlay/main.js:195`) collapses that array into a dated bullet list under a `## Migrated entries` section in `general.md`, then renames the JSON file to `memory.json.bak`. The migration runs at most once.

## IPC API (main process)

Defined in `overlay/main.js:244-277`:

| Channel | Handler | Returns |
| --- | --- | --- |
| `memory:tree` | walks the directory, returning `{path, size, modified}` for every `.md` file | `Array<{path, size, modified}>` |
| `memory:read` | reads a single file by relative path | string (file contents) |
| `memory:write` | overwrites a file (creates parents) | `{path, bytes}` |
| `memory:append` | appends a markdown block, separating with a blank line and trimming trailing whitespace | `{path, bytes}` |
| `memory:delete` | removes a file | `{removed: boolean}` |

### Path safety

Every handler funnels through `resolveMemPath()` (`overlay/main.js:151`), which:

1. Rejects non-strings and empty paths.
2. Normalizes backslashes and strips leading slashes.
3. Rejects `..` (no traversal).
4. Requires a `.md` extension.
5. Resolves against the memory root and asserts the result stays inside it.

This means the renderer cannot read or write files outside the memory directory, even if the model hallucinates a malicious path.

## Preload bridge

`overlay/preload.js:21-27` exposes the handlers to the renderer as `window.memory`:

```js
window.memory = {
  tree:   ()              => ipcRenderer.invoke('memory:tree'),
  read:   (path)          => ipcRenderer.invoke('memory:read', path),
  write:  (path, content) => ipcRenderer.invoke('memory:write',  { path, content }),
  append: (path, content) => ipcRenderer.invoke('memory:append', { path, content }),
  delete: (path)          => ipcRenderer.invoke('memory:delete', path),
};
```

## Model-facing tools

The renderer registers five Anthropic tools that map 1:1 onto the IPC channels (`overlay/renderer/app.js:113-164`, dispatched at `overlay/renderer/app.js:939-948`):

- `list_memory_files` → `memory.tree()`
- `read_memory` → `memory.read(path)`
- `write_memory` → `memory.write(path, content)`
- `append_memory` → `memory.append(path, content)`
- `delete_memory` → `memory.delete(path)`

## How the model uses it

The system prompt (`overlay/renderer/app.js:5-57`) injects the current `memory.md` index on every turn. The model is instructed to:

1. Treat `memory.md` as its map. Only call `read_memory` for a specific file if its description in the index suggests relevance — never fan out and read everything.
2. Save durable facts when revealed:
   - General user info → `append_memory("general.md", …)`.
   - New topic → `write_memory("domain/<topic>.md", …)` **and** update `memory.md`.
   - Tool/CLI quirk → `write_memory("tools/<tool>.md", …)` **and** update `memory.md`.
3. Prefix every new entry with `**[YYYY-MM-DD]**` so age can be judged later.
4. Keep `memory.md` accurate whenever a file is created or deleted (one bullet per file, one-line purpose).
5. Perform memory operations silently — no narration.
6. Be selective: durable user facts only, no trivia.

## Design notes

- **Markdown, not a database.** The model edits memory the same way a human would edit notes. There is no schema, no embeddings, no retrieval beyond a literal file read.
- **The index is the retrieval layer.** Because every turn ships `memory.md` to the model, the index doubles as both a table of contents and the cue that tells the model what's worth fetching.
- **Append vs. write.** `append_memory` is preferred for adding a single fact to an existing file because it preserves history and avoids accidental overwrites. `write_memory` is reserved for creating new files or doing a deliberate rewrite.
- **No automatic pruning.** Stale entries decay only when the model (or the user) edits them. Dated prefixes exist so future-you can judge what's still load-bearing.
