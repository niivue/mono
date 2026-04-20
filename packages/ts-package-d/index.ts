export function greet(name: string): string {
  if (!name?.trim()) {
    return "Hello, world!";
  }
  return `Hello, ${name.trim()}!`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error("Cannot divide by zero");
  }
  return a / b;
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new Error("min must be less than or equal to max");
  }
  return Math.min(Math.max(value, min), max);
}
