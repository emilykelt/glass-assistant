// Thin wrapper around the codesigned EventKit helper binary.
// Same contract as main.js's ekHelper(): argv in, parsed JSON out.
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

const HELPER = path.join(__dirname, '..', 'ekhelper');

async function ek(args) {
  let stdout;
  try {
    ({ stdout } = await execFileP(HELPER, args, { maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    // ekhelper writes a one-line reason to stderr and exits non-zero.
    const reason = String(err.stderr || err.message || '').trim();
    throw new Error(reason || `ekhelper ${args[0]} failed`);
  }
  const trimmed = String(stdout).trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

module.exports = { ek };
