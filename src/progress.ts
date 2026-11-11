/**
 * Structured progress (`--progress ndjson`): one JSON event per line on stderr, so an embedding system can
 * follow a run while --json keeps stdout for the report. In this mode every stderr line is a JSON object: the
 * plain log lines are suppressed and errors are written as the JSON error object (`{"error":…}`).
 *
 * The event shapes are part of the published schema (`searvex schema events`).
 */

export type ProgressPhase = 'crawl' | 'analyze' | 'report';

export type ProgressEvent =
  | { event: 'start'; time: string; version: string; command: string; target?: string }
  | { event: 'phase'; time: string; phase: ProgressPhase }
  | {
      event: 'page';
      time: string;
      url: string;
      /** HTTP status; 0 for a URL blocked by robots.txt or a network error. */
      status: number;
      /** True when robots.txt disallows the URL (it was not requested). */
      blocked: boolean;
      /** URLs requested so far / processed so far (fetched + blocked) / still queued. */
      fetched: number;
      crawled: number;
      queued: number;
    }
  | {
      event: 'finding-summary';
      time: string;
      runId: string;
      status: string;
      /** Findings that count toward the score, by severity. */
      bySeverity: Record<string, number>;
      findings: number;
      affectedUrls: number;
      score: number | null;
    }
  | { event: 'signal'; time: string; signal: string }
  | {
      event: 'end';
      time: string;
      exitCode: number;
      /** Report files written by the command. */
      reports: string[];
      interrupted?: 'signal' | 'max-duration';
    };

type Payload<E> = E extends { event: infer N; time: string } ? Omit<E, 'time'> & { event: N } : never;

/** The ndjson progress stream of the current CLI run (one per process). */
export class Progress {
  readonly reports: string[] = [];
  interrupted?: 'signal' | 'max-duration';

  constructor(private write: (line: string) => void = (l) => process.stderr.write(l + '\n')) {}

  emit(e: Payload<ProgressEvent>): void {
    this.write(JSON.stringify({ ...e, time: new Date().toISOString() }));
  }
}

let current: Progress | null = null;

/** The active ndjson progress stream, or null when --progress ndjson was not given. */
export function progress(): Progress | null {
  return current;
}

export function setProgress(p: Progress | null): void {
  current = p;
}
