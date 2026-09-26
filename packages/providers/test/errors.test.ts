import { describe, expect, it } from 'vitest';
import { describeError } from '../src/index.js';

describe('describeError', () => {
  it('describeError appends the url and errno code of connection errors', () => {
    const err = Object.assign(new Error('Failed after 3 attempts. Cannot connect to API: '), {
      lastError: {
        url: 'http://localhost:11434/v1/chat/completions',
        cause: { code: 'ECONNREFUSED' },
      },
    });
    expect(describeError(err)).toBe(
      'Failed after 3 attempts. Cannot connect to API: (http://localhost:11434/v1/chat/completions ECONNREFUSED)',
    );
    expect(describeError(new Error('plain'))).toBe('plain');
  });
  it('appends the HTTP status code of API errors', () => {
    const err = Object.assign(new Error('Failed after 1 attempts. Last error: boom'), {
      lastError: { statusCode: 500, url: 'http://x/v1/chat/completions' },
    });
    expect(describeError(err)).toBe(
      'Failed after 1 attempts. Last error: boom (HTTP 500 http://x/v1/chat/completions)',
    );
  });
});
