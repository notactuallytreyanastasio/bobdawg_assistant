import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { CopyButton } from '../../src/components/CopyButton';

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('CopyButton', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('copies the text and says so', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    render(<CopyButton text="hello" />);
    stubClipboard(writeText);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    expect(writeText).toBeCalledWith('hello');
  });

  it('says so when the copy failed', async () => {
    const user = userEvent.setup();
    render(<CopyButton text="hello" />);
    stubClipboard(async () => Promise.reject(new Error('denied')));
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy failed' })).toBeTruthy());
  });
});
