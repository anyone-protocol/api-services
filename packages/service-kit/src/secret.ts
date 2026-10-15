export const REDACTED = '[redacted]';

export const MIN_REDACTED_LENGTH = 8;

let redactedForms: string[] = [];

function formsOf(value: string): string[] {
  return [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
}

export function registerSecret(value: string): void {
  if (value.length < MIN_REDACTED_LENGTH) return;
  const forms = new Set([...redactedForms, ...formsOf(value)]);
  redactedForms = [...forms].sort((a, b) => b.length - a.length);
}

export function redact(text: string): string {
  return redactedForms.reduce((result, form) => result.replaceAll(form, REDACTED), text);
}

export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
    registerSecret(String(value));
  }

  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}
