// The writing models Quill can use, and the one-time download that fetches them.
//
// This download is the only network access Quill ever makes. Every file is checked against the
// SHA-256 checksum below before it is used; a file that doesn't match is deleted. A model file
// is data (numbers), not a program, so it can't run anything by itself.
//
// Each URL is pinned to a repository revision, so it always serves the same bytes even if the
// publisher later replaces the file in that repository. The checksums below were taken from each
// model's own page on Hugging Face at that revision.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GB = 1e9;

const CATALOG = {
  gemma: {
    id: 'gemma',
    label: 'Gemma 4 12B',
    name: 'Gemma 4 12B Instruct (Google DeepMind, June 2026)',
    license: 'Apache 2.0',
    file: 'gemma-4-12b-it-q4_k_m.gguf',
    url: 'https://huggingface.co/lmstudio-community/gemma-4-12B-it-GGUF/resolve/40b870babe39398ce917bbf4b4ff9b5a1f12710e/gemma-4-12B-it-Q4_K_M.gguf',
    sha256: '95d83ba36642b1f385fb906b5962a71763361be3bac930a709945f72d97473f8',
    approxBytes: 7.38 * GB,
    recommendedMemoryGB: 16,
    blurb: 'Newest and most capable. Needs 16 GB of memory or more.',
  },
  standard: {
    id: 'standard',
    label: 'Qwen2.5 7B',
    name: 'Qwen2.5 7B Instruct',
    license: 'Apache 2.0',
    file: 'qwen2.5-7b-instruct-q4_k_m.gguf',
    // Pinned to a repository revision, so the URL always serves the same file.
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/8c2fd26a844d07c5b88ba9b1fd61989effec8593/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    sha256: '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423',
    approxBytes: 4.68 * GB,
    recommendedMemoryGB: 16,
    blurb: 'The model Quill started with (2024). Smaller than Gemma.',
  },
  light: {
    id: 'light',
    label: 'Qwen3 4B (light)',
    name: 'Qwen3 4B Instruct 2507',
    license: 'Apache 2.0',
    file: 'qwen3-4b-instruct-2507-q4_k_m.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/18727206c51467496bfba014368bd0a30e97f411/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
    approxBytes: 2.50 * GB,
    recommendedMemoryGB: 8,
    blurb: 'Faster and smaller. Good on 8 GB Macs and Intel Macs.',
  },
};

function recommendedModel() {
  const memoryGB = os.totalmem() / 1024 ** 3;
  if (process.arch !== 'arm64') return 'light'; // Intel Macs run models on the CPU only
  return memoryGB >= 15 ? 'gemma' : 'light';
}

class ModelStore extends EventEmitter {
  constructor(dir, fetchImpl) {
    super();
    this.dir = dir;
    this.fetch = fetchImpl;
    this.download = null; // { id, controller, received, total, startedAt, speed }
    fs.mkdirSync(dir, { recursive: true });
  }

  pathFor(id) {
    return path.join(this.dir, CATALOG[id].file);
  }

  isInstalled(id) {
    return !!CATALOG[id] && fs.existsSync(this.pathFor(id));
  }

  installed() {
    return Object.keys(CATALOG).filter((id) => this.isInstalled(id));
  }

  sizeOf(id) {
    try { return fs.statSync(this.pathFor(id)).size; } catch (_) { return 0; }
  }

  partialBytes(id) {
    try { return fs.statSync(this.pathFor(id) + '.part').size; } catch (_) { return 0; }
  }

  remove(id) {
    if (this.download && this.download.id === id) this.cancel();
    fs.rmSync(this.pathFor(id), { force: true });
    fs.rmSync(this.pathFor(id) + '.part', { force: true });
  }

  state() {
    const d = this.download;
    return {
      catalog: Object.values(CATALOG).map((m) => ({
        id: m.id, label: m.label, name: m.name, license: m.license, blurb: m.blurb,
        approxBytes: m.approxBytes, installed: this.isInstalled(m.id), partialBytes: this.partialBytes(m.id),
      })),
      recommended: recommendedModel(),
      memoryGB: Math.round(os.totalmem() / 1024 ** 3),
      download: d ? { id: d.id, received: d.received, total: d.total, speed: d.speed, phase: d.phase } : null,
    };
  }

  cancel() {
    if (this.download) this.download.controller.abort();
  }

  /** Download a model, resuming a previous partial download. Resolves with the file path. */
  async fetchModel(id) {
    const model = CATALOG[id];
    if (!model) throw new Error(`Unknown model ${id}`);
    if (this.isInstalled(id)) return this.pathFor(id);
    if (this.download) throw new Error('Another download is already running.');

    const finalPath = this.pathFor(id);
    const partPath = finalPath + '.part';
    const controller = new AbortController();
    const d = { id, controller, received: 0, total: model.approxBytes, startedAt: Date.now(), speed: 0, phase: 'downloading' };
    this.download = d;
    const emit = () => this.emit('progress', this.state());

    try {
      // Hash what is already on disk so the checksum covers the whole file.
      const hash = crypto.createHash('sha256');
      let offset = this.partialBytes(id);
      if (offset > 0) {
        d.phase = 'resuming';
        emit();
        await hashFile(partPath, hash);
      }

      await ensureFreeSpace(this.dir, model.approxBytes - offset);

      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
      const response = await this.fetch(model.url, { headers, signal: controller.signal, redirect: 'follow' });
      if (response.status === 200 && offset > 0) {
        // The server ignored the range request: start over.
        try { await response.body?.cancel(); } catch (_) { /* ignore */ }
        return this._restart(id);
      }
      if (!(response.status === 200 || response.status === 206)) {
        throw new Error(`The download server answered ${response.status}.`);
      }
      const length = Number(response.headers.get('content-length')) || 0;
      d.total = length ? offset + length : model.approxBytes;
      d.received = offset;
      d.phase = 'downloading';
      emit();

      const out = fs.createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' });
      const reader = response.body.getReader();
      let lastEmit = 0;
      let windowStart = Date.now();
      let windowBytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          d.received += chunk.length;
          windowBytes += chunk.length;
          const now = Date.now();
          if (now - windowStart >= 1000) {
            d.speed = windowBytes / ((now - windowStart) / 1000);
            windowStart = now;
            windowBytes = 0;
          }
          if (now - lastEmit > 250) { lastEmit = now; emit(); }
        }
      } finally {
        await new Promise((r) => out.end(r));
      }

      d.phase = 'verifying';
      emit();
      const digest = hash.digest('hex');
      if (digest !== model.sha256) {
        fs.rmSync(partPath, { force: true });
        const err = new Error('The downloaded file didn’t match its checksum, so Quill deleted it. Try again; if it keeps happening, Quill needs an update.');
        err.code = 'checksum';
        throw err;
      }
      fs.renameSync(partPath, finalPath);
      return finalPath;
    } catch (err) {
      if (controller.signal.aborted) {
        const e = new Error('Download paused. It continues where it stopped next time.');
        e.code = 'cancelled';
        throw e;
      }
      throw err;
    } finally {
      if (this.download === d) this.download = null;
      emit();
    }
  }

  async _restart(id) {
    fs.rmSync(this.pathFor(id) + '.part', { force: true });
    this.download = null;
    return this.fetchModel(id);
  }
}

function hashFile(file, hash) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
}

async function ensureFreeSpace(dir, bytesNeeded) {
  if (!fs.promises.statfs) return;
  try {
    const stats = await fs.promises.statfs(dir);
    const free = stats.bavail * stats.bsize;
    const margin = 1 * GB;
    if (free < bytesNeeded + margin) {
      const err = new Error(`Not enough free disk space. The model needs ${formatBytes(bytesNeeded + margin)} and ${formatBytes(free)} is free.`);
      err.code = 'disk';
      throw err;
    }
  } catch (err) {
    if (err.code === 'disk') throw err;
  }
}

function formatBytes(n) {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  return `${Math.round(n / 1e6)} MB`;
}

module.exports = { CATALOG, ModelStore, recommendedModel, formatBytes };
