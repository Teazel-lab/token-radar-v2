// Headless screenshots of the three views the judge sees.
// node tools/capture.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'out', 'capture');
const shotDir = join(root, 'screenshots');
const chrome = '/usr/bin/google-chrome';
const MAX_EACH = 340 * 1000;
const MAX_ALL = 1000 * 1000;

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);
}

run(process.execPath, [
  'main.ts',
  '--input',
  '_kit/input/snapshot.json',
  '--output',
  'out/capture',
  '--skip-dossier',
]);

const board = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8'));
const rows = Array.isArray(board.rows) ? board.rows : [];
const pick = rows.slice(0, 5).find((row) => row && row.on_watchlist === true);
if (!pick) {
  console.error('no watchlist protocol in the board top 5');
  process.exit(1);
}

const page = join(outDir, 'dashboard', 'index.html');
if (!existsSync(page)) {
  console.error('missing ' + page);
  process.exit(1);
}

mkdirSync(shotDir, { recursive: true });

const views = [
  ['1-board.png', '#/'],
  ['2-detail.png', '#/p/' + encodeURIComponent(pick.slug)],
  ['3-filtered.png', '#/?class=watchlist&sort=growth&dir=desc'],
];

console.log('detail slug ' + pick.slug + ' rank ' + pick.rank);

for (const [name, route] of views) {
  const file = join(shotDir, name);
  const url = 'file://' + page + route;
  run(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1440,900',
    '--virtual-time-budget=4000',
    '--screenshot=' + file,
    url,
  ]);
  if (!existsSync(file) || statSync(file).size < 1000) {
    console.error('chrome wrote no screenshot for ' + url);
    process.exit(1);
  }
}

const py = `
import json, sys
from PIL import Image
files = json.loads(sys.stdin.read())
MAX_EACH = ${MAX_EACH}
MAX_ALL = ${MAX_ALL}
W, H = 1440, 900

def fit(im):
    im = im.convert("RGB")
    w, h = im.size
    if w == W * 2 and h >= H * 2:
        im = im.resize((w // 2, h // 2), Image.Resampling.LANCZOS)
        w, h = im.size
    if w >= W and h >= H:
        return im.crop((0, 0, W, H))
    canvas = Image.new("RGB", (W, H), (16, 22, 20))
    canvas.paste(im.crop((0, 0, min(w, W), min(h, H))), (0, 0))
    return canvas

def save(im, path, colors):
    out = im if colors is None else im.quantize(colors=colors, method=Image.Quantize.MEDIANCUT)
    out.save(path, "PNG", optimize=True)

images = []
for path in files:
    im = fit(Image.open(path))
    save(im, path, None)
    images.append(im)

def sizes():
    import os
    return [os.path.getsize(p) for p in files]

for path, im in zip(files, images):
    import os
    colors = 256
    while os.path.getsize(path) > MAX_EACH and colors >= 32:
        save(im, path, colors)
        colors //= 2

guard = 0
while sum(sizes()) > MAX_ALL and guard < 12:
    guard += 1
    biggest = max(range(len(files)), key=lambda i: sizes()[i])
    # Re-quantize from the fitted RGB, stepping colors down from the current file.
    current = Image.open(files[biggest])
    colors = max(16, (len(current.getcolors(1_000_000) or []) or 128) // 2)
    save(images[biggest], files[biggest], colors)

report = []
for path in files:
    im = Image.open(path)
    report.append({"path": path, "bytes": __import__("os").path.getsize(path), "width": im.size[0], "height": im.size[1], "mode": im.mode})
print(json.dumps(report))
`;

const encoded = spawnSync('python3', ['-c', py], {
  input: JSON.stringify(views.map(([name]) => join(shotDir, name))),
  encoding: 'utf8',
});
if (encoded.stdout) {
  const start = encoded.stdout.indexOf('[');
  const report = JSON.parse(encoded.stdout.slice(start));
  let sum = 0;
  for (const row of report) {
    sum += row.bytes;
    console.log(`${row.width}x${row.height}  ${row.bytes} bytes  ${row.path}`);
  }
  console.log(`total ${sum} bytes`);
  if (report.some((row) => row.width !== 1440 || row.height !== 900) || sum > MAX_ALL) {
    console.error('screenshot size budget missed');
    process.exit(1);
  }
}
if (encoded.stderr) process.stderr.write(encoded.stderr);
if (encoded.status !== 0) process.exit(encoded.status === null ? 1 : encoded.status);
