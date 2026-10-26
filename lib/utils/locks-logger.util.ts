import { LOG_LEVELS, Logger, type LogLevel } from '@nestjs/common';

const LEVEL_RANK = Object.fromEntries(LOG_LEVELS.map((level, index) => [level, index])) as Record<
  LogLevel,
  number
>;

/**
 * Nest's cascade: a listed level is on, and so is every more severe one. `['warn']` keeps
 * warn, error and fatal; `['debug', 'error']` keeps debug, error and fatal, not log or warn.
 */
function isLevelEnabled(target: LogLevel, levels: LogLevel[]): boolean {
  if (levels.length === 0) {
    return false;
  }
  if (levels.includes(target)) {
    return true;
  }

  let highest = -Infinity;
  for (const level of levels) {
    const rank = LEVEL_RANK[level];
    if (rank > highest) {
      highest = rank;
    }
  }

  return LEVEL_RANK[target] >= highest;
}

/** `false`, or the levels Nest knows, from a `LocksModule` `logger` option. */
export function resolveLoggerOption(option: unknown): false | LogLevel[] | undefined {
  if (option === undefined) {
    return undefined;
  }
  if (option === false) {
    return false;
  }
  if (!Array.isArray(option)) {
    throw new TypeError(
      `LocksModule: \`logger\` must be false or an array of log levels (${LOG_LEVELS.join(', ')}), ` +
        `got ${typeof option === 'string' ? JSON.stringify(option) : typeof option}`,
    );
  }

  const unknown = option.filter((level) => !(LOG_LEVELS as readonly string[]).includes(level as string));
  if (unknown.length > 0) {
    throw new TypeError(
      `LocksModule: \`logger\` has unknown level${unknown.length === 1 ? '' : 's'} ` +
        `${unknown.map((level) => JSON.stringify(level)).join(', ')}; use ${LOG_LEVELS.join(', ')}`,
    );
  }

  return option as LogLevel[];
}

/**
 * Nest's `Logger` for this package. With no option, it follows the application logger. With
 * `false` or a level list, those levels are filtered first (same cascade as
 * `NestFactory.create({ logger })`); the application logger still applies on top.
 */
export function locksLogger(context: string, option?: unknown): Logger {
  const levels = resolveLoggerOption(option);
  if (levels === undefined) {
    return new Logger(context);
  }

  return new LevelFilteredLogger(context, levels);
}

/** Drops messages outside the configured levels before Nest's logger sees them. */
class LevelFilteredLogger extends Logger {
  constructor(
    context: string,
    private readonly levels: false | LogLevel[],
  ) {
    super(context);
  }

  private allows(level: LogLevel): boolean {
    return this.levels !== false && isLevelEnabled(level, this.levels);
  }

  override log(message: any, ...optionalParams: any[]) {
    if (this.allows('log')) {
      super.log(message, ...optionalParams);
    }
  }

  override error(message: any, ...optionalParams: any[]) {
    if (this.allows('error')) {
      super.error(message, ...optionalParams);
    }
  }

  override warn(message: any, ...optionalParams: any[]) {
    if (this.allows('warn')) {
      super.warn(message, ...optionalParams);
    }
  }

  override debug(message: any, ...optionalParams: any[]) {
    if (this.allows('debug')) {
      super.debug(message, ...optionalParams);
    }
  }

  override verbose(message: any, ...optionalParams: any[]) {
    if (this.allows('verbose')) {
      super.verbose(message, ...optionalParams);
    }
  }

  override fatal(message: any, ...optionalParams: any[]) {
    if (this.allows('fatal')) {
      super.fatal(message, ...optionalParams);
    }
  }
}
