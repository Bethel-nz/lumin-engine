import type { EnvBindings } from '../types';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  CRITICAL = 4,
}

export interface LogContext {
  userId?: string;
  eventId?: string;
  requestId?: string;
  duration?: number;
  metadata?: Record<string, unknown>;
}

export interface MetricData {
  name: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
  timestamp?: number;
}

class Logger {
  private env: EnvBindings;
  private minLevel: LogLevel;

  constructor(env: EnvBindings, minLevel = LogLevel.INFO) {
    this.env = env;
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.minLevel;
  }

  private formatLog(level: LogLevel, message: string, context?: LogContext): string {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level],
      message,
      service: 'lumin',
      environment: this.env.ENVIRONMENT || 'development',
      ...context,
    };
    return JSON.stringify(logEntry);
  }

  private async sendToMonitoring(level: LogLevel, message: string, context?: LogContext): Promise<void> {
    if (!this.env.MONITORING_ENDPOINT) return;

    try {
      const logData = {
        timestamp: new Date().toISOString(),
        level: LogLevel[level],
        message,
        service: 'lumin',
        environment: this.env.ENVIRONMENT || 'development',
        ...context,
      };

      await fetch(this.env.MONITORING_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.env.MONITORING_TOKEN}`,
        },
        body: JSON.stringify(logData),
      });
    } catch (error) {
      console.error('Failed to send log to monitoring service:', error);
    }
  }

  debug(message: string, context?: LogContext): void {
    if (!this.shouldLog(LogLevel.DEBUG)) return;
    console.debug(this.formatLog(LogLevel.DEBUG, message, context));
  }

  info(message: string, context?: LogContext): void {
    if (!this.shouldLog(LogLevel.INFO)) return;
    console.info(this.formatLog(LogLevel.INFO, message, context));
    this.sendToMonitoring(LogLevel.INFO, message, context).catch(() => {});
  }

  warn(message: string, context?: LogContext): void {
    if (!this.shouldLog(LogLevel.WARN)) return;
    console.warn(this.formatLog(LogLevel.WARN, message, context));
    this.sendToMonitoring(LogLevel.WARN, message, context).catch(() => {});
  }

  error(message: string, error?: Error, context?: LogContext): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;
    const errorContext = {
      ...context,
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : undefined,
    };
    console.error(this.formatLog(LogLevel.ERROR, message, errorContext));
    this.sendToMonitoring(LogLevel.ERROR, message, errorContext).catch(() => {});
  }

  critical(message: string, error?: Error, context?: LogContext): void {
    const errorContext = {
      ...context,
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : undefined,
    };
    console.error(this.formatLog(LogLevel.CRITICAL, message, errorContext));
    this.sendToMonitoring(LogLevel.CRITICAL, message, errorContext).catch(() => {});
  }
}

class MetricsCollector {
  private env: EnvBindings;
  private buffer: MetricData[] = [];
  private bufferSize = 100;
  private flushInterval = 30000; // 30 seconds

  constructor(env: EnvBindings) {
    this.env = env;
    this.startPeriodicFlush();
  }

  record(metric: MetricData): void {
    this.buffer.push({
      ...metric,
      timestamp: metric.timestamp || Date.now(),
    });

    if (this.buffer.length >= this.bufferSize) {
      this.flush().catch(() => {});
    }
  }

  recordTiming(name: string, duration: number, tags?: Record<string, string>): void {
    this.record({
      name,
      value: duration,
      unit: 'ms',
      tags,
    });
  }

  recordCounter(name: string, value = 1, tags?: Record<string, string>): void {
    this.record({
      name,
      value,
      unit: 'count',
      tags,
    });
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.env.METRICS_ENDPOINT) return;

    const metrics = [...this.buffer];
    this.buffer = [];

    try {
      await fetch(this.env.METRICS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.env.METRICS_TOKEN}`,
        },
        body: JSON.stringify({ metrics }),
      });
    } catch (error) {
      console.error('Failed to flush metrics:', error);
      this.buffer.unshift(...metrics);
    }
  }

  private startPeriodicFlush(): void {
    setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushInterval);
  }
}

export const createLogger = (env: EnvBindings): Logger => new Logger(env);
export const createMetricsCollector = (env: EnvBindings): MetricsCollector => new MetricsCollector(env);

export const withTiming = async <T>(
  name: string,
  fn: () => Promise<T>,
  metrics: MetricsCollector,
  tags?: Record<string, string>
): Promise<T> => {
  const start = performance.now();
  try {
    const result = await fn();
    const duration = performance.now() - start;
    metrics.recordTiming(name, duration, { ...tags, status: 'success' });
    return result;
  } catch (error) {
    const duration = performance.now() - start;
    metrics.recordTiming(name, duration, { ...tags, status: 'error' });
    throw error;
  }
};