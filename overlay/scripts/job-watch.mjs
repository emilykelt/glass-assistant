#!/usr/bin/env node
// Weekly scan of frontier-lab job boards for London/UK/remote roles a new
// graduate could realistically apply to. Writes the results to an Obsidian note
// and posts a macOS notification when something new turns up.
//
// Two passes. A keyword prefilter keeps roles in London/UK that aren't senior or
// non-technical by title and don't ask for more than 2 years. Claude then judges
// each surviving role against the profile in job-profile.md (apply / stretch / skip). Verdicts are
// cached in the state file, so each listing is judged once.
//
// Usage:
//   npm run jobs                # scan, update the note, notify on new roles
//   npm run jobs -- --dry       # print matches, write nothing
//
// Runs weekly via ~/Library/LaunchAgents/com.emilykelt.glass.jobwatch.plist.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

const VAULT = join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Obsidian Notes/Knowledge Base');
const NOTE = join(VAULT, 'Career', 'Lab Job Watch.md');
const STATE = join(homedir(), 'Library/Application Support/overlay/job-watch.json');
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Glass-job-watch';

const MODEL = 'claude-sonnet-4-6';
const LOCATION = /london|united kingdom|\buk\b/i;
const ENTRY = /fellow|residen|\bintern(ship)?s?\b|graduate|new grad|early[- ]career|student|junior|apprentic|research ready/i;
const SENIOR = /\b(staff|senior|sr\.?|principal|lead|manager|director|head|vp|chief|architect)\b/i;
// Trading firms post hundreds of quant/trading roles; only their AI roles are in scope.
const AI_TITLE = /\b(ai|ml|machine learning|llm|agent(s|ic)?|genai|nlp)\b/i;
const NON_TECH = /account|sales|legal|counsel|contracts|recruit|people|finance|accountant|marketing|brand|communications|assistant|it support|av engineer|transaction|energy|customer success|gtm|policy|economist|editor|content|program manager|deployment manager|support engineer|network engineer|laboratory/i;

const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/\s+/g, ' ');

async function get(url, as = 'json') {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'json' ? res.json() : res.text();
}

// Labs whose boards have a public JSON API. Frontier labs first, then neolabs
// and smaller London AI companies, then trading firms. To add one, find its slug on
// job-boards.greenhouse.io / jobs.ashbyhq.com / jobs.lever.co.
const BOARDS = [
  ['greenhouse', 'anthropic', 'Anthropic'],
  ['ashby', 'openai', 'OpenAI'],
  ['greenhouse', 'xai', 'xAI'],
  ['greenhouse', 'isomorphiclabs', 'Isomorphic Labs'],
  ['greenhouse', 'goodfire', 'Goodfire'],
  ['greenhouse', 'fractile', 'Fractile'],
  ['lever', 'apolloresearch', 'Apollo Research'],
  ['ashby', 'cohere', 'Cohere'],
  ['ashby', 'cognition', 'Cognition'],
  ['ashby', 'reflectionai', 'Reflection AI'],
  ['ashby', 'hcompany', 'H Company'],
  ['ashby', 'harmonic', 'Harmonic'],
  ['ashby', 'primeintellect', 'Prime Intellect'],
  ['ashby', 'perplexity', 'Perplexity'],
  ['ashby', 'elevenlabs', 'ElevenLabs'],
  ['ashby', 'synthesia', 'Synthesia'],
  ['ashby', 'wayve', 'Wayve'],
  ['ashby', 'faculty', 'Faculty'],
  ['ashby', 'basecamp-research', 'Basecamp Research'],
  // Trading firms: applied AI / ML roles only (AI_TITLE).
  ['greenhouse', 'wehrtyou', 'Hudson River Trading', 'ai'],
  ['greenhouse', 'janestreet', 'Jane Street', 'ai'],
  ['greenhouse', 'jumptrading', 'Jump Trading', 'ai'],
  ['greenhouse', 'xtxmarketstechnologies', 'XTX Markets', 'ai'],
  ['greenhouse', 'drweng', 'DRW', 'ai'],
  ['greenhouse', 'squarepointcapital', 'Squarepoint', 'ai'],
  ['greenhouse', 'imc', 'IMC', 'ai'],
];

