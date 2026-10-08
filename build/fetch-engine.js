// Downloads the llama.cpp server that runs the writing model, for both Apple Silicon and Intel,
// into vendor/llama/<arch>/. electron-builder copies that folder into the app.
//
// The version is pinned and each download is checked against its SHA-256 checksum, so a build
// always contains exactly these files. Run on its own with `npm run fetch:engine`.
//
// To upgrade: pick a build from https://github.com/ggml-org/llama.cpp/releases, update VERSION and
// both checksums (`shasum -a 256 <file>`), and test.

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = 'b11433';
const ARCHIVES = {
  arm64: { file: `llama-${VERSION}-bin-macos-arm64.tar.gz`, sha256: '5e7b2383009facb31404f308cdb9edd1fb15131330801408fb582bd05e188f97' },
  x64: { file: `llama-${VERSION}-bin-macos-x64.tar.gz`, sha256: 'caaadcff99ce696bbb6a1ef6f7c0050250fe60d8448464ee7c90878cde3a5370' },
};
// llama-server and the libraries it loads. Only these are copied, under the names it loads them
// by, so the bundle carries no symlinks and none of the other tools.
const FILES = [
  'llama-server',
  'libllama-server-impl.dylib',
  'libllama-common.0.dylib',
  'libllama.0.dylib',
  'libmtmd.0.dylib',
  'libggml.0.dylib',
  'libggml-base.0.dylib',
  'libggml-cpu.0.dylib',
  'libggml-blas.0.dylib',
  'libggml-rpc.0.dylib',
  'libggml-metal.0.dylib', // Apple Silicon only
  'LICENSE',
];

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'vendor', 'llama');

function isComplete(dir) {
  try {
    return fs.readFileSync(path.join(dir, '.version'), 'utf8').trim() === VERSION
      && fs.existsSync(path.join(dir, 'llama-server'));
  } catch (_) {
    return false;
  }
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, data);
  return data;
}

async function fetchArch(arch) {
  const target = path.join(vendor, arch);
  if (isComplete(target)) return false;
  const { file, sha256 } = ARCHIVES[arch];
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${VERSION}/${file}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-engine-'));
  try {
    const archive = path.join(tmp, file);
    const data = await download(url, archive);
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== sha256) {
      throw new Error(`${file} doesn't match its checksum (expected ${sha256}, got ${actual}). Not using it.`);
    }
    const unpack = path.join(tmp, 'unpack');
    fs.mkdirSync(unpack);
    const tar = spawnSync('tar', ['-xzf', archive, '-C', unpack, '--strip-components=1'], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error(`Couldn't unpack ${file}.`);

    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const name of FILES) {
      const from = path.join(unpack, name);
      if (!fs.existsSync(from)) continue;
      fs.copyFileSync(from, path.join(target, name)); // follows symlinks, so real files land here
      if (name !== 'LICENSE') fs.chmodSync(path.join(target, name), 0o755);
    }
    if (!fs.existsSync(path.join(target, 'llama-server'))) throw new Error(`llama-server is missing from ${file}.`);
    fs.writeFileSync(path.join(target, '.version'), VERSION);
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function run() {
  if (process.platform !== 'darwin') return;
  let changed = false;
  for (const arch of Object.keys(ARCHIVES)) {
    if (!isComplete(path.join(vendor, arch))) console.log(`Downloading the writing model engine (llama.cpp ${VERSION}, ${arch})…`);
    changed = (await fetchArch(arch)) || changed;
  }
  console.log(`✓ Writing model engine ready (llama.cpp ${VERSION})${changed ? '' : ', already downloaded'}`);
}

module.exports = { run, VERSION };
if (require.main === module) run().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
