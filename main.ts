// Deterministic runner for token-radar-01. Scores with dashboard/model.js and dashboard/farm.js
// (the same scripts the page runs) and writes the gate files. No value math lives here.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const DASHBOARD_BUDGET = 60_000;
const BOARD_MAX_BYTES = 8 * 1024 * 1024;
const VALUE_CAP = 100_000_000_000_000;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const SLUG_RE = /^\S{1,128}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

interface Factors {
  peer_multiple: number;
  runway_days: number | null;
}

interface RankedRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  token_status: string;
  launch_class: string;
  below_floor: boolean;
  runway_days: number | null;
  implied_value_usd: number;
  per1k_farmed: number;
  factors: Factors;
  notes: string[];
  rank: number;
}

interface FarmStep {
  title: string;
  detail: string;
  cost_usd: number;
  minutes: number;
  hold_days?: number;
}

interface RadarApi {
  rankBoard: (snapshot: Snapshot) => {
    rows: RankedRow[];
    summary: { version: string; lines: string[]; constants: Record<string, unknown> };
    missing_watchlist: string[];
  };
  buildFarmPlan: (row: RankedRow, ctx: { asOf: string }) => FarmStep[];
  farmStepText: (step: FarmStep) => string;
  planTotals: (steps: FarmStep[]) => { cost_usd: number; minutes: number; hold_days: number };
}

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  launch_class: string;
  on_watchlist: boolean;
  peer_multiple: number;
  factors: Factors;
  farm_cost_usd: number;
  farm_minutes: number;
  hold_days: number;
  token_status: string;
  per1k_farmed: number;
  listed_at: string | null;
  below_floor: boolean;
  notes: string[];
}

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

