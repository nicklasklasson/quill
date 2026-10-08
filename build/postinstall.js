// Runs after `npm install`. Each step explains what went wrong and how to retry it on its own,
// and a failing step doesn't stop the others.
//
//   npm run setup:electron   make sure Electron's app files are unpacked
//   npm run build:helper     compile the Accessibility helper (needs Xcode command line tools)
//   npm run fetch:engine     download the pinned llama.cpp engine that runs the writing model

const steps = [
  ['Electron', './ensure-electron'],
  ['Accessibility helper', './build-helper'],
  ['Writing model engine', './fetch-engine'],
];

(async () => {
  for (const [name, file] of steps) {
    try {
      await require(file).run();
    } catch (err) {
      console.error(`\n✗ ${name}: ${err.message}\n`);
    }
  }
})();
