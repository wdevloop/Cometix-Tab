import { Logger } from './logger';

export class Telemetry {
  private static logger = Logger.getInstance();
  private static SAMPLE_RATE = 0.01; // default 1%

  static setSampleRate(rate: number) {
    this.SAMPLE_RATE = Math.max(0, Math.min(1, rate));
  }

  static emit(eventName: string, props: Record<string, any> = {}): void {
    // Sampling for high-frequency events
    if (Math.random() > this.SAMPLE_RATE && this.isHighFreq(eventName)) return;

    const sanitized = this.sanitize(props);
    try {
      this.logger.info(`[telemetry] ${eventName} ${JSON.stringify(sanitized)}`);
    } catch {
      // ignore
    }
  }

  private static isHighFreq(eventName: string): boolean {
    return [
      'completion_triggered',
      'completion_stream_started',
      'completion_stream_ended',
      'completion_cancelled',
      'fs_upload_started',
      'fs_upload_finished',
    ].includes(eventName);
  }

  private static sanitize(props: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === 'string') {
        if (k.toLowerCase().includes('path')) {
          result[k] = this.hash(v);
        } else if (k.toLowerCase().includes('contents')) {
          result[k] = undefined;
        } else {
          result[k] = v;
        }
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  private static hash(input: string): string {
    try {
      const data = new TextEncoder().encode(input);
      // trivial sum hash (sufficient for PII minimization logging)
      let h = 0;
      for (let i = 0; i < data.length; i++) h = (h + data[i]) >>> 0;
      return `h${h.toString(16)}`;
    } catch {
      return 'h0';
    }
  }
} 