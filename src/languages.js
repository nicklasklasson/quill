// English and Swedish in the same text: decide each sentence's language, check Swedish spelling
// with macOS's own spell checker, and accept words that are right in the other language
// ("merchant" in a Swedish sentence, "Hej" in an English one).
//
// Harper (English) positions are Unicode code points; macOS reports UTF-16 positions. Everything
// here is converted to code points, so all suggestions share one coordinate system.

const SPELLING_KINDS = new Set(['Spelling', 'Typo']);
const WORD_RE = /\p{L}[\p{L}\p{N}’'-]*/u;

/** Positions in UTF-16 → code points. */
function utf16ToCodePoints(text) {
  const map = new Array(text.length + 1);
  let cp = 0;
  for (let i = 0; i < text.length; i++) {
    map[i] = cp;
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { map[i + 1] = cp; i++; }
    cp++;
  }
  map[text.length] = cp;
  return map;
}

/** Sentences, also split at line breaks (chat messages often have no full stops), in code points. */
function segments(text) {
  const map = utf16ToCodePoints(text);
  const out = [];
  const segmenter = new Intl.Segmenter('sv', { granularity: 'sentence' });
  for (const { segment, index } of segmenter.segment(text)) {
    let offset = 0;
    for (const line of segment.split('\n')) {
      const start = index + offset;
      offset += line.length + 1;
      if (!/\p{L}/u.test(line)) continue;
      out.push({ text: line, start: map[start], end: map[start + line.length], words: (line.match(/\p{L}+/gu) || []).length });
    }
  }
  return out;
}

/**
 * The language of each sentence: 'sv', 'en', or 'unknown' when a sentence is too short or too
 * close to call (then a word only counts as wrong if it's wrong in both languages).
 */
function classify(segment, scores) {
  const sv = scores.sv || 0;
  const en = scores.en || 0;
  const margin = Math.abs(sv - en);
  const sure = segment.words >= 4 ? margin > 0.3 : segment.words >= 2 ? margin > 0.6 : margin > 0.9;
  if (!sure) return 'unknown';
  return sv > en ? 'sv' : 'en';
}

class Languages {
  constructor(ax) {
    this.ax = ax;
    this.detectCache = new Map();
    this.validCache = new Map();
    this.swedishAvailable = null;
  }

  remember(cache, key, value) {
    if (cache.size > 5000) cache.clear();
    cache.set(key, value);
  }

  async detect(segs) {
    const missing = segs.filter((s) => !this.detectCache.has(s.text));
    if (missing.length) {
      const reply = await this.ax.langs(missing.map((s) => s.text));
      (reply.results || []).forEach((scores, i) => this.remember(this.detectCache, missing[i].text, scores));
    }
    return segs.map((s) => ({ ...s, lang: classify(s, this.detectCache.get(s.text) || {}) }));
  }

  /** Which of these words are spelled correctly in a language (cached). */
  async validWords(words, language) {
    const unique = [...new Set(words)];
    const missing = unique.filter((w) => !this.validCache.has(`${language}:${w}`));
    if (missing.length) {
      const reply = await this.ax.valid(missing, language);
      (reply.valid || []).forEach((ok, i) => this.remember(this.validCache, `${language}:${missing[i]}`, !!ok));
    }
    return new Set(unique.filter((w) => this.validCache.get(`${language}:${w}`)));
  }

  /**
   * Combine Harper's English issues with Swedish spelling.
   *   override: 'auto' | 'en' | 'sv' (the language chosen for this field in the panel)
   *   dictionary: words that are always right
   * Returns { issues, summary } where summary is 'en', 'sv', 'mixed' or null (no text).
   */
  async check(text, harperIssues, { override = 'auto', dictionary = [], swedish = true } = {}) {
    if (!swedish || !text.trim()) return { issues: harperIssues, summary: text.trim() ? 'en' : null, segments: [] };
    let segs = segments(text);
    if (override === 'en' || override === 'sv') segs = segs.map((s) => ({ ...s, lang: override }));
    else segs = await this.detect(segs);
    const langAt = (pos) => (segs.find((s) => pos >= s.start && pos < s.end) || { lang: override === 'sv' ? 'sv' : 'en' }).lang;
    const known = new Set(dictionary.map((w) => w.toLowerCase()));
    const isWord = (w) => WORD_RE.test(w) && !/\s/.test(w.trim());

    // 1. Harper (English): nothing in Swedish sentences; in uncertain ones only spelling, and only
    //    for words that aren't Swedish either; in English ones, accept Swedish words.
    const spellingCandidates = harperIssues.filter((i) => SPELLING_KINDS.has(i.kind) && isWord(i.problem)).map((i) => i.problem.trim());
    const validSv = spellingCandidates.length ? await this.validWords(spellingCandidates, 'sv') : new Set();
    const english = harperIssues.filter((issue) => {
      const lang = langAt(issue.start);
      if (lang === 'sv') return false;
      const spelling = SPELLING_KINDS.has(issue.kind);
      if (lang === 'unknown' && !spelling) return false;
      if (spelling && validSv.has(issue.problem.trim())) return false;
      return true;
    });

    // 2. Swedish spelling, for Swedish and uncertain sentences, accepting English words.
    let swedishIssues = [];
    if (segs.some((s) => s.lang === 'sv' || s.lang === 'unknown')) {
      const reply = await this.ax.spell(text, 'sv');
      this.swedishAvailable = !!reply.available;
      const map = utf16ToCodePoints(text);
      const found = (reply.issues || []).map((m) => ({
        start: map[m.start], end: map[m.start + m.length], word: m.word, guesses: m.guesses || [],
      })).filter((m) => {
        const lang = langAt(m.start);
        return (lang === 'sv' || lang === 'unknown') && !known.has(m.word.toLowerCase());
      });
      const validEn = found.length ? await this.validWords(found.map((m) => m.word), 'en') : new Set();
      swedishIssues = found.filter((m) => !validEn.has(m.word)).map((m) => ({
        kind: 'Spelling',
        kindLabel: 'Swedish spelling',
        message: m.guesses.length ? 'Possible misspelling (Swedish)' : 'Not in the Swedish dictionary',
        problem: m.word,
        start: m.start,
        end: m.end,
        suggestions: m.guesses.slice(0, 4).map((g) => ({ kind: 'replace', text: g })),
        language: 'sv',
      }));
    }

    const counted = segs.filter((s) => s.lang !== 'unknown' && s.words >= 2);
    const langs = new Set(counted.map((s) => s.lang));
    const summary = override !== 'auto' ? override : langs.size > 1 ? 'mixed' : langs.has('sv') ? 'sv' : 'en';
    return {
      issues: [...english, ...swedishIssues].sort((a, b) => a.start - b.start),
      summary,
      segments: segs.map(({ start, end, lang, words }) => ({ start, end, lang, words })),
    };
  }
}

module.exports = { Languages, segments, classify, utf16ToCodePoints };
