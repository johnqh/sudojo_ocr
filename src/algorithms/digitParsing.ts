/**
 * Digit parsing utilities for OCR text correction
 */

/** Common OCR character corrections */
const CORRECTIONS: Record<string, number> = {
  l: 1,
  I: 1,
  '|': 1,
  i: 1,
  '!': 1,
  Z: 2,
  z: 2,
  E: 3,
  A: 4,
  h: 4,
  S: 5,
  s: 5,
  G: 6,
  b: 6,
  T: 7,
  '/': 7,
  '?': 7,
  ')': 7,
  ']': 7,
  J: 7,
  j: 7,
  B: 8,
  g: 9,
  q: 9,
  // "0" from OCR is likely 9 with unrecognized tail
  '0': 9,
  O: 9,
  o: 9,
};

/**
 * Parse a Sudoku digit (1-9) from OCR-recognized text.
 * Attempts three strategies: (1) direct single-digit match, (2) find any digit
 * in the text, (3) apply common OCR character corrections (e.g., 'l'->1, 'O'->9).
 * @param text - Raw OCR text output for a single cell
 * @returns The recognized digit (1-9), or null if no valid digit found
 */
export function parseDigitFromText(text: string): number | null {
  const cleanText = text.trim();

  // Direct single digit match
  if (cleanText.length === 1 && /[1-9]/.test(cleanText)) {
    return parseInt(cleanText, 10);
  }

  // Look for any digit in the text
  const match = cleanText.match(/[1-9]/);
  if (match) {
    return parseInt(match[0], 10);
  }

  // Apply corrections
  for (const char of cleanText) {
    const corrected = CORRECTIONS[char];
    if (corrected !== undefined) {
      return corrected;
    }
  }

  return null;
}
