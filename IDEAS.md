# Ideas — Glass feature backlog

Features and changes we're considering, newest at the bottom. Each entry is stamped
with the date it was logged and the commit HEAD at that moment.

**Why the commit stamp:** it anchors the idea in time. Before acting on an old idea,
run `git log <sha>..HEAD --oneline` (using the entry's SHA) to see what has changed
since — an idea logged 40 commits ago may already be done or no longer make sense.

Add entries with `npm run idea -- "Title" "Description"` (auto-stamps date + commit).
Set `Status:` to `open` / `in progress` / `done` / `dropped` by hand.

---

### Embedding-based memory retrieval (only if the store outgrows context)
- Logged: 2026-07-27 (Monday) at `8ced199` — add security review agents
- Status: open

Deferred from the graph-memory work: if the runtime memory store ever grows past what fits in the system prompt / whole-file reads (thousands of notes), add embedding + vector retrieval on top of the existing wikilink graph. Not worth the infra/latency below that threshold. Revisit when memory:tree shows the store is large.

---

### D3 graph interface for the Obsidian People CRM
- Logged: 2026-07-27 (Monday) at `8ced199` — add security review agents
- Status: open

Interactive HTML/D3 force-directed view of Career/People/ in the Obsidian vault: nodes = person notes, edges = frontmatter 'knows' links, node size/colour by closeness + status. Wants shortest-path queries ('how do I reach Anthropic') and filtering by tag/status. Data source is markdown frontmatter, read via the Obsidian MCP client already wired up in main.js. Could render in a Glass panel or as a standalone HTML artifact.

---
