// Define levels as const for TypeScript to infer literal types
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
  silent: Infinity,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

class Log {
  level: LogLevel;
  name: string;
  constructor({
    name = "niivue",
    level = "info",
  }: { name?: string; level?: LogLevel } = {}) {
    this.name = `${name}`;
    this.level = level;
  }

  static levels = LOG_LEVELS;

  debug(...args: unknown[]): void {
    if (Log.levels[this.level] > Log.levels.debug) {
      return;
    }

    console.debug(`${this.name}-debug`, ...args);
  }

  info(...args: unknown[]): void {
    if (Log.levels[this.level] > Log.levels.info) {
      return;
    }

    console.info(`${this.name}-info`, ...args);
  }

  warn(...args: unknown[]): void {
    if (Log.levels[this.level] > Log.levels.warn) {
      return;
    }

    console.warn(`${this.name}-warn`, ...args);
  }

  error(...args: unknown[]): void {
    if (Log.levels[this.level] > Log.levels.error) {
      return;
    }

    console.error(`${this.name}-error`, ...args);
  }

  fatal(...args: unknown[]): void {
    if (Log.levels[this.level] > Log.levels.fatal) {
      return;
    }

    console.error(`${this.name}-fatal`, ...args);
  }

  setLogLevel(level: LogLevel): void {
    this.level = level;
  }

  setName(name: string): void {
    this.name = name;
  }
}

// make a log instance and export it
const log = new Log({ name: "niivue", level: "info" });

export { log };
