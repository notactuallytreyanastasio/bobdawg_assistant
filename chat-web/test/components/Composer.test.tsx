import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
  });

  it('says why the box is closed', () => {
    render(
      <Composer
        conversation={emptyConversation}
        ready={false}
        notice="Connecting to ds4-server"
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );
    expect(screen.getByText('Connecting to ds4-server')).toBeTruthy();
  });

  it('leaves enter alone while an input method is composing', () => {
    const onSend = vi.fn();
    render(<Composer conversation={emptyConversation} ready onSend={onSend} onStop={() => undefined} />);
    const box = screen.getByRole('textbox');

    fireEvent.change(box, { target: { value: 'にほん' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSend).not.toBeCalled();

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toBeCalledWith('にほん');
  });

  it('stops the answer on escape', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<Composer conversation={answering()} ready onSend={() => undefined} onStop={onStop} />);

    await user.type(screen.getByRole('textbox'), '{Escape}');
    expect(onStop).toBeCalled();
  });

  it('turns thinking on and off', async () => {
    const user = userEvent.setup();
    const onThinking = vi.fn();
    render(
      <Composer
        conversation={emptyConversation}
        ready
        thinking
        onThinking={onThinking}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );

    const toggle = button('Thinking');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(toggle);
    expect(onThinking).toBeCalledWith(false);
  });

  it('shows how much of the context is used, once that is known', () => {
    render(
      <Composer
        conversation={emptyConversation}
        ready
        contextPercent={12}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );
    expect(screen.getByText('12% of context')).toBeTruthy();
  });

  it('offers Plot beside Thinking, and says which way it is', async () => {
    const user = userEvent.setup();
    const onPlot = vi.fn();
    const view = render(
      <Composer conversation={emptyConversation} ready plot={false} onPlot={onPlot} onSend={() => undefined} onStop={() => undefined} />,
    );
    const toggle = button('Plot');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(onPlot).toHaveBeenCalledWith(true);
    view.rerender(
      <Composer conversation={emptyConversation} ready plot onPlot={onPlot} onSend={() => undefined} onStop={() => undefined} />,
    );
    expect(button('Plot').getAttribute('aria-pressed')).toBe('true');
    expect(button('Plot').className).toBe('toggle on');
  });

  it('leaves Plot out when nothing handles it', () => {
    render(<Composer conversation={emptyConversation} ready onSend={() => undefined} onStop={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Plot' })).toBeNull();
  });
});
