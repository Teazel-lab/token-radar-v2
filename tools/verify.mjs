// Gate check: two identical full runs, then the board, dashboard, shots and dossier.
// node tools/verify.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runs = ['out/verify-a', 'out/verify-b'];
let failed = 0;

function report(name, ok, detail) {
  if (!ok) failed += 1;
  const extra = detail ? ' — ' + detail : '';
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + extra);
}

function walk(dir) {
  const out = [];
  const visit = (rel) => {
    const abs = join(dir, rel);
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith('.')) continue;
      const child = rel ? rel + '/' + name : name;
      const info = statSync(join(dir, child));
      if (info.isDirectory()) visit(child);
      else if (info.isFile()) out.push(child);
    }
  };
  if (existsSync(dir)) visit('');
  return out;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function pngIhdr(buf) {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

for (const rel of runs) {
  rmSync(join(root, rel), { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    ['main.ts', '--input', '_kit/input/snapshot.json', '--output', rel],
    { cwd: root, encoding: 'utf8' },
  );
  const tail = ((result.stderr || '') + (result.stdout || '')).trim().split('\n').pop();
  report('main.ts ' + rel, result.status === 0, result.status === 0 ? tail : tail || 'exit ' + result.status);
}

const dirA = join(root, runs[0]);
const dirB = join(root, runs[1]);
const filesA = walk(dirA);
const filesB = walk(dirB);
const setB = new Set(filesB);
let mismatch = 0;
const onlyA = filesA.filter((rel) => !setB.has(rel));
const onlyB = filesB.filter((rel) => !filesA.includes(rel));
for (const rel of filesA) {
  if (!setB.has(rel)) continue;
  if (sha256(join(dirA, rel)) !== sha256(join(dirB, rel))) mismatch += 1;
}
report(
  'sha256 identical',
  onlyA.length === 0 && onlyB.length === 0 && mismatch === 0 && filesA.length > 0,
  filesA.length + ' files, ' + mismatch + ' hash mismatches, only-a ' + onlyA.length + ', only-b ' + onlyB.length,
);

const snap = JSON.parse(readFileSync(join(root, '_kit', 'input', 'snapshot.json'), 'utf8'));
const known = new Set((snap.protocols || []).map((p) => p.slug));
const watch = Array.isArray(snap.watchlist) ? snap.watchlist : [];
let board = null;
try {
  board = JSON.parse(readFileSync(join(dirA, 'board.json'), 'utf8'));
} catch (err) {
  report('board.json', false, err instanceof Error ? err.message : String(err));
}
const rows = board && Array.isArray(board.rows) ? board.rows : null;

if (!rows) {
  for (const name of ['row count', 'ranks 1..N', 'value non-increasing', 'values not all equal', 'watchlist coverage', 'farm steps', 'slugs from snapshot', 'custody outside top 30']) {
    report(name, false, 'no rows');
  }
} else {
  report('row count', rows.length >= 100 && rows.length <= 4000, String(rows.length));

  const ranks = rows.map((row) => row.rank);
  const rankSet = new Set(ranks);
  let ranksOk = ranks.length === rows.length && rankSet.size === rows.length;
  for (let n = 1; n <= rows.length; n += 1) if (!rankSet.has(n)) ranksOk = false;
  ranksOk = ranksOk && ranks.every((n) => Number.isInteger(n) && n > 0);
  report('ranks 1..N', ranksOk, ranksOk ? '1..' + rows.length : 'rank set is not 1..N');

  const byRank = rows.slice().sort((a, b) => a.rank - b.rank);
  let rising = null;
  for (let i = 1; i < byRank.length; i += 1) {
    if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) {
      rising = byRank[i].rank;
      break;
    }
  }
  report('value non-increasing', rising === null, rising === null ? 'rank 1 is the largest' : 'rises at rank ' + rising);

  const same = rows.length >= 2 && rows.every((row) => row.implied_value_usd === rows[0].implied_value_usd);
  report('values not all equal', !same, same ? 'every implied value matches' : 'spread');

  const slugs = new Set(rows.map((row) => row.slug));
  const missing = watch.filter((slug) => !slugs.has(slug));
  report(
    'watchlist coverage',
    watch.length === 40 && missing.length === 0,
    (watch.length - missing.length) + '/' + watch.length,
  );

  let farmBad = null;
  for (const row of rows) {
    const steps = row.farm_steps;
    if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) {
      farmBad = row.slug + ' has ' + (Array.isArray(steps) ? steps.length : 'no') + ' steps';
      break;
    }
    for (let s = 0; s < steps.length; s += 1) {
      const text = steps[s];
      const len = typeof text === 'string' ? text.trim().length : -1;
      if (len < 20 || len > 600) {
        farmBad = row.slug + ' step ' + (s + 1) + ' is ' + len + ' chars';
        break;
      }
    }
    if (farmBad) break;
  }
  report('farm steps', farmBad === null, farmBad || '3-12 steps, 20-600 chars');

  let slugBad = null;
  const seen = new Set();
  for (const row of rows) {
    const slug = row.slug;
    if (typeof slug !== 'string' || !/^\S{1,128}$/.test(slug)) {
      slugBad = 'bad slug ' + JSON.stringify(slug);
      break;
    }
    if (!known.has(slug)) {
      slugBad = slug + ' is not in the snapshot';
      break;
    }
    if (seen.has(slug)) {
      slugBad = 'duplicate ' + slug;
      break;
    }
    seen.add(slug);
    if (typeof row.name !== 'string' || row.name.length === 0) {
      slugBad = slug + ' has an empty name';
      break;
    }
  }
  report('slugs from snapshot', slugBad === null, slugBad || seen.size + ' slugs');

  const custodyTop = rows.filter((row) => row.launch_class === 'custody' && row.rank <= 30);
  report(
    'custody outside top 30',
    custodyTop.length === 0,
    custodyTop.length === 0 ? 'none in 1..30' : custodyTop.map((row) => row.slug + '#' + row.rank).join(', '),
  );
}

