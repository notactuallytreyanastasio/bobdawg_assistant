import { describe, expect, it, vi } from 'vitest';
import { expandCommand } from '../../src/chat/commands';
import type { ReadFile } from '../../src/chat/commands';

const none: ReadFile = async () => ({ ok: false, text: 'no such file' });

describe('expandCommand', () => {
  it('leaves ordinary text alone without asking the sandbox', async () => {
    const read = vi.fn<ReadFile>(none);
    expect(await expandCommand('what is /usr/bin for?', read)).toBe('what is /usr/bin for?');
    expect(read).not.toHaveBeenCalled();
  });

  it('knows the built-in commands', async () => {
    expect(await expandCommand('/init', none)).toContain('AGENT.md');
    const review = await expandCommand('/review only the parser', none);
    expect(review).toContain('git diff');
    expect(review).toContain('only the parser');
    expect(review).not.toContain('$ARGUMENTS');
  });

  it('prefers a file of the same name, and fills in what followed', async () => {
    const read = vi.fn<ReadFile>(async () => ({ ok: true, text: 'Ship $ARGUMENTS, $ARGUMENTS!' }));
    expect(await expandCommand('/review v2', read)).toBe('Ship v2, v2!');
    expect(read).toHaveBeenCalledWith('.ds4/commands/review.md');
  });

  it('puts arguments on the end of a file with no place for them', async () => {
    expect(await expandCommand('/x go', async () => ({ ok: true, text: 'Do it' }))).toBe('Do it\n\ngo');
  });

  it('leaves an unknown slash as it was, even if the sandbox fails', async () => {
    expect(await expandCommand('/nothing here', none)).toBe('/nothing here');
    expect(await expandCommand('/nothing', async () => Promise.reject(new Error('down')))).toBe('/nothing');
  });

  it('takes no path for a name', async () => {
    const read = vi.fn<ReadFile>(none);
    expect(await expandCommand('/../../etc/passwd', read)).toBe('/../../etc/passwd');
    expect(read).not.toHaveBeenCalled();
  });
});