function arg(name: string, fallback: string): string {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  if (at >= 0) {
    const next = process.argv[at + 1];
    if (next === undefined || next.startsWith('--')) fail(`missing value for --${name}`);
    return next;
  }
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function protocolIssue(value: unknown, index: number): string | null {
  if (!isObject(value)) return `protocols[${index}] is not an object`;
  const where = `protocols[${index}]`;
  if (typeof value.slug !== 'string' || !SLUG_RE.test(value.slug)) return `${where}.slug is not a slug`;
  if (typeof value.name !== 'string' || value.name.length === 0) return `${where}.name is empty`;
  if (!(value.category === null || typeof value.category === 'string')) return `${where}.category is not a string or null`;
  if (!Array.isArray(value.chains) || value.chains.some((chain) => typeof chain !== 'string')) return `${where}.chains is not a string array`;
  if (!finite(value.tvl_usd)) return `${where}.tvl_usd is not a finite number`;
  if (!(value.change_7d === null || finite(value.change_7d))) return `${where}.change_7d is not a number or null`;
  if (!(value.mcap_usd === null || finite(value.mcap_usd))) return `${where}.mcap_usd is not a number or null`;
  if (!(value.listed_at === null || typeof value.listed_at === 'string')) return `${where}.listed_at is not a string or null`;
  if (!(value.gecko_id === null || typeof value.gecko_id === 'string')) return `${where}.gecko_id is not a string or null`;
  if (!(value.symbol === null || typeof value.symbol === 'string')) return `${where}.symbol is not a string or null`;
  return null;
}

function snapshotIssue(value: unknown): string | null {
  if (!isObject(value)) return 'not an object';
  if (typeof value.as_of !== 'string' || !DAY_RE.test(value.as_of)) return 'as_of is not YYYY-MM-DD';
  if (typeof value.source !== 'string' || value.source.length === 0) return 'source is empty';
  if (!finite(value.floor_usd)) return 'floor_usd is not a finite number';
  if (!Array.isArray(value.watchlist)) return 'watchlist is not an array';
  if (!Array.isArray(value.protocols) || value.protocols.length === 0) return 'protocols is empty';
  const seen = new Set<string>();
  for (let i = 0; i < value.watchlist.length; i++) {
    const slug = value.watchlist[i];
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return `watchlist[${i}] is not a slug`;
  }
  for (let i = 0; i < value.protocols.length; i++) {
    const issue = protocolIssue(value.protocols[i], i);
    if (issue !== null) return issue;
    const slug = (value.protocols[i] as Protocol).slug;
    if (seen.has(slug)) return `duplicate slug ${slug}`;
    seen.add(slug);
  }
  for (const slug of value.watchlist) {
    if (!seen.has(slug as string)) return `watchlist slug ${String(slug)} is not in protocols`;
  }
  return null;
}

function readSnapshot(file: string): Snapshot {
  if (!existsSync(file)) fail(`no snapshot at ${file}: pass --input <snapshot.json|directory>`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`snapshot ${file} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const issue = snapshotIssue(parsed);
  if (issue !== null) fail(`snapshot ${file}: ${issue}`);
  return parsed as Snapshot;
}

/** Drop the endpoint URL. data.js is a script the page loads, and the dashboard may not name a network address. */
function publicSource(source: string): string {
  const fetched = /fetched\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+Z?)/.exec(source);
  if (fetched !== null) return `DefiLlama protocols endpoint, fetched ${fetched[1]}`;
  const stripped = source.replace(/https?:\/\/\S+/gi, 'protocols endpoint').replace(/\s+/g, ' ').trim();
  if (stripped.length > 0 && !/https?:\/\//i.test(stripped)) return stripped;
  return 'DefiLlama protocols endpoint';
}

function protocolRecord(protocol: Protocol): Protocol {
  return {
    slug: protocol.slug,
    name: protocol.name,
    category: protocol.category,
    chains: protocol.chains.slice(),
    tvl_usd: protocol.tvl_usd,
    change_7d: protocol.change_7d,
    mcap_usd: protocol.mcap_usd,
    listed_at: protocol.listed_at,
    gecko_id: protocol.gecko_id,
    symbol: protocol.symbol,
  };
}

function dataScript(snapshot: Snapshot): string {
  const source = publicSource(snapshot.source);
  if (/https?:\/\//i.test(source)) fail('data.js source still names an http(s) address');
  const body = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    watchlist: snapshot.watchlist.slice(),
    source,
    protocols: snapshot.protocols.map(protocolRecord),
  };
  const json = JSON.stringify(body).replace(/[<>&\u2028\u2029]/g, (ch) => {
    if (ch === '<') return '\\u003c';
    if (ch === '>') return '\\u003e';
    if (ch === '&') return '\\u0026';
    if (ch === '\u2028') return '\\u2028';
    return '\\u2029';
  });
  return `window.RADAR_SNAPSHOT = ${json};\n`;
}

function loadTokenRadar(dashboardDir: string): RadarApi {
  const sandbox: { TokenRadar?: RadarApi } = {};
  const context = createContext(sandbox);
  for (const name of ['model.js', 'farm.js']) {
    const path = join(dashboardDir, name);
    if (!existsSync(path)) fail(`dashboard/${name} is missing`);
    runInContext(readFileSync(path, 'utf8'), context, { filename: name });
  }
  const api = sandbox.TokenRadar;
  if (api === undefined || typeof api.rankBoard !== 'function' || typeof api.buildFarmPlan !== 'function' || typeof api.farmStepText !== 'function' || typeof api.planTotals !== 'function') {
    fail('dashboard scripts did not attach TokenRadar.rankBoard, buildFarmPlan, farmStepText and planTotals');
  }
  return api;
}

function boardRows(snapshot: Snapshot, api: RadarApi): { rows: BoardRow[]; model: { version: string; lines: string[]; constants: Record<string, unknown> } } {
  const ranked = api.rankBoard(snapshot);
  if (!Array.isArray(ranked.rows) || ranked.summary === undefined) fail('rankBoard did not return rows and a summary');
  if (Array.isArray(ranked.missing_watchlist) && ranked.missing_watchlist.length > 0) {
    fail(`model left watchlist slugs unranked: ${ranked.missing_watchlist.slice(0, 8).join(', ')}`);
  }
  const watch = new Set(snapshot.watchlist);
  const rows: BoardRow[] = [];
  for (const row of ranked.rows) {
    const steps = api.buildFarmPlan(row, { asOf: snapshot.as_of });
    const texts = steps.map((step) => api.farmStepText(step).trim());
    const totals = api.planTotals(steps);
    const factors = row.factors;
    rows.push({
      slug: row.slug,
      name: row.name,
      rank: row.rank,
      implied_value_usd: row.implied_value_usd,
      farm_steps: texts,
      category: row.category,
      chains: row.chains.slice(),
      tvl_usd: row.tvl_usd,
      change_7d: row.change_7d,
      age_days: row.runway_days == null ? null : row.runway_days,
      launch_class: row.launch_class,
      on_watchlist: watch.has(row.slug),
      peer_multiple: factors.peer_multiple,
      factors,
      farm_cost_usd: totals.cost_usd,
      farm_minutes: totals.minutes,
      hold_days: totals.hold_days,
      token_status: row.token_status,
      per1k_farmed: row.per1k_farmed,
      listed_at: row.listed_at,
      below_floor: row.below_floor,
      notes: row.notes.slice(),
    });
  }
  return { rows, model: ranked.summary };
}

function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board has ${rows.length} rows; the gate wants 100 to 4000`;
  const known = new Set(snapshot.protocols.map((protocol) => protocol.slug));
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as BoardRow;
    if (!SLUG_RE.test(row.slug)) return `row slug ${JSON.stringify(row.slug)} is not 1 to 128 non-whitespace characters`;
    if (!known.has(row.slug)) return `row slug ${row.slug} is not in the snapshot`;
    if (seen.has(row.slug)) return `duplicate row slug ${row.slug}`;
    seen.add(row.slug);
    if (row.rank !== i + 1) return `rows are not in rank order at ${row.slug} (rank ${row.rank})`;
    if (typeof row.name !== 'string' || row.name.length === 0) return `row ${row.slug} has an empty name`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > VALUE_CAP) {
      return `row ${row.slug} implied_value_usd ${row.implied_value_usd} is not a positive whole number within the cap`;
    }
    if (row.implied_value_usd > previous) return `implied value rises at rank ${row.rank} (${row.slug})`;
    previous = row.implied_value_usd;
    const steps = row.farm_steps;
    if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) {
      return `row ${row.slug} has ${Array.isArray(steps) ? steps.length : 'no'} farm steps; the gate wants 3 to 12`;
    }
    for (let s = 0; s < steps.length; s++) {
      const text = steps[s];
      if (typeof text !== 'string') return `row ${row.slug} farm step ${s + 1} is not a string`;
      const length = text.trim().length;
      if (length < 20 || length > 600) return `row ${row.slug} farm step ${s + 1} is ${length} characters; the gate wants 20 to 600`;
    }
  }
  if (rows.length >= 2 && rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) {
    return 'every implied value is equal, so the board does not rank';
  }
  const missing = snapshot.watchlist.filter((slug) => !seen.has(slug));
  if (missing.length > 0) return `watchlist missing ${missing.length}: ${missing.slice(0, 8).join(', ')}`;
  return null;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const dir = rel === '' ? root : join(root, rel);
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const child = rel === '' ? name : `${rel}/${name}`;
      const abs = join(root, child);
      const info = statSync(abs);
      if (info.isDirectory()) walk(child);
      else if (info.isFile()) out.push(child);
    }
  };
  if (existsSync(root)) walk('');
  return out;
}

