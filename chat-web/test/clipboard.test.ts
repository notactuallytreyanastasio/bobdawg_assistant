import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../src/clipboard';

function stubClipboard(clipboard: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

function stubExecCommand(result: boolean) {
  const execCommand = vi.fn(() => result);
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
  return execCommand;
}

describe('copyText', () => {
  afterEach(() => stubClipboard(undefined));

  it('uses the clipboard where the browser offers it', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard({ writeText });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toBeCalledWith('hello');
  });

  it('goes through a selection over plain http, where there is no clipboard', async () => {
    stubClipboard(undefined);
    const execCommand = stubExecCommand(true);
    expect(await copyText('hello')).toBe(true);
    expect(execCommand).toBeCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when the clipboard refuses, and reports a copy that did not happen', async () => {
    stubClipboard({ writeText: async () => Promise.reject(new Error('denied')) });
    stubExecCommand(false);
    expect(await copyText('hello')).toBe(false);
  });
});
