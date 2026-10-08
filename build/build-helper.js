// Compiles native/QuillAX.swift into native/quill-ax, a universal binary when possible.
//
// Needs the Swift compiler from Xcode's command line tools (`xcode-select --install`).
// Run on its own with `npm run build:helper`.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'native', 'QuillAX.swift');
const output = path.join(root, 'native', 'quill-ax');
const MIN_MACOS = '14.0';

function sh(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8' });
  return { ok: result.status === 0, out: (result.stdout || '') + (result.stderr || '') };
}

async function run() {
  if (process.platform !== 'darwin') return;
  if (!sh('xcrun', ['--find', 'swiftc']).ok) {
    throw new Error('The Swift compiler is missing. Install the Xcode command line tools with `xcode-select --install`, then run `npm run build:helper`.');
  }

  const frameworks = ['-framework', 'Cocoa', '-framework', 'ApplicationServices'];
  const built = [];
  const failed = {};
  for (const arch of ['arm64', 'x86_64']) {
    const out = `${output}-${arch}`;
    const result = sh('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos${MIN_MACOS}`, ...frameworks, '-o', out, source]);
    if (result.ok) built.push(out);
    else failed[arch] = result.out;
  }

  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  if (!built.some((f) => f.endsWith(hostArch))) {
    // The version for this Mac failed: that's a real error, so show the compiler output.
    throw new Error(`Couldn't compile the Accessibility helper:\n${failed[hostArch]}`);
  }

  if (built.length === 2) {
    const lipo = sh('lipo', ['-create', ...built, '-output', output]);
    if (!lipo.ok) throw new Error(`lipo failed: ${lipo.out}`);
    for (const f of built) fs.unlinkSync(f);
    console.log('✓ Accessibility helper built (Apple Silicon and Intel)');
  } else {
    fs.renameSync(built[0], output);
    const missing = hostArch === 'arm64' ? 'Intel' : 'Apple Silicon';
    console.log(`✓ Accessibility helper built for this Mac (the ${missing} version can't be built with these command line tools; on ${missing} Macs the panel works as a scratchpad only)`);
  }
  fs.chmodSync(output, 0o755);
}

module.exports = { run };
if (require.main === module) run().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
