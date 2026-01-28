import { describe, it, expect } from 'vitest';
import { parseDigitFromText } from './digitParsing.js';

describe('parseDigitFromText', () => {
  describe('direct digit recognition', () => {
    it('should parse single digits 1-9', () => {
      expect(parseDigitFromText('1')).toBe(1);
      expect(parseDigitFromText('2')).toBe(2);
      expect(parseDigitFromText('3')).toBe(3);
      expect(parseDigitFromText('4')).toBe(4);
      expect(parseDigitFromText('5')).toBe(5);
      expect(parseDigitFromText('6')).toBe(6);
      expect(parseDigitFromText('7')).toBe(7);
      expect(parseDigitFromText('8')).toBe(8);
      expect(parseDigitFromText('9')).toBe(9);
    });

    it('should handle whitespace around digits', () => {
      expect(parseDigitFromText('  5  ')).toBe(5);
      expect(parseDigitFromText('\n3\n')).toBe(3);
      expect(parseDigitFromText('\t7\t')).toBe(7);
    });

    it('should extract digit from mixed text', () => {
      expect(parseDigitFromText('abc5def')).toBe(5);
      expect(parseDigitFromText('--3--')).toBe(3);
    });
  });

  describe('OCR corrections for 1', () => {
    it('should correct "l" to 1', () => {
      expect(parseDigitFromText('l')).toBe(1);
    });

    it('should correct "I" to 1', () => {
      expect(parseDigitFromText('I')).toBe(1);
    });

    it('should correct "|" to 1', () => {
      expect(parseDigitFromText('|')).toBe(1);
    });

    it('should correct "i" to 1', () => {
      expect(parseDigitFromText('i')).toBe(1);
    });

    it('should correct "!" to 1', () => {
      expect(parseDigitFromText('!')).toBe(1);
    });
  });

  describe('OCR corrections for 2', () => {
    it('should correct "Z" to 2', () => {
      expect(parseDigitFromText('Z')).toBe(2);
    });

    it('should correct "z" to 2', () => {
      expect(parseDigitFromText('z')).toBe(2);
    });
  });

  describe('OCR corrections for 3', () => {
    it('should correct "E" to 3', () => {
      expect(parseDigitFromText('E')).toBe(3);
    });
  });

  describe('OCR corrections for 4', () => {
    it('should correct "A" to 4', () => {
      expect(parseDigitFromText('A')).toBe(4);
    });

    it('should correct "h" to 4', () => {
      expect(parseDigitFromText('h')).toBe(4);
    });
  });

  describe('OCR corrections for 5', () => {
    it('should correct "S" to 5', () => {
      expect(parseDigitFromText('S')).toBe(5);
    });

    it('should correct "s" to 5', () => {
      expect(parseDigitFromText('s')).toBe(5);
    });
  });

  describe('OCR corrections for 6', () => {
    it('should correct "G" to 6', () => {
      expect(parseDigitFromText('G')).toBe(6);
    });

    it('should correct "b" to 6', () => {
      expect(parseDigitFromText('b')).toBe(6);
    });
  });

  describe('OCR corrections for 7', () => {
    it('should correct "T" to 7', () => {
      expect(parseDigitFromText('T')).toBe(7);
    });

    it('should correct "/" to 7', () => {
      expect(parseDigitFromText('/')).toBe(7);
    });

    it('should correct "?" to 7', () => {
      expect(parseDigitFromText('?')).toBe(7);
    });

    it('should correct ")" to 7', () => {
      expect(parseDigitFromText(')')).toBe(7);
    });

    it('should correct "]" to 7', () => {
      expect(parseDigitFromText(']')).toBe(7);
    });

    it('should correct "J" to 7', () => {
      expect(parseDigitFromText('J')).toBe(7);
    });

    it('should correct "j" to 7', () => {
      expect(parseDigitFromText('j')).toBe(7);
    });
  });

  describe('OCR corrections for 8', () => {
    it('should correct "B" to 8', () => {
      expect(parseDigitFromText('B')).toBe(8);
    });
  });

  describe('OCR corrections for 9', () => {
    it('should correct "g" to 9', () => {
      expect(parseDigitFromText('g')).toBe(9);
    });

    it('should correct "q" to 9', () => {
      expect(parseDigitFromText('q')).toBe(9);
    });

    it('should correct "0" to 9', () => {
      expect(parseDigitFromText('0')).toBe(9);
    });

    it('should correct "O" to 9', () => {
      expect(parseDigitFromText('O')).toBe(9);
    });

    it('should correct "o" to 9', () => {
      expect(parseDigitFromText('o')).toBe(9);
    });
  });

  describe('edge cases', () => {
    it('should return null for empty string', () => {
      expect(parseDigitFromText('')).toBe(null);
    });

    it('should return null for whitespace only', () => {
      expect(parseDigitFromText('   ')).toBe(null);
    });

    it('should return null for unrecognized characters', () => {
      expect(parseDigitFromText('@#$%^&*()')).toBe(7); // ')' is corrected to 7
      expect(parseDigitFromText('@#$%^&*(')).toBe(null);
    });

    it('should prefer actual digits over corrections', () => {
      // If text contains a real digit, it should be found first
      expect(parseDigitFromText('l5')).toBe(5);
      expect(parseDigitFromText('5l')).toBe(5);
    });
  });
});