const dashDir = join(dirA, 'dashboard');
const dashFiles = walk(dashDir);
let dashBytes = 0;
let httpHit = null;
let hasHtml = false;
let hasCss = false;
let hasJs = false;
for (const rel of dashFiles) {
  const buf = readFileSync(join(dashDir, rel));
  dashBytes += buf.length;
  if (rel === 'index.html') hasHtml = true;
  if (rel.endsWith('.css')) hasCss = true;
  if (rel.endsWith('.js')) hasJs = true;
  const text = buf.toString('utf8');
  if (text.includes('http://') || text.includes('https://')) httpHit = rel;
}
report(
  'dashboard files',
  hasHtml && hasCss && hasJs && dashFiles.length > 0 && dashBytes < 60000,
  dashFiles.length + ' files, ' + dashBytes + ' bytes',
);
report('dashboard no http(s)', httpHit === null, httpHit || 'clean');

const shotFiles = walk(join(dirA, 'screenshots'));
let shotDetail = shotFiles.length + ' files';
let shotsOk = shotFiles.length === 3;
for (const rel of shotFiles) {
  const buf = readFileSync(join(dirA, 'screenshots', rel));
  const size = pngIhdr(buf);
  const dim = size ? size.width + 'x' + size.height : 'not png';
  shotDetail += '; ' + rel + ' ' + buf.length + ' ' + dim;
  if (buf.length > 512 * 1024) shotsOk = false;
  if (!size || size.width !== 1440 || size.height !== 900) shotsOk = false;
}
report('screenshots', shotsOk, shotDetail);

let dossierText = '';
try {
  const dossier = JSON.parse(readFileSync(join(dirA, 'dossier.json'), 'utf8'));
  dossierText = typeof dossier.text === 'string' ? dossier.text : '';
} catch (err) {
  dossierText = '';
  report('dossier readable', false, err instanceof Error ? err.message : String(err));
}
const cut = dossierText.includes('not shown') || dossierText.includes('left out');
report('dossier not truncated', dossierText.length > 0 && !cut, cut ? 'cut line present' : dossierText.length + ' text chars');

if (failed) process.exit(1);