function checkDashboard(dir: string): number {
  const files = listFiles(dir);
  if (files.length === 0) fail('dashboard/ has no files');
  let bytes = 0;
  for (const rel of files) {
    const buf = readFileSync(join(dir, rel));
    bytes += buf.length;
    const text = buf.toString('utf8');
    if (text.includes('http://') || text.includes('https://')) fail(`dashboard/${rel} contains an http(s) address`);
  }
  if (bytes >= DASHBOARD_BUDGET) fail(`dashboard/ is ${bytes} bytes; keep it under ${DASHBOARD_BUDGET}`);
  return bytes;
}

function copyFiles(from: string, to: string): string[] {
  const names = listFiles(from);
  for (const rel of names) {
    const dest = join(to, rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(join(from, rel), dest);
  }
  return names;
}

function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const iend = buf.lastIndexOf('IEND');
  if (iend < 0 || iend + 8 !== buf.length) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return null;
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) return null;
    while (i < buf.length && buf[i] === 0xff) i += 1;
    if (i >= buf.length) return null;
    const marker = buf[i] as number;
    i += 1;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (i + 1 >= buf.length) return null;
    const length = buf.readUInt16BE(i);
    if (length < 2 || i + length > buf.length) return null;
    const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (sof) return { height: buf.readUInt16BE(i + 3), width: buf.readUInt16BE(i + 5) };
    if (marker === 0xda) break;
    i += length;
  }
  return null;
}

