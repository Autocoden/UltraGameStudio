/**
 * CONTRACT: scanFileRefs(text) -> Array<string | FileRef>
 *
 * Splits a run of prose into alternating plain-text strings and detected file
 * references, so a bare `Sidebar.tsx` or `app/src/store/useStore.ts:42` sitting
 * in ordinary text (not inside backticks or a markdown link) can be rendered as
 * a clickable chip.
 *
 * Detection scans for maximal runs of path-ish characters, including Unicode
 * letters for generated filenames such as `Moon亮晶分析.html`. Each run is
 * trimmed of trailing sentence
 * punctuation, then validated by {@link parseFileRef}, which stays strict (known
 * extension or a real separator) so prose like `2.0` or `react.useState` is
 * never matched. The colon introducing a `:line` suffix is preserved.
 */

import { parseFileRef, type FileRef } from './filePath';

export type FileScanPart = string | FileRef;

// A maximal run of path-ish characters. Whitespace, quotes, pipes, and most
// punctuation end the run; parseFileRef keeps false positives low.
const PATH_RUN = /[\p{L}\p{N}._~$@+%&\-/\\:#]+/gu;

// Trailing punctuation to peel off a token before validation (but NOT a digit
// after ':' — that is a line number). We only strip from the very end.
const TRAILING = /[.,;:!?]+$/;

// An absolute Windows path anchor embedded somewhere inside a run: a drive
// letter (`E:\` / `E:/`) or a UNC prefix (`\\`). Because PATH_RUN also matches
// Unicode letters, prose glued directly onto a pasted absolute path with no
// separating whitespace (`看这个图片E:\…\shot.png`) is swallowed into a single
// run whose embedded drive colon then defeats parseFileRef. When the whole run
// fails to parse we retry from the first such anchor and treat the preceding
// characters as plain prose. A drive letter is a single character, so the match
// index lands exactly on the path start regardless of what prose precedes it.
const EMBEDDED_ABS_ANCHOR = /[A-Za-z]:[\\/]|\\\\/;

/** Cheap whole-string gate: does the text contain any path-ish punctuation? */
function mightContainPath(text: string): boolean {
  return text.includes('.') || /[\\/]/.test(text);
}

/**
 * Split trailing sentence punctuation off a candidate token, leaving a `:NN`
 * line/column suffix intact. Returns the cleaned core plus the peeled tail.
 */
function stripTrailingPunctuation(token: string): { core: string; trailing: string } {
  if (/[:#]L?\d/.test(token)) return { core: token, trailing: '' };
  const tm = token.match(TRAILING);
  if (!tm) return { core: token, trailing: '' };
  return { core: token.slice(0, token.length - tm[0].length), trailing: tm[0] };
}

export function scanFileRefs(text: string): FileScanPart[] {
  if (!mightContainPath(text)) return [text];

  const out: FileScanPart[] = [];
  let cursor = 0;

  const pushText = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (typeof last === 'string') out[out.length - 1] = last + s;
    else out.push(s);
  };

  PATH_RUN.lastIndex = 0;
  for (let m = PATH_RUN.exec(text); m; m = PATH_RUN.exec(text)) {
    const run = m[0];
    let start = m.index;
    let core = run;

    // Prose glued onto an absolute path with no separating space lands the whole
    // thing in one run (`看这个图片E:\…\shot.png` or `图片E:\…\pasted-….png这样`).
    // An absolute anchor — a drive letter (`E:\`/`E:/`) or UNC prefix (`\\`) —
    // marks a path start that can't have valid path content before it. When one
    // appears mid-run we split there and emit the prefix as plain text. The
    // remainder may ALSO carry trailing prose glued after the extension (`…png这样`),
    // which poisons the extension check inside parseFileRef; so we progressively
    // trim trailing CJK/non-path chars from the candidate until it parses, and
    // emit whatever we trimmed as trailing plain text. Gating on a successful
    // parse keeps URLs (`https://…`, whose `s://` also matches the drive shape)
    // and other non-paths from being fragmented.
    const anchor = core.search(EMBEDDED_ABS_ANCHOR);
    if (anchor > 0) {
      const candidate = core.slice(anchor);
      // Walk the end of the candidate back over any trailing char that is not
      // a plausible path continuation. We must allow trailing `.: digits` for
      // line suffixes and backslashes for directory paths, so the stop set is
      // the inverse: CJK letters (which PATH_RUN happily swallows into the run)
      // plus obvious prose punctuation that can never be a filename character.
      // We deliberately keep this narrower than "non-ASCII" so legitimate
      // CJK basenames (`报告_v3.docx`) still parse in one shot.
      let end = candidate.length;
      while (end > 0) {
        const ch = candidate[end - 1];
        // CJK Unified Ideographs + extensions, Hiragana, Katakana, Hangul
        // syllables. PATH_RUN happily swallows these into a run, but they can
        // never appear in a Windows filename extension, so a run of them at
        // the tail is prose glued after the path. We deliberately do NOT
        // trim a broader "non-ASCII" set: legitimate CJK basenames such as
        // `报告_v3.docx` keep their CJK chars in the middle of the basename
        // and must still parse via the anchor split above.
        if (/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(ch)) {
          end--;
          continue;
        }
        break;
      }
      const pathCandidate = candidate.slice(0, end);
      const tailProse = candidate.slice(end);
      const parsed = parseFileRef(stripTrailingPunctuation(pathCandidate).core);
      if (parsed && pathCandidate.length > 1) {
        pushText(text.slice(cursor, start + anchor));
        cursor = start + anchor;
        start += anchor;
        // Push the parsed ref and any trailing prose we trimmed off. Advance
        // the cursor past the entire original slice so the outer loop does not
        // re-emit the tail.
        pushText(text.slice(cursor, start));
        out.push(parsed);
        if (tailProse) pushText(tailProse);
        cursor = start + candidate.length;
        continue;
      }
    }

    // Peel trailing sentence punctuation, but never strip a `:NN` line suffix.
    const peeled = stripTrailingPunctuation(core);
    core = peeled.core;
    const trailing = peeled.trailing;

    const ref = core.length > 1 ? parseFileRef(core) : null;
    if (ref) {
      pushText(text.slice(cursor, start));
      out.push(ref);
      if (trailing) pushText(trailing);
      cursor = start + core.length + trailing.length;
      continue;
    }

    // Space-containing paths (common for AI-generated documents such as
    // `UGS Game Analysis Report.md` or Chinese-named reports) break PATH_RUN at
    // the first space, leaving the absolute-path prefix unparsed and only the
    // last segment as a chip. When the current run ends at a space, try merging
    // subsequent space-separated PATH_RUN matches until parseFileRef succeeds,
    // so the whole path becomes one chip instead of a bare filename.
    const afterRun = start + run.length;
    if (
      core.length > 1 &&
      afterRun < text.length &&
      text[afterRun] === ' ' &&
      /[\\/]/.test(core) &&
      !ref
    ) {
      let mergedEnd = afterRun;
      let scanFrom = afterRun;
      let mergedOk = false;
      let attempts = 0;
      const MAX_MERGE_ATTEMPTS = 10;
      while (attempts < MAX_MERGE_ATTEMPTS && scanFrom < text.length) {
        if (text[scanFrom] !== ' ') break;
        // Look ahead for the next PATH_RUN match after this space
        PATH_RUN.lastIndex = scanFrom;
        const next = PATH_RUN.exec(text);
        if (!next) break;
        // If there's a gap between the space and the next match, stop merging
        if (next.index > scanFrom + 1) break;
        const merged = text.slice(start, next.index + next[0].length);
        mergedEnd = next.index + next[0].length;
        const mergedPeeled = stripTrailingPunctuation(merged);
        const mergedRef = parseFileRef(mergedPeeled.core, { allowSpaces: true });
        if (mergedRef) {
          pushText(text.slice(cursor, start));
          out.push(mergedRef);
          if (mergedPeeled.trailing) pushText(mergedPeeled.trailing);
          cursor = mergedEnd;
          mergedOk = true;
          break;
        }
        scanFrom = mergedEnd;
        attempts++;
      }
      // Continue the outer scan after the merged ref on success, or after the
      // original (failed) run so it stays in the pending plain-text span.
      // Never reuse `cursor` here — it may still point at a previous ref.
      PATH_RUN.lastIndex = mergedOk ? mergedEnd : afterRun;
      continue;
    }
    // No match: leave the run in the pending plain-text span (flushed below).
  }

  pushText(text.slice(cursor));

  // Collapse to the original string when nothing matched (lets callers skip the
  // chip path entirely).
  if (out.length === 0) return [text];
  if (out.length === 1 && typeof out[0] === 'string') return [text];
  return out;
}

/** True when the text contains at least one detectable file reference. */
export function hasFileRef(text: string): boolean {
  return scanFileRefs(text).some((p) => typeof p !== 'string');
}
