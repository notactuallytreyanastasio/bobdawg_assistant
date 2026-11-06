import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { SUGGESTIONS, Welcome } from '../../src/components/Welcome';

describe('Welcome', () => {
  it('hands over the suggestion that was picked', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Welcome ready onPick={onPick} />);
    const first = SUGGESTIONS[0] ?? '';

    await user.click(screen.getByRole('button', { name: first }));

    expect(onPick).toBeCalledWith(first);
  });

  it('offers nothing to press until the server is there', () => {
    render(<Welcome ready={false} onPick={() => undefined} />);
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });
});
