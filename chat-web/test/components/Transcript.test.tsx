import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Transcript } from '../../src/components/Transcript';
import { assistantMessage, toolMessage, userMessage } from '../../src/chat/message';
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
});

describe('Transcript with charts', () => {
  const code = '// title: Loaves\ndraw()';
  const asked = userMessage('u1', 'chart this', true);
  const calling = {
    ...assistantMessage('a1'),
    calls: [{ id: 'c1', name: 'plot', arguments: JSON.stringify({ code }) }],
  };
  const drew = toolMessage('t1', 'c1', true, 'ok: drew 1 svg');
  const threw = toolMessage('t1', 'c1', false, 'error: the code threw');
  const streaming = (messages: readonly ChatMessage[]): Conversation => ({ messages, streaming: true, error: null });

  it('renders tool messages as nothing', () => {
    render(<Transcript conversation={finished([asked, calling, drew])} />);
    expect(screen.queryByText('ok: drew 1 svg')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows a card per call, by title, and opens it', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Transcript conversation={finished([asked, calling, drew])} onOpen={onOpen} />);
    expect(screen.getByText('Ran without errors').textContent).toBe('Ran without errors');
    await user.click(screen.getByRole('button', { name: /Loaves/ }));
    expect(onOpen).toHaveBeenCalledWith('a1/c1');
  });

  it('asks before running, and names the risk', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    const onCode = vi.fn();
    render(
      <Transcript
        conversation={streaming([asked, calling])}
        pending={{ callId: 'c1', chars: 1234, withheld: 0 }}
        onRun={onRun}
        onCode={onCode}
      />,
    );
    screen.getByText(/This code will run with the 1234 characters you sent with Plot on/);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.click(screen.getByRole('button', { name: 'Code' }));
    expect(onRun).toHaveBeenCalledOnce();
    expect(onCode).toHaveBeenCalledWith('c1');
    expect(screen.getByRole('status').textContent).toContain('waiting for you to run it');
  });

  it('says at the Run card what was sent with Plot off', () => {
    render(<Transcript conversation={streaming([asked, calling])} pending={{ callId: 'c1', chars: 9, withheld: 2 }} />);
    screen.getByText(/Your 2 earlier messages sent with Plot off are not given to the chart/);
  });

  it('says a turn ran out of rounds, and does not call it giving up', () => {
    render(<Transcript conversation={finished([asked, { ...calling, ending: 'capped' }, drew])} />);
    screen.getByText(/Out of rounds/);
    expect(screen.queryByText('Gave up')).toBeNull();
  });

  it('offers no Run on a card that is not waiting', () => {
    render(<Transcript conversation={finished([asked, calling, drew])} pending={null} />);
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
  });

  it('says the code is running, and that it is being fixed', () => {
    const view = render(<Transcript conversation={streaming([asked, calling])} />);
    expect(screen.getByRole('status').textContent).toContain('running the code');
    view.rerender(<Transcript conversation={streaming([asked, calling, threw, assistantMessage('a2')])} />);
    expect(screen.getByRole('status').textContent).toContain('fixing the code');
  });

  it('folds a failed attempt away', () => {
    const { container } = render(<Transcript conversation={finished([asked, calling, threw])} />);
    const fold = container.querySelector('details.reasoning');
    expect(fold?.textContent).toContain('Attempt that did not work');
    expect(fold?.textContent).toContain('Loaves');
    expect(fold?.textContent).toContain('error: the code threw');
    expect(fold?.hasAttribute('open')).toBe(false);
  });

  it('names the model once across the rounds of a turn', () => {
    const closing = { ...assistantMessage('a2'), text: 'Saturdays lead.' };
    render(<Transcript conversation={finished([asked, calling, drew, closing])} />);
    expect(screen.getAllByText('Model')).toHaveLength(1);
  });

  it('offers Retry on a turn that ended on a tool message', () => {
    render(
      <Transcript
        conversation={finished([asked, { ...calling, ending: 'gaveup' as const }, threw])}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    expect(screen.getByText('Gave up').textContent).toBe('Gave up');
  });

  it('renders a hostile title as text', () => {
    const hostile = {
      ...calling,
      calls: [{ id: 'c1', name: 'plot', arguments: JSON.stringify({ code: '// title: <img src=x onerror=alert(1)>' }) }],
    };
    const { container } = render(<Transcript conversation={finished([asked, hostile, drew])} />);
    expect(container.querySelector('img')).toBeNull();
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
