import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Transcript } from '../../src/components/Transcript';
import { assistantMessage, userMessage } from '../../src/chat/message';
import type { ChatMessage } from '../../src/chat/message';
import type { Conversation } from '../../src/chat/conversation';

function finished(messages: readonly ChatMessage[]): Conversation {
  return { messages, streaming: false, error: null };
}

describe('Transcript', () => {
  it('shows the question and the answer as separate entries', () => {
    render(
      <Transcript
        conversation={finished([
          userMessage('u1', 'What is a redlock?'),
          { ...assistantMessage('a1'), text: 'a gate held by water' },
        ])}
      />,
    );
    expect(screen.getByText('What is a redlock?').textContent).toBe('What is a redlock?');
    expect(screen.getByText('a gate held by water').textContent).toBe('a gate held by water');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('labels the two sides of the exchange', () => {
    render(
      <Transcript
        conversation={finished([userMessage('u1', 'question'), { ...assistantMessage('a1'), text: 'answer' }])}
      />,
    );
    expect(screen.getByText('You').textContent).toBe('You');
    expect(screen.getByText('Model').textContent).toBe('Model');
  });

  it('shows thinking beside the answer it belongs to', () => {
    render(
      <Transcript
        conversation={finished([{ ...assistantMessage('a1'), reasoning: 'look at redis', text: 'a lock' }])}
      />,
    );
    expect(screen.getByText('Thinking').textContent).toBe('Thinking');
    expect(screen.getByText('look at redis').textContent).toBe('look at redis');
    expect(screen.getByText('a lock').textContent).toBe('a lock');
  });

  it('says waiting while an answer with no text yet is being waited for', () => {
    render(
      <Transcript
        conversation={{
          messages: [userMessage('u1', 'question'), assistantMessage('a1')],
          streaming: true,
          error: null,
        }}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('waiting');
  });

  it('says answering once text has started to arrive', () => {
    render(
      <Transcript
        conversation={{
          messages: [userMessage('u1', 'question'), { ...assistantMessage('a1'), text: 'some ' }],
          streaming: true,
          error: null,
        }}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('answering');
    expect(screen.getByRole('status').textContent).not.toContain('waiting');
  });

  it('does not claim anything is in progress once the turn is over', () => {
    render(<Transcript conversation={finished([assistantMessage('a1')])} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps a line break from the model as a line break', () => {
    const { container } = render(
      <Transcript conversation={finished([{ ...assistantMessage('a1'), text: 'one\ntwo' }])} />,
    );
    expect(container.querySelector('.markdown br')).not.toBeNull();
  });

  it('shows a question as written, never as markdown', () => {
    render(<Transcript conversation={finished([userMessage('u1', '**not bold**')])} />);
    expect(screen.getByText('**not bold**')).toBeTruthy();
  });

  it('says thinking while only the reasoning channel has spoken', () => {
    render(
      <Transcript
        conversation={{
          messages: [{ ...assistantMessage('a1'), reasoning: 'hm' }],
          streaming: true,
          error: null,
        }}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('thinking');
    expect(screen.getByText('Thinking…')).toBeTruthy();
  });

  it('says how long the model thought', () => {
    const stats = { outputTokens: null, contextTokens: null, tokensPerSecond: null, thoughtMs: 14000 };
    render(
      <Transcript
        conversation={finished([{ ...assistantMessage('a1'), reasoning: 'hm', text: 'yes', stats }])}
      />,
    );
    expect(screen.getByText('Thought for 14s')).toBeTruthy();
  });

  it('marks an answer that was stopped or cut off', () => {
    render(
      <Transcript
        conversation={finished([
          { ...assistantMessage('a1'), text: 'half', ending: 'stopped' },
          { ...assistantMessage('a2'), text: 'long', ending: 'length' },
        ])}
      />,
    );
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.getByText('Cut off at the length limit')).toBeTruthy();
  });

  it('shows what a finished turn cost', () => {
    const stats = { outputTokens: 1200, contextTokens: 2000, tokensPerSecond: 18.25, thoughtMs: null };
    render(<Transcript conversation={finished([{ ...assistantMessage('a1'), text: 'a', stats }])} />);
    expect(screen.getByText('1,200 tokens · 18.3 tok/s')).toBeTruthy();
  });

  it('offers retry on the newest answer only', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <Transcript
        onRetry={onRetry}
        conversation={finished([
          userMessage('u1', 'q'),
          { ...assistantMessage('a1'), text: 'first' },
          userMessage('u2', 'q2'),
          { ...assistantMessage('a2'), text: 'second' },
        ])}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: 'Retry' });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0] as HTMLElement);
    expect(onRetry).toBeCalled();
  });

  it('offers retry for a question left with no answer', () => {
    render(<Transcript onRetry={() => undefined} conversation={finished([userMessage('u1', 'q')])} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('offers no tools on an answer still arriving', () => {
    render(
      <Transcript
        onRetry={() => undefined}
        conversation={{
          messages: [userMessage('u1', 'q'), { ...assistantMessage('a1'), text: 'some' }],
          streaming: true,
          error: null,
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  describe('the thinking box', () => {
    const thinking = (reasoning: string, streaming = true): Conversation => ({
      messages: [{ ...assistantMessage('a1'), reasoning }],
      streaming,
      error: null,
    });

    function open(container: HTMLElement): { fold: HTMLDetailsElement; box: HTMLElement } {
      const fold = container.querySelector<HTMLDetailsElement>('details.reasoning');
      const box = container.querySelector<HTMLElement>('details.reasoning .pre');
      if (fold === null || box === null) throw new Error('no thinking box');
      Object.defineProperty(box, 'scrollHeight', { value: 900, configurable: true });
      Object.defineProperty(box, 'clientHeight', { value: 300, configurable: true });
      fold.open = true;
      fireEvent(fold, new Event('toggle'));
      return { fold, box };
    }

    it('starts at the newest line when opened while the model thinks', () => {
      const { container } = render(<Transcript conversation={thinking('hm')} />);
      expect(open(container).box.scrollTop).toBe(900);
    });

    it('follows the thinking as it grows', () => {
      const view = render(<Transcript conversation={thinking('hm')} />);
      const { box } = open(view.container);
      Object.defineProperty(box, 'scrollHeight', { value: 1200, configurable: true });

      view.rerender(<Transcript conversation={thinking('hm, more')} />);

      expect(box.scrollTop).toBe(1200);
    });

    it('leaves a reader who scrolled up where they are', () => {
      const view = render(<Transcript conversation={thinking('hm')} />);
      const { box } = open(view.container);
      box.scrollTop = 100;
      fireEvent.scroll(box);

      view.rerender(<Transcript conversation={thinking('hm, more')} />);

      expect(box.scrollTop).toBe(100);
    });

    it('starts at the top when opened after the thinking is done', () => {
      const { container } = render(<Transcript conversation={thinking('hm', false)} />);
      expect(open(container).box.scrollTop).toBe(0);
    });
  });
});
