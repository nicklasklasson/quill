// Turns the writing model's corrected version of a text into individual suggestions
// ("wit → with"), shown in the same list as Harper's.
//
// All positions are in Unicode code points (Array.from(text) indices), the same units Harper uses,
// so both kinds of suggestion are applied by the same code.

const MAX_CHANGE_RATIO = 0.45; // more changed than this isn't "fixing", so ignore it
const MAX_SUGGESTIONS = 15;

function tokenize(text) {
  const tokens = text.match(/\s+|[\p{L}\p{N}’'_-]+|[^\s\p{L}\p{N}]/gu) || [];
  let pos = 0;
  return tokens.map((t) => {
    const len = Array.from(t).length;
    const token = { text: t, start: pos, end: pos + len, space: /^\s+$/.test(t) };
    pos += len;
    return token;
  });
}

/** Word-level diff: returns hunks {aStart, aEnd, bStart, bEnd} in token indices. */
function diffTokens(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i].text === b[j].text ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  let open = null;
  const close = () => { if (open) { open.aEnd = i; open.bEnd = j; hunks.push(open); open = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i].text === b[j].text) {
      close();
      i++; j++;
    } else {
      if (!open) open = { aStart: i, bStart: j };
      if (j >= m || (i < n && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) i++;
      else j++;
    }
  }
  close();
  return { hunks, common: dp[0] };
}

/** Compare the original with the model's version and produce suggestions. */
function suggestionsFromRewrite(original, corrected) {
  if (!corrected || corrected === original) return [];
  const a = tokenize(original);
  const b = tokenize(corrected);
  const result = diffTokens(a, b);
  if (!result) return [];
  const words = a.filter((t) => !t.space).length || 1;
  const changedWords = result.hunks.reduce((sum, h) => sum + a.slice(h.aStart, h.aEnd).filter((t) => !t.space).length, 0);
  if (words >= 6 && changedWords / words > MAX_CHANGE_RATIO) return [];

  const issues = [];
  for (const h of result.hunks) {
    let { aStart, aEnd, bStart, bEnd } = h;
    const onlySpace = (toks) => toks.every((t) => t.space);
    // Ignore changes that only touch whitespace.
    if (onlySpace(a.slice(aStart, aEnd)) && onlySpace(b.slice(bStart, bEnd))) continue;
    // Insertions and deletions are shown together with the neighbouring word, so the suggestion
    // reads "it → it," instead of an invisible "→ ,".
    const needsAnchor = (aEnd - aStart === 0) || onlySpace(a.slice(aStart, aEnd)) || (bEnd - bStart === 0) || onlySpace(b.slice(bStart, bEnd));
    if (needsAnchor) {
      // Extend left to the previous word (and the whitespace between), else right to the next one.
      let k = aStart - 1;
      while (k >= 0 && a[k].space) k--;
      if (k >= 0) {
        const steps = aStart - k;
        aStart -= steps; bStart -= steps;
      } else {
        let k2 = aEnd;
        while (k2 < a.length && a[k2].space) k2++;
        if (k2 < a.length) {
          const steps = k2 - aEnd + 1;
          aEnd += steps; bEnd += steps;
        }
      }
    }
    if (aStart < 0 || bStart < 0) continue;
    // Drop identical whitespace at either end, so "a a " → "a " shows as "a a" → "a".
    while (aEnd > aStart && bEnd > bStart && a[aEnd - 1].space && b[bEnd - 1].space && a[aEnd - 1].text === b[bEnd - 1].text) { aEnd--; bEnd--; }
    while (aEnd > aStart && bEnd > bStart && a[aStart].space && b[bStart].space && a[aStart].text === b[bStart].text) { aStart++; bStart++; }
    const start = aStart < a.length ? a[aStart].start : (a.length ? a[a.length - 1].end : 0);
    const end = aEnd > aStart ? a[aEnd - 1].end : start;
    const problem = a.slice(aStart, aEnd).map((t) => t.text).join('');
    const replacement = b.slice(bStart, bEnd).map((t) => t.text).join('');
    if (problem === replacement) continue;
    issues.push({
      kind: 'Model',
      kindLabel: 'Writing model',
      message: 'Suggested by the writing model',
      problem,
      start,
      end,
      suggestions: [{ kind: 'replace', text: replacement }],
    });
  }
  // Merge suggestions that touch or overlap after anchoring.
  issues.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const issue of issues) {
    const last = merged[merged.length - 1];
    if (last && issue.start < last.end) continue;
    merged.push(issue);
  }
  return merged.slice(0, MAX_SUGGESTIONS);
}

/**
 * Keep suggestions valid while the text changes: anything before the edited region stays,
 * anything after shifts, anything overlapping it is dropped. Positions in code points.
 */
function rebase(oldText, newText, issues) {
  if (oldText === newText || issues.length === 0) return issues;
  const a = Array.from(oldText);
  const b = Array.from(newText);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const editStart = prefix;
  const editEndOld = a.length - suffix;
  const delta = b.length - a.length;
  const out = [];
  for (const issue of issues) {
    if (issue.end <= editStart) out.push(issue);
    else if (issue.start >= editEndOld) out.push({ ...issue, start: issue.start + delta, end: issue.end + delta });
  }
  return out;
}

function overlaps(x, y) {
  if (x.start === x.end || y.start === y.end) return x.start >= y.start && x.start <= y.end;
  return x.start < y.end && y.start < x.end;
}

module.exports = { suggestionsFromRewrite, rebase, overlaps, tokenize };
