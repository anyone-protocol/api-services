import { describe, expect, it } from 'bun:test';
import { redact, registerSecret, Secret } from './secret';

describe('Secret', () => {
  const secret = new Secret('wrapped-secret-value');

  it('gives its value only through reveal', () => {
    expect(secret.reveal()).toBe('wrapped-secret-value');
  });

  it('prints as redacted however it is turned into text', () => {
    expect(`${secret}`).toBe('[redacted]');
    expect(String(secret)).toBe('[redacted]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(Bun.inspect({ secret })).not.toContain('wrapped-secret-value');
    expect(new Error(`failed with ${secret}`).message).toBe('failed with [redacted]');
  });
});

describe('redact', () => {
  it('replaces a registered value in its plain, URL-encoded and JSON-escaped forms', () => {
    registerSecret('p@ss/"word"\\with-symbols');

    expect(redact('plain p@ss/"word"\\with-symbols')).toBe('plain [redacted]');
    expect(redact(`url ?key=${encodeURIComponent('p@ss/"word"\\with-symbols')}`)).toBe('url ?key=[redacted]');
    expect(redact(JSON.stringify({ error: 'bad p@ss/"word"\\with-symbols' }))).toBe('{"error":"bad [redacted]"}');
  });

  it('replaces a longer value before a shorter one it contains', () => {
    registerSecret('shared-prefix');
    registerSecret('shared-prefix-and-more');

    expect(redact('shared-prefix-and-more')).toBe('[redacted]');
  });

  it('leaves values too short to match safely', () => {
    registerSecret('short');

    expect(redact('a short line')).toBe('a short line');
  });
});
