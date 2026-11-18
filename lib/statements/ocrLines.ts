/**
 * OCR words → statement lines (pure, no I/O), for scanned bank statements.
 *
 * Tesseract's own text output follows its layout blocks, and on a statement table it often puts
 * each COLUMN in a block of its own (all the dates, then all the descriptions, then the amounts),
 * which leaves no transaction rows to read. Its word boxes are reliable, so the rows are rebuilt
 * here from them: words are chained left to right into a line when they sit at the same height
 * (each word compared with the line's last word, so a slightly crooked scan still holds a row
 * together), and every word keeps its x position — the statement parser then knows which words
 * sit under "Withdrawals" and which under "Deposits", exactly as with a PDF's text layer.
 *
 * fixOcrMoney repairs the misreads OCR makes in amounts ("S5,000.00", "1,2O0.00", "5, 000.00",
 * "42 .10") so they parse as money; text that isn't an amount is left alone.
 */
import type { StatementLine } from './parse';

export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Building {
  words: OcrWord[];
  /** Vertical centre and height of the line's last word. */
  cy: number;
  h: number;
}

/** Rows of a scanned page, top to bottom, each with its words' x positions. */
export function wordsToLines(words: OcrWord[]): StatementLine[] {
  const clean = words
    .map((w) => ({ ...w, text: w.text.trim() }))
    .filter((w) => w.text && w.x1 > w.x0 && w.y1 > w.y0);
  if (clean.length === 0) return [];
  const heights = clean.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)];
  const lines: Building[] = [];
  for (const w of [...clean].sort((a, b) => a.x0 - b.x0)) {
    const cy = (w.y0 + w.y1) / 2;
    const h = w.y1 - w.y0;
    let best: Building | null = null;
    let bestDy = Infinity;
    for (const l of lines) {
      const last = l.words[l.words.length - 1];
      if (last.x0 >= w.x0) continue; // words are added left to right
      const dy = Math.abs(l.cy - cy);
      // Half a word's height, plus a little per pixel of gap: a crooked scan (up to ~0.7°) drifts
      // across the wide gap between a description and its amount.
      const gap = Math.max(0, w.x0 - last.x1);
      const tol = Math.max(4, Math.min(l.h, h, medianH * 1.5) * 0.5 + gap * 0.012);
      if (dy <= tol && dy < bestDy) {
        best = l;
        bestDy = dy;
      }
    }
    if (best) {
      best.words.push(w);
      best.cy = cy;
      best.h = h;
    } else lines.push({ words: [w], cy, h });
  }
  return lines
    .map((l) => ({ l, top: Math.min(...l.words.map((w) => w.y0)) }))
    .sort((a, b) => a.top - b.top)
    .map(({ l }) => {
      const cells = l.words.map((w) => ({ x: w.x0, str: fixOcrMoney(w.text) }));
      return { text: fixOcrMoney(cells.map((c) => c.str).join(' ')), cells };
    });
}

/** Characters OCR confuses with digits, inside something that is otherwise an amount. */
const DIGITISH: Record<string, string> = { O: '0', o: '0', D: '0', Q: '0', l: '1', I: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };

/** Repair OCR misreads in the amounts of a line of statement text. */
export function fixOcrMoney(text: string): string {
  let t = text
    // "5, 000.00" / "5 ,000.00" → "5,000.00";  "42 .10" / "42. 10" → "42.10"
    // (only before the cents, so "October 1, 2026" keeps its comma and space)
    .replace(/(\d) ?, ?(\d{3})(?=[.,]\d)/g, '$1,$2')
    .replace(/(\d) ?\. ?(\d{2})(?=\D|$)/g, '$1.$2')
    // "$ 1,234.56" → "$1,234.56"
    .replace(/\$\s+(?=\d)/g, '$');
  // Token by token: a word that is an amount apart from a few look-alike letters.
  t = t.replace(/[^\s]+/g, (tok) => {
    const m = /^([(\-+]?)([$S]?)([0-9OoDQlI|iSsBZz,]*[0-9][0-9OoDQlI|iSsBZz,]*[.,][0-9OoDQlI|iSsBZz]{2})([)\-]?|CR|DR)?$/.exec(tok);
    if (!m) return tok;
    const [, pre, cur, body, post = ''] = m;
    // A leading "S" before the digits is a misread "$".
    const dollar = cur ? '$' : '';
    let num = body.replace(/[OoDQlI|iSsBZz]/g, (c) => DIGITISH[c] ?? c);
    // The decimal point read as a comma: "42,10" (2 digits after the last comma) → "42.10".
    num = num.replace(/,(\d{2})$/, '.$1');
    if (!/^\d{1,3}(,\d{3})*\.\d{2}$|^\d+\.\d{2}$/.test(num)) return tok;
    return `${pre}${dollar}${num}${post}`;
  });
  return t;
}
