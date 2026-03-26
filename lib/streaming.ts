/**
 * Streaming utilities for handling real-time responses with batching and optimization
 */

/**
 * Debounce streaming updates to prevent excessive re-renders
 * Groups updates together and only triggers callback when:
 * 1. Buffer reaches maxChars
 * 2. Delay ms have passed since last update
 */
export function createStreamBatcher(
  onUpdate: (text: string) => void,
  options: { maxChars?: number; delayMs?: number } = {}
) {
  const { maxChars = 500, delayMs = 100 } = options;
  let buffer = "";
  let timeoutId: NodeJS.Timeout | null = null;

  const flush = () => {
    if (buffer.length > 0) {
      onUpdate(buffer);
      buffer = "";
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const add = (chunk: string) => {
    buffer += chunk;

    if (buffer.length >= maxChars) {
      flush();
    } else if (!timeoutId) {
      // Schedule flush if not already scheduled
      timeoutId = setTimeout(() => {
        flush();
      }, delayMs);
    }
  };

  return { add, flush };
}

/**
 * Create a timeout abort signal that auto-cancels after specified duration
 * Falls back to manual timeout for older browsers
 */
export function createStreamTimeout(durationMs: number = 30000): AbortSignal {
  // Modern approach: use native AbortSignal.timeout (Chrome 93+, Node 17+)
  if (AbortSignal.timeout) {
    return AbortSignal.timeout(durationMs);
  }

  // Fallback for older browsers
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, durationMs);

  // Store timeout ID for cleanup if needed
  (controller as any).__timeoutId = timeoutId;

  return controller.signal;
}

/**
 * Parse a stream chunk, handling SSE format and partial JSON
 */
export interface ParsedChunk {
  content: string;
  metadata?: Record<string, unknown>;
  isMetadata: boolean;
  parseError?: string;
}

export function parseStreamChunk(
  chunk: string,
  isFirstChunk: boolean
): ParsedChunk {
  // Try to parse as metadata on first chunk
  if (isFirstChunk) {
    const lines = chunk.split("\n");
    const firstLine = lines[0].trim();

    if (firstLine) {
      try {
        const metadata = JSON.parse(firstLine);
        // Validate that it's actually metadata (has expected fields)
        if (
          metadata &&
          typeof metadata === "object" &&
          ("model" in metadata || "isComplete" in metadata)
        ) {
          return {
            content: lines.slice(1).join("\n"),
            metadata,
            isMetadata: true,
          };
        }
      } catch {
        // Not valid JSON metadata, treat entire chunk as content
      }
    }
  }

  return {
    content: chunk,
    isMetadata: false,
  };
}

/**
 * Estimate reading time based on character count
 * Uses average reading speed of 200 words per minute
 */
export function estimateReadingTime(text: string): number {
  const words = text.split(/\s+/).length;
  const readingSpeedWPM = 200;
  const minutes = Math.ceil(words / readingSpeedWPM);
  return Math.max(1, minutes); // Minimum 1 minute
}

/**
 * Estimate progress percentage based on response characteristics
 * This is a heuristic - later updates will refine the estimate
 */
export function estimateProgressPercentage(
  currentLength: number,
  estimatedMaxLength: number = 3000
): number {
  // Use logarithmic scale so initial responses show good progress
  // but we don't immediately jump to 100%
  const ratio = Math.min(currentLength / estimatedMaxLength, 1);
  // Logarithmic: slower at start, faster at end, caps at 90% until completion
  return Math.floor(Math.log(ratio + 1) / Math.log(2) * 90);
}

/**
 * Manager for handling stream cleanup and recovery
 */
export class StreamManager {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private decoder: TextDecoder;
  private isAborted: boolean = false;

  constructor() {
    this.decoder = new TextDecoder();
  }

  /**
   * Start reading from response body
   */
  async readStream(
    response: Response,
    onChunk: (chunk: string) => void,
    onError?: (error: Error) => void
  ): Promise<{
    success: boolean;
    totalChars: number;
    error?: string;
  }> {
    if (!response.body) {
      return {
        success: false,
        totalChars: 0,
        error: "Response has no body",
      };
    }

    this.reader = response.body.getReader();
    let totalChars = 0;

    try {
      while (!this.isAborted) {
        const { done, value } = await this.reader.read();

        if (done) break;

        const chunk = this.decoder.decode(value, { stream: true });
        totalChars += chunk.length;
        onChunk(chunk);
      }

      return {
        success: !this.isAborted,
        totalChars,
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "Unknown stream error";
      onError?.(new Error(errorMsg));
      return {
        success: false,
        totalChars,
        error: errorMsg,
      };
    } finally {
      this.cleanup();
    }
  }

  /**
   * Abort the current stream
   */
  abort(): void {
    this.isAborted = true;
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    if (this.reader) {
      try {
        this.reader.releaseLock();
      } catch {
        // Reader already released
      }
      this.reader = null;
    }
  }

  /**
   * Check if stream was aborted
   */
  getIsAborted(): boolean {
    return this.isAborted;
  }
}