function checkScreenshots(dir: string): string[] {
  if (!existsSync(dir)) fail('screenshots/ is missing: hand in 3, the board, a detail view and a filtered view');
  const names = readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
  const files: string[] = [];
  for (const name of names) {
    if (!statSync(join(dir, name)).isFile()) continue;
    files.push(name);
  }
  if (files.length < 3 || files.length > 4) {
    fail(`screenshots/ holds ${files.length} image${files.length === 1 ? '' : 's'}: hand in 3 or 4, the board, a detail view and a filtered view`);
  }
  for (const name of files) {
    if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
    const buf = readFileSync(join(dir, name));
    if (buf.length > SCREENSHOT_CAPS.max_bytes) fail(`screenshots/${name} is ${buf.length} bytes; the cap is ${SCREENSHOT_CAPS.max_bytes}`);
    const size = pngSize(buf) ?? jpegSize(buf);
    if (size === null) fail(`screenshots/${name} is not a whole PNG or JPEG`);
    const longSide = Math.max(size.width, size.height);
    const shortSide = Math.min(size.width, size.height);
    if (longSide > 1440 || shortSide < 800) {
      fail(`screenshots/${name} is ${size.width}x${size.height}; long side must be <= 1440 and short side >= 800`);
    }
  }
  return files;
}

function assertPageShape(dir: string): void {
  const names = listFiles(dir);
  if (!names.includes('index.html')) fail('dashboard/ has no index.html');
  if (!names.some((name) => name.endsWith('.css'))) fail('dashboard/ has no .css file');
  if (!names.some((name) => name.endsWith('.js'))) fail('dashboard/ has no .js file');
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const skipDossier = process.argv.includes('--skip-dossier');

const snapshot = readSnapshot(inputFile);
const dashboardDir = join(here, 'dashboard');
const dashBytes = checkDashboard(dashboardDir);
const api = loadTokenRadar(dashboardDir);
const built = boardRows(snapshot, api);
const rows = built.rows;
const issue = boardIssue(rows, snapshot);
if (issue !== null) fail(`the board fails the gate: ${issue}`);

const boardJson = `${JSON.stringify({ model: built.model, rows })}\n`;
if (Buffer.byteLength(boardJson, 'utf8') > BOARD_MAX_BYTES) fail(`board.json is over ${BOARD_MAX_BYTES} bytes`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), boardJson);
writeFileSync(join(out, 'data.js'), dataScript(snapshot));
copyFiles(dashboardDir, join(out, 'dashboard'));
copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));

if (!skipDossier) {
  assertPageShape(join(out, 'dashboard'));
  checkScreenshots(join(out, 'screenshots'));
  let dossier: Uint8Array;
  try {
    dossier = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const parsed = JSON.parse(Buffer.from(dossier).toString('utf8')) as { text?: string };
  if (typeof parsed.text !== 'string') fail('dossier has no text');
  if (parsed.text.includes('not shown') || parsed.text.includes('left out')) {
    fail('dossier text is truncated; keep dashboard/ inside the 65,536 byte text cap');
  }
  writeFileSync(join(out, 'dossier.json'), dossier);
}

let bestCustody = 0;
let covered = 0;
for (const row of rows) {
  if (row.on_watchlist) covered += 1;
  if (row.launch_class === 'custody' && bestCustody === 0) bestCustody = row.rank;
}

process.stdout.write(
  `token radar: ${rows.length} rows, watchlist ${covered}/${snapshot.watchlist.length}, best custody rank ${bestCustody === 0 ? 'none' : bestCustody}, dashboard ${dashBytes} bytes, ${out}\n`,
);