async function greenhouse(slug, company) {
  const { jobs } = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return jobs.map((j) => ({
    id: `${slug}:${j.id}`,
    company,
    title: j.title.trim(),
    location: j.location.name,
    url: j.absolute_url,
    text: strip((j.content || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')),
  }));
}

async function ashby(slug, company) {
  const { jobs } = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return jobs.map((j) => ({
    id: `${slug}:${j.id}`,
    company,
    title: j.title.trim(),
    location: [j.location, ...(j.secondaryLocations || []).map((s) => s.location)].join('; '),
    url: j.jobUrl,
    text: j.descriptionPlain || '',
  }));
}

async function lever(slug, company) {
  const jobs = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return jobs.map((j) => ({
    id: `${slug}:${j.id}`,
    company,
    title: j.text.trim(),
    location: [j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean).join('; '),
    url: j.hostedUrl,
    text: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text} ${strip(l.content)}`)].join(' '),
  }));
}

const FETCHERS = { greenhouse, ashby, lever };

// Google Careers has no public API, so page through the HTML results. Job text
// is fetched per listing, which only matters for listings we haven't seen.
async function deepmind(seen) {
  const out = [];
  const ids = new Set();
  for (let page = 1; page <= 10; page++) {
    const html = await get(`https://www.google.com/about/careers/applications/jobs/results/?company=DeepMind&location=London%2C%20UK&page=${page}`, 'text');
    const slugs = [...new Set(html.match(/jobs\/results\/\d+-[a-z0-9-]+/g) || [])].filter((s) => !ids.has(s));
    if (!slugs.length) break;
    for (const slug of slugs) {
      ids.add(slug);
      const [num, ...words] = slug.replace('jobs/results/', '').split('-');
      const title = words.join(' ').replace(/ deepmind$/, '').replace(/\b\w/g, (c) => c.toUpperCase());
      out.push({
        id: `deepmind:${num}`,
        company: 'Google DeepMind',
        title,
        location: 'London, UK',
        url: `https://www.google.com/about/careers/applications/${slug}`,
        text: null,
      });
    }
  }
  for (const job of out) {
    if (seen[job.id]) { job.text = seen[job.id].text ?? ''; continue; }
    if (SENIOR.test(job.title) || NON_TECH.test(job.title)) { job.text = ''; continue; }
    try {
      const html = await get(job.url, 'text');
      const i = html.indexOf('Minimum qualifications');
      job.text = strip(i >= 0 ? html.slice(i, i + 6000) : '');
    } catch { job.text = ''; }
  }
  return out;
}

function maxYears(text) {
  const nums = [...text.matchAll(/(\d{1,2})\+?\s*(?:or more\s+)?years/gi)].map((m) => +m[1]).filter((n) => n < 20);
  return nums.length ? Math.max(...nums) : 0;
}

function prefilter(job) {
  if (!LOCATION.test(job.location)) return false;
  if (ENTRY.test(job.title)) return true;
  if (SENIOR.test(job.title) || NON_TECH.test(job.title)) return false;
  return maxYears(job.text || '') <= 2;
}

// The candidate profile is personal, so it lives in a gitignored file next to
// this script. Copy job-profile.example.md to job-profile.md and fill it in.
const PROFILE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'job-profile.md');
if (!existsSync(PROFILE_FILE)) throw new Error(`missing ${PROFILE_FILE} (copy job-profile.example.md)`);
const PROFILE = readFileSync(PROFILE_FILE, 'utf8').trim();

// The part of a listing that says who they want, so the prompt stays small.
function requirements(text) {
  const i = text.search(/thrive|good fit|qualifications|requirements|you have|you bring|about you/i);
  return text.slice(i >= 0 ? i : 0, (i >= 0 ? i : 0) + 1500);
}

async function judge(jobs) {
  if (!jobs.length) return {};
  const client = new Anthropic();
  const list = jobs.map((j) => `<role id="${j.id}">\n${j.company}: ${j.title} (${j.location})\n${requirements(j.text || '')}\n</role>`).join('\n');
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: `Candidate:\n${PROFILE}\n\nFor each role below, judge whether this candidate could realistically be hired into it straight after graduating, and whether it matches her goal.\n- "apply": entry-level or early-career friendly and a good match.\n- "stretch": no hard experience bar stated and a good match, but realistically wants more experience; worth a referral or a speculative application.\n- "skip": clearly senior, needs domain expertise she lacks, or off-goal.\n\nReply with only a JSON array: [{"id": "...", "verdict": "apply|stretch|skip", "reason": "at most 15 words"}]\n\n${list}`,
    }],
  });
  const raw = res.content.map((b) => b.text || '').join('');
  const arr = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
  return Object.fromEntries(arr.map((v) => [v.id, { verdict: v.verdict, reason: v.reason }]));
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { seen: {} }; }
}

