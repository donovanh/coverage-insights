export function add(a: number, b: number): number { return a + b; }
export function subtract(a: number, b: number): number { return a - b; }
export function multiply(a: number, b: number): number { return a * b; }
export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error('division by zero');
  }
  return a / b;
}
export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
