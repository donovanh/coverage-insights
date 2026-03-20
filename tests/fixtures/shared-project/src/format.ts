export function formatResult(v: number): string {
  const prefix = '=';
  const value = String(v);
  const separator = ' ';
  return `${prefix}${separator}${value}`;
}
// formatError is intentionally never tested — used to assert uncoveredFunctions = 1
export function formatError(msg: string): string { return `Error: ${msg}`; }