function render(matches, fresh, today) {
  const row = (m) => `| ${m.company} | [${m.title.replace(/\|/g, '/')}](${m.url}) | ${m.location.replace(/\|/g, '/')} | ${m.why} | ${m.firstSeen} |`;
  const head = '| Lab | Role | Location | Verdict | First seen |\n|---|---|---|---|---|';
  return [
    '[[Opportunities]]',
    '',
    `Auto-generated weekly by \`overlay/scripts/job-watch.mjs\`. Last run: **${today}**. Edits here are overwritten; put notes in the role's own page.`,
    '',
    'London/UK roles, keyword-filtered for seniority and stated experience, then judged by Claude against your profile. **apply** = realistic now; **stretch** = good match but wants more experience, so go via a referral.',
    '',
    `## New this run (${fresh.length})`,
    '',
    fresh.length ? `${head}\n${fresh.map(row).join('\n')}` : '_Nothing new._',
    '',
    `## All current matches (${matches.length})`,
    '',
    `${head}\n${matches.map(row).join('\n')}`,
    '',
  ].join('\n');
}

function notify(msg) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    execFileSync('osascript', ['-e', `display notification "${esc(msg)}" with title "Lab job watch" sound name "Glass"`]);
  } catch {}
}

const state = loadState();
const today = new Date().toISOString().slice(0, 10);
const results = await Promise.allSettled([
  ...BOARDS.map(([ats, slug, company, only]) => FETCHERS[ats](slug, company)
    .then((jobs) => (only === 'ai' ? jobs.filter((j) => AI_TITLE.test(j.title)) : jobs))
    .catch((e) => { throw new Error(`${company}: ${e.message}`); })),
  deepmind(state.seen),
]);
const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
const jobs = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

const candidates = jobs.filter(prefilter);
const unjudged = candidates.filter((j) => !state.seen[j.id]?.verdict);
const verdicts = {};
for (let i = 0; i < unjudged.length; i += 25) Object.assign(verdicts, await judge(unjudged.slice(i, i + 25)));

const matches = [];
for (const job of candidates) {
  const prev = state.seen[job.id];
  const v = prev?.verdict ? prev : verdicts[job.id];
  job.verdict = v?.verdict;
  job.reason = v?.reason;
  if (!v || v.verdict === 'skip') continue;
  matches.push({ ...job, why: `**${v.verdict}**: ${v.reason}`, firstSeen: prev?.firstSeen || today, isNew: !prev });
}
const rank = (m) => (m.verdict === 'apply' ? 0 : 1);
matches.sort((a, b) => rank(a) - rank(b) || b.firstSeen.localeCompare(a.firstSeen) || a.company.localeCompare(b.company));
const fresh = matches.filter((m) => m.isNew);
const firstRun = !Object.keys(state.seen).length;

if (DRY) {
  for (const m of matches) console.log(`${m.isNew ? 'NEW ' : '    '}${m.company} | ${m.title} | ${m.location} | ${m.why}`);
  if (failed.length) console.log('failed:', failed);
  process.exit(0);
}

// Remember every listing (not just matches) so DeepMind pages aren't refetched,
// and drop anything no longer posted so the state file can't grow forever.
const seen = {};
for (const job of jobs) {
  const prev = state.seen[job.id];
  seen[job.id] = {
    firstSeen: prev?.firstSeen || today,
    ...(job.company === 'Google DeepMind' ? { text: job.text } : {}),
    ...(job.verdict ? { verdict: job.verdict, reason: job.reason } : {}),
  };
}
// If a board failed this run, keep its old entries so its roles don't all read as new next week.
for (const [id, v] of Object.entries(state.seen)) if (!seen[id] && failed.length) seen[id] = v;

mkdirSync(dirname(STATE), { recursive: true });
writeFileSync(STATE, JSON.stringify({ seen, lastRun: today }, null, 2));
writeFileSync(NOTE, render(matches, firstRun ? [] : fresh, today) + (failed.length ? `\n> Failed to fetch: ${failed.join('; ')}\n` : ''));

const summary = firstRun
  ? `Baseline: ${matches.length} matching roles. Open "Lab Job Watch" in Obsidian.`
  : fresh.length
    ? `${fresh.length} new: ${fresh.slice(0, 3).map((m) => `${m.company} ${m.title}`).join(', ')}${fresh.length > 3 ? '…' : ''}`
    : null;
if (summary) notify(summary);
if (failed.length) notify(`Couldn't reach: ${failed.join('; ')}`);
console.log(`${today}: ${matches.length} matches, ${fresh.length} new${failed.length ? `, failed: ${failed.join('; ')}` : ''}`);
