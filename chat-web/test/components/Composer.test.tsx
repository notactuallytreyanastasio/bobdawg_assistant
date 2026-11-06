import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Composer } from '../../src/components/Composer';
import { emptyConversation } from '../../src/chat/conversation';
import { assistantMessage } from '../../src/chat/message';
import type { Conversation } from '../../src/chat/conversation';

function answering(): Conversation {
  return { messages: [{ ...assistantMessage('a1'), text: 'partial ' }], streaming: true, error: null };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

describe('Composer', () => {
  it('sends the text on enter and clears the box', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer conversation={emptyConversation} ready onSend={onSend} onStop={() => undefined} />);

    await user.type(screen.getByRole('textbox'), 'What is a redlock?{Enter}');

    expect(onSend.mock.calls[0]?.[0]).toBe('What is a redlock?');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('sends the text when the button is pressed', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer conversation={emptyConversation} ready onSend={onSend} onStop={() => undefined} />);

    await user.type(screen.getByRole('textbox'), 'hello');
    await user.click(button('Send'));

    expect(onSend.mock.calls[0]?.[0]).toBe('hello');
  });

  it('keeps the newline when enter is pressed with shift held', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer conversation={emptyConversation} ready onSend={onSend} onStop={() => undefined} />);

    await user.type(screen.getByRole('textbox'), 'a{Shift>}{Enter}{/Shift}b');

    expect(onSend).not.toBeCalled();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('a\nb');
  });

  it('will not send a question that is blank or only whitespace', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer conversation={emptyConversation} ready onSend={onSend} onStop={() => undefined} />);

    const send = button('Send');
    expect(send.disabled).toBe(true);

    await user.type(screen.getByRole('textbox'), '   ');
    expect(button('Send').disabled).toBe(true);
    await user.keyboard('{Enter}');
    expect(onSend).not.toBeCalled();
  });

  it('will not send a second question while the first is being answered', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer conversation={answering()} ready onSend={onSend} onStop={() => undefined} />);

    await user.type(screen.getByRole('textbox'), 'next');
    expect(button('Stop')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(onSend).not.toBeCalled();
  });

  it('offers stop while the model is answering', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<Composer conversation={answering()} ready onSend={() => undefined} onStop={onStop} />);

    await user.click(button('Stop'));
    expect(onStop).toBeCalled();
  });

  it('will not let anything out while the server is unknown', () => {
    render(<Composer conversation={emptyConversation} ready={false} onSend={() => undefined} onStop={() => undefined} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    expect(button('Send').disabled).toBe(true);
    expect(screen.getByText('waiting for the model name').textContent).toBe('waiting for the model name');
  });
});
