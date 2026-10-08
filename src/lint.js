// Grammar and spelling checks, powered by Harper (https://writewithharper.com).
// Harper runs as WebAssembly inside this process. It never makes a network request.

const DIALECTS = { american: 0, british: 1, australian: 2, canadian: 3, indian: 4 };
const MAX_CHARS = 20000;

class Checker {
  constructor() {
    this.linter = null;
    this.dialect = 'american';
    this.loading = null;
    this.words = [];
    this.loadedWords = [];
  }

  /**
   * Words Harper should accept. Harper can add words but not remove them, so removing a word
   * reloads the checker (a second or two).
   */
  async setWords(words) {
    this.words = expandWords(words);
    if (!this.linter) return;
    const removed = this.loadedWords.some((w) => !this.words.includes(w));
    if (removed) {
      await this.load(this.dialect, true);
      return;
    }
    const added = this.words.filter((w) => !this.loadedWords.includes(w));
    if (added.length) {
      await this.linter.importWords(added);
      this.loadedWords = [...this.loadedWords, ...added];
    }
  }

  async load(dialect = 'american', force = false) {
    if (!force && this.linter && this.dialect === dialect) return;
    if (this.loading) await this.loading;
    if (!force && this.linter && this.dialect === dialect) return;
    this.loading = (async () => {
      // harper.js is an ES module; this file is CommonJS, so it is loaded with import().
      const { LocalLinter, Dialect } = await import('harper.js');
      const { binary } = await import('harper.js/binary');
      const linter = new LocalLinter({ binary, dialect: Dialect[capitalize(dialect)] ?? DIALECTS.american });
      await linter.setup();
      if (this.words.length) await linter.importWords(this.words);
      if (this.linter) this.linter.dispose?.();
      this.linter = linter;
      this.dialect = dialect;
      this.loadedWords = [...this.words];
    })();
    try { await this.loading; } finally { this.loading = null; }
  }

  /**
   * Check text and return plain objects the renderer can show.
   * Spans are indices into Array.from(text) (Unicode code points), matching what Harper reports.
   */
  async check(text, options = {}) {
    if (!this.linter) await this.load(this.dialect);
    if (!text || !text.trim()) return { issues: [], truncated: false };
    if (text.length > MAX_CHARS) return { issues: [], truncated: true };
    const lints = await this.linter.lint(text, {
      language: 'plaintext',
      isolateEnglish: !!options.isolateEnglish,
      dedup: true,
    });
    const issues = lints.map((lint, index) => {
      const span = lint.span();
      const suggestions = lint.suggestions().map((s) => {
        const out = {
          kind: s.kind() === 1 ? 'remove' : s.kind() === 2 ? 'insertAfter' : 'replace',
          text: s.get_replacement_text(),
        };
        s.free?.();
        return out;
      });
      const issue = {
        id: index,
        kind: lint.lint_kind(),
        kindLabel: lint.lint_kind_pretty(),
        message: lint.message(),
        problem: lint.get_problem_text(),
        start: span.start,
        end: span.end,
        suggestions,
      };
      span.free?.();
      lint.free?.();
      return issue;
    });
    issues.sort((a, b) => a.start - b.start);
    return { issues, truncated: false };
  }
}

/** Apply one suggestion to text. Returns the new text and the caret position after the change. */
function applySuggestion(text, issue, suggestion) {
  const chars = Array.from(text);
  const before = chars.slice(0, issue.start).join('');
  const problem = chars.slice(issue.start, issue.end).join('');
  const after = chars.slice(issue.end).join('');
  let replacement;
  if (suggestion.kind === 'remove') replacement = '';
  else if (suggestion.kind === 'insertAfter') replacement = problem + suggestion.text;
  else replacement = suggestion.text;
  const newText = before + replacement + after;
  return { text: newText, caret: (before + replacement).length };
}

/**
 * Harper splits words at digits ("3DS" becomes "3" and "DS"), so a dictionary word like "3DS"
 * also needs its letter parts.
 */
function expandWords(words) {
  const out = new Set();
  for (const w of words) {
    if (!w) continue;
    out.add(w);
    if (/\d/.test(w)) for (const part of w.match(/\p{L}{2,}/gu) || []) out.add(part);
  }
  return Array.from(out);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { Checker, applySuggestion, DIALECTS, expandWords };
