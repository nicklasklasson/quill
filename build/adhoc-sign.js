// electron-builder "afterPack" hook for macOS.
//
// Without a Developer ID certificate, electron-builder doesn't sign the app at all. The app then
// keeps Electron's original signature, which is broken by renaming the app and editing its
// Info.plist, and macOS can't tie permissions such as Accessibility to it. This hook gives the
// app a valid ad-hoc ("local") signature instead.
//
// It runs as afterPack rather than afterSign, because electron-builder skips afterSign when it
// had no certificate to sign with. If a certificate is available, electron-builder still signs
// the app properly afterwards, replacing this ad-hoc signature.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return MACHO_MAGICS.has(buf.readUInt32BE(0));
  } catch (_) {
    return false;
  }
}

function findMachO(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) findMachO(full, found);
    else if (isMachO(full)) found.push(full);
  }
  return found;
}

function sign(file) {
  execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'inherit' });
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // A universal build packs an Intel and an Apple Silicon copy in "-temp" folders and then merges
  // them. Signing those halves would break the merge, so only sign the merged app.
  if (/-temp$/.test(context.appOutDir)) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${appPath}`);

  // --deep doesn't reach plain executables and libraries in Resources: the Accessibility helper,
  // the llama.cpp engine and native modules. Apple Silicon refuses to run unsigned code, so sign
  // them first, libraries before the programs that load them.
  const resources = path.join(appPath, 'Contents', 'Resources');
  const machO = findMachO(resources);
  machO.sort((a, b) => Number(b.endsWith('.dylib') || b.endsWith('.node')) - Number(a.endsWith('.dylib') || a.endsWith('.node')));
  for (const file of machO) sign(file);

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signature is valid (${machO.length} extra binaries signed)`);
};
