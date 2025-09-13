// Mock for @chronark/zod-bird using their built-in NoopTinybird pattern
export class Tinybird {
  private noop: boolean;

  constructor(config?: { noop?: boolean; token?: string; baseUrl?: string }) {
    this.noop = config?.noop || false;
  }

  buildIngestEndpoint(config: any) {
    return async (data: any) => ({
      successful_rows: this.noop ? 0 : 1,
      quarantined_rows: 0,
    });
  }

  buildPipe(config: any) {
    return async (params: any) => ({
      data: [],
    });
  }
}

/**
 * NoopTinybird is a mock implementation that doesn't do anything and returns empty data.
 */
export class NoopTinybird extends Tinybird {
  constructor() {
    super({ noop: true });
  }
}