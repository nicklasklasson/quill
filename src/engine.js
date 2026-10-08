// Runs the bundled llama.cpp server with the downloaded model, and talks to it.
//
// The server is started on demand, listens only on 127.0.0.1 on a random port, requires a random
// key that only this Quill process knows, runs with --offline so it never touches the network,
// and is stopped after a few idle minutes (and always when Quill quits) to give the memory back.

const { spawn } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');

const IDLE_STOP_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = 180 * 1000;
const CONTEXT = 8192;

function engineDir(app) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', 'llama', arch);
  return path.join(__dirname, '..', 'vendor', 'llama', arch);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

class Engine extends EventEmitter {
  constructor({ app, logDir }) {
    super();
    this.dir = engineDir(app);
    this.logFile = path.join(logDir, 'engine.log');
    this.child = null;
    this.modelPath = null;
    this.port = 0;
    this.key = '';
    this.state = 'stopped'; // stopped | starting | ready | error
    this.error = null;
    this.starting = null;
    this.idleTimer = null;
    this.busy = 0;
  }

  get available() {
    return fs.existsSync(path.join(this.dir, 'llama-server'));
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('state', { state, error });
  }

  /** Start the server for this model if it isn't already running with it. */
  async ensure(modelPath) {
    if (this.state === 'ready' && this.modelPath === modelPath && this.child) return;
    if (this.starting && this.modelPath === modelPath) return this.starting;
    if (this.child) await this.stop();
    this.modelPath = modelPath;
    this.starting = this._start(modelPath).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start(modelPath) {
    if (!this.available) {
      const err = new Error('The writing model engine is missing from this build.');
      this.setState('error', err.message);
      throw err;
    }
    this.setState('starting');
    this.port = await freePort();
    this.key = crypto.randomBytes(24).toString('hex');
    const args = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--api-key', this.key,
      '--offline',
      '--no-webui',
      '--no-slots',
      '-c', String(CONTEXT),
      '-np', '1',
      '-ngl', process.arch === 'arm64' ? 'all' : '0',
      '--reasoning', 'off',
    ];
    try { fs.mkdirSync(path.dirname(this.logFile), { recursive: true }); } catch (_) { /* ignore */ }
    const log = fs.openSync(this.logFile, 'w');
    const child = spawn(path.join(this.dir, 'llama-server'), args, {
      cwd: this.dir,
      stdio: ['ignore', log, log],
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '', TMPDIR: process.env.TMPDIR || '/tmp' }, // nothing else from our environment
    });
    fs.closeSync(log);
    this.child = child;

    let exited = false;
    child.on('exit', (code, signal) => {
      exited = true;
      if (this.child === child) {
        this.child = null;
        if (this.state !== 'stopped') {
          this.setState('error', `The writing model stopped unexpectedly (${signal || code}). Details are in ${this.logFile}.`);
        }
      }
    });
    child.on('error', (err) => {
      exited = true;
      if (this.child === child) this.child = null;
      this.setState('error', `Couldn't start the writing model: ${err.message}`);
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) throw new Error(this.error || 'The writing model failed to start.');
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          this.setState('ready');
          this.touch();
          return;
        }
      } catch (_) { /* still loading */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    await this.stop();
    const err = new Error('The writing model took too long to start.');
    this.setState('error', err.message);
    throw err;
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (this.busy === 0) this.stop(); }, IDLE_STOP_MS);
  }

  async stop() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    this.setState('stopped');
    if (!child) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  /** One chat completion. Returns the reply text. */
  async chat({ messages, temperature = 0.2, maxTokens = 1024, signal }) {
    if (this.state !== 'ready') throw new Error('The writing model isn’t running.');
    this.busy++;
    this.touch();
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({
          messages,
          temperature,
          top_p: 0.9,
          max_tokens: maxTokens,
          stream: false,
          cache_prompt: true,
        }),
        signal,
      });
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json()).error?.message || ''; } catch (_) { /* ignore */ }
        throw new Error(detail || `The writing model answered ${response.status}.`);
      }
      const data = await response.json();
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      this.busy--;
      this.touch();
    }
  }
}

module.exports = { Engine };
