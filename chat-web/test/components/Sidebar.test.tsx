import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Sidebar } from '../../src/components/Sidebar';
import type { SidebarProps } from '../../src/components/Sidebar';
import { userMessage } from '../../src/chat/message';

const chats = [
  { id: 'c1', title: 'First', updatedAt: 2, messages: [userMessage('u1', 'First')] },
  { id: 'c2', title: 'Second', updatedAt: 1, messages: [userMessage('u2', 'Second')] },
];

function props(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    chats,
    activeId: 'c1',
    open: false,
    onNew: () => undefined,
    onOpen: () => undefined,
    onDelete: () => undefined,
    onClose: () => undefined,
    ...overrides,
  };
}

describe('Sidebar', () => {
  it('says so while there are no chats', () => {
    render(<Sidebar {...props({ chats: [] })} />);
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
  });

  it('marks the open chat and opens another', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Sidebar {...props({ onOpen })} />);

    expect(screen.getByRole('button', { name: 'First' }).getAttribute('aria-current')).toBe('page');
    await user.click(screen.getByRole('button', { name: 'Second' }));
    expect(onOpen).toBeCalledWith('c2');
  });

  it('asks once before deleting', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<Sidebar {...props({ onDelete })} />);

    await user.click(screen.getByRole('button', { name: 'Delete Second' }));
    expect(onDelete).not.toBeCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toBeCalledWith('c2');
  });

  it('lets a delete go by clicking elsewhere', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<Sidebar {...props({ onDelete })} />);

    await user.click(screen.getByRole('button', { name: 'Delete Second' }));
    await user.click(screen.getByRole('button', { name: 'New chat' }));

    expect(onDelete).not.toBeCalled();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('offers a way out of the drawer on a phone', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Sidebar {...props({ open: true, onClose })} />);

    await user.click(screen.getByRole('button', { name: 'Close chats' }));
    expect(onClose).toBeCalled();
  });
});
