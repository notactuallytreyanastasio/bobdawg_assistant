import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ShareBar } from '../../src/components/ShareBar';
import type { Artifact } from '../../src/chat/artifact';

const artifact: Artifact = {
  key: 'a1/c1',
  callId: 'c1',
  title: 'Loaves',
  code: 'draw()',
  messages: ['abcd'],
  withheld: 0,
  status: 'ok',
  detail: '',
};
const url = `http://server.test/chat/shared/${'ab'.repeat(16)}`;

describe('ShareBar', () => {
  it('says what sharing does before it does anything', async () => {
    const user = userEvent.setup();
    const onShare = vi.fn(async () => ({ kind: 'shared', url }) as const);
    render(<ShareBar artifact={artifact} onShare={onShare} />);

    await user.click(screen.getByRole('button', { name: 'Share as a page' }));

    expect(onShare).not.toHaveBeenCalled();
    expect(screen.getByText(/with the 4 characters you sent/).textContent).toContain('Anyone who can reach this server');
  });

  it('shows the link once the second press has gone through', async () => {
    const user = userEvent.setup();
    render(<ShareBar artifact={artifact} onShare={async () => ({ kind: 'shared', url })} />);

    await user.click(screen.getByRole('button', { name: 'Share as a page' }));
    await user.click(screen.getByRole('button', { name: 'Put it on the server' }));

    expect(screen.getByRole('link').getAttribute('href')).toBe(url);
    expect(screen.getByRole('link').getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
  });

  it('can be called off', async () => {
    const user = userEvent.setup();
    const onShare = vi.fn(async () => ({ kind: 'failed' }) as const);
    render(<ShareBar artifact={artifact} onShare={onShare} />);

    await user.click(screen.getByRole('button', { name: 'Share as a page' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onShare).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Share as a page' })).toBeTruthy();
  });

  it('says why when the server will not keep it', async () => {
    const user = userEvent.setup();
    render(<ShareBar artifact={artifact} onShare={async () => ({ kind: 'off' })} />);

    await user.click(screen.getByRole('button', { name: 'Share as a page' }));
    await user.click(screen.getByRole('button', { name: 'Put it on the server' }));

    expect(screen.getByRole('status').textContent).toContain('--share-dir');
  });

  it('offers nothing for a page that did not run', () => {
    const { container } = render(
      <ShareBar artifact={{ ...artifact, status: 'unchecked' }} onShare={async () => ({ kind: 'off' })} />,
    );
    expect(container.textContent).toBe('');
  });
});
