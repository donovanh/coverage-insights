import { add, subtract, multiply, divide, clamp } from '../../src/calc';
import { formatResult } from '../../src/format';

describe('calc', () => {
  it('adds numbers', () => {
    expect(add(1, 2)).toBe(3);
  });

  it('does basic arithmetic', () => {
    expect(add(1, 2)).toBe(3);
    expect(subtract(5, 3)).toBe(2);
    expect(multiply(4, 3)).toBe(12);
  });

  it('divides numbers', () => {
    expect(divide(6, 3)).toBe(2);
  });

  it('handles divide by zero', () => {
    expect(divide(6, 3)).toBe(2);
    expect(() => divide(1, 0)).toThrow('division by zero');
  });

  it('clamps values', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(0, 1, 10)).toBe(1);
    expect(clamp(15, 1, 10)).toBe(10);
  });
});

describe('format', () => {
  it('formats result', () => {
    expect(formatResult(42)).toBe('= 42');
  });
});
