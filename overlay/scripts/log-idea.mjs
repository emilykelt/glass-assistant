#!/usr/bin/env node
// Append a feature idea to IDEAS.md, auto-stamped with today's date and the
// current git commit. The commit stamp is the anti-staleness anchor: later you
// can run `git log <sha>..HEAD` to see everything that changed since an idea was
// logged, and judge whether it's still worth doing or already covered.
//
// Usage:
//   npm run idea -- "Short title" "Optional longer description (one paragraph)"
//   npm run idea                       # appends a blank template to fill in by hand

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ideasPath = join(repoRoot, 'IDEAS.md');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot }).toString().trim();
  } catch {
    return '';
  }
}

const now = new Date();
const iso = now.toISOString().slice(0, 10);
const weekday = now.toLocaleDateString('en-GB', { weekday: 'long' });
const sha = git(['rev-parse', '--short', 'HEAD']) || 'unknown';
const subject = git(['log', '-1', '--pretty=%s']) || '(no commit)';

const [title, description] = process.argv.slice(2);

const stamp = `- Logged: ${iso} (${weekday}) at \`${sha}\` — ${subject}\n- Status: open`;
const entry = title
  ? `### ${title}\n${stamp}\n\n${description ? description.trim() : '_(no description)_'}\n`
  : `### TITLE HERE\n${stamp}\n\n_Describe the idea, and why now / what it depends on._\n`;

if (!existsSync(ideasPath)) {
  writeFileSync(
    ideasPath,
    `# Ideas — Glass feature backlog

Features and changes we're considering, newest at the bottom. Each entry is stamped
with the date it was logged and the commit HEAD at that moment.

**Why the commit stamp:** it anchors the idea in time. Before acting on an old idea,
run \`git log <sha>..HEAD --oneline\` (using the entry's SHA) to see what has changed
since — an idea logged 40 commits ago may already be done or no longer make sense.

Add entries with \`npm run idea -- "Title" "Description"\` (auto-stamps date + commit).
Set \`Status:\` to \`open\` / \`in progress\` / \`done\` / \`dropped\` by hand.

---

`
  );
}

const existing = readFileSync(ideasPath, 'utf8').replace(/\s+$/, '');
writeFileSync(ideasPath, existing + '\n\n' + entry + '\n---\n');

process.stdout.write(`Logged idea to IDEAS.md at ${sha} (${iso}).\n`);
