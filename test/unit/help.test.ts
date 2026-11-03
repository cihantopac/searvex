import { describe, expect, it } from 'vitest';
import { CLI_OPTIONS, HELP_TEXT } from '../../src/cli.js';

describe('--help', () => {
  it('lists every option the CLI parses', () => {
    const missing = Object.keys(CLI_OPTIONS).filter((name) => !HELP_TEXT.includes(`--${name}`));
    expect(missing).toEqual([]);
  });

  it('documents --timeout with its default and range', () => {
    expect(HELP_TEXT).toMatch(/--timeout <ms>\s+Per-request timeout \(default 15000, 1000–120000\)/);
  });
});
