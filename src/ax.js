// Talks to the native Accessibility helper (native/QuillAX.swift) over stdin/stdout.
// See the comment at the top of that file for the protocol.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

class AXClient extends EventEmitter {
  constructor(helperPath) {
    super();
    this.helperPath = helperPath;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.trusted = false;
  }

  get available() {
    return fs.existsSync(this.helperPath);
  }

  start() {
    if (this.child) return;
    if (!this.available) {
      this.emit('status', { ok: false, reason: 'missing' });
      return;
    }
    const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.onLine(line));
    child.stderr.on('data', (data) => console.warn('[quill-ax]', String(data).trim()));
    child.on('exit', (code) => {
      console.warn('[quill-ax] exited', code);
      this.child = null;
      this.ready = false;
      for (const [, entry] of this.pending) entry.reject(new Error('helper exited'));
      this.pending.clear();
      this.emit('status', { ok: false, reason: 'exited' });
    });
    child.on('error', (err) => {
      console.warn('[quill-ax] failed to start', err);
      this.child = null;
      this.emit('status', { ok: false, reason: 'spawn-failed', detail: String(err) });
    });
  }

  stop() {
    if (!this.child) return;
    try { this.send('quit'); } catch (_) { /* ignore */ }
    const child = this.child;
    setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, 200);
    this.child = null;
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch (_) { return; }
    if (message.event) {
      if (message.event === 'ready' || message.event === 'trusted') {
        this.ready = true;
        this.trusted = !!message.trusted;
        this.emit('status', { ok: true, trusted: this.trusted });
      }
      this.emit('event', message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (entry) {
      this.pending.delete(message.id);
      entry.resolve(message);
    }
  }

  send(op, params = {}, timeoutMs = 4000) {
    if (!this.child) return Promise.reject(new Error('helper not running'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, op, ...params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper timed out on ${op}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.child.stdin.write(payload);
    });
  }

  async isTrusted() {
    const result = await this.send('trusted');
    this.trusted = !!result.trusted;
    return this.trusted;
  }

  config(excluded) { return this.send('config', { excluded }); }
  focus(ignoreExclusions = false) { return this.send('focus', { ignoreExclusions }); }
  watch(handle) { return this.send('watch', { handle }); }
  unwatch() { return this.send('unwatch'); }
  setText(handle, text, caret) { return this.send('set', { handle, text, caret }); }
  activate(pid) { return this.send('activate', { pid }); }
  keys(pid, combos) { return this.send('keys', { pid, combos }); }
}

function helperPath(app) {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', 'quill-ax');
  return path.join(__dirname, '..', 'native', 'quill-ax');
}

module.exports = { AXClient, helperPath };
