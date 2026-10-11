import { spawn } from "node:child_process";

/**
 * Injectable command runner for Action Fusion. The v1 wiring uses the
 * node:child_process implementation; tests inject a fake runner.
 */

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandRunner {
  run(command: string, cwd: string, timeoutMs: number): Promise<CommandResult>;
}

/** Hard cap on captured output per stream; the observation tail is smaller. */
const CAPTURE_CAP_BYTES = 64 * 1024;

class BoundedSink {
  private chunks: Buffer[] = [];
  private total = 0;
  private dropped = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.total += chunk.byteLength;
    while (this.total > CAPTURE_CAP_BYTES && this.chunks.length > 1) {
      const first = this.chunks.shift()!;
      this.total -= first.byteLength;
      this.dropped += first.byteLength;
    }
  }

  text(): string {
    const prefix = this.dropped > 0 ? `...${this.dropped} bytes truncated...\n` : "";
    return prefix + Buffer.concat(this.chunks).toString("utf8");
  }
}

export function createNodeRunner(): CommandRunner {
  return {
    run(command, cwd, timeoutMs) {
      return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
        const out = new BoundedSink();
        const err = new BoundedSink();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          const hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
          hardKill.unref();
        }, timeoutMs);
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          resolve({
            exitCode: timedOut ? 124 : (code ?? (signal ? 128 : 0)),
            stdout: out.text(),
            stderr: err.text(),
            timedOut,
          });
        });
      });
    },
  };
}
