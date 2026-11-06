import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Transcript } from '../../src/components/Transcript';
import { assistantMessage, userMessage } from '../../src/chat/message';
import type { ChatMessage } from '../../src/chat/message';
import type { Conversation } from '../../src/chat/conversation';
import { emptyConversation } from '../../src/chat/conversation';

function finished(messages: readonly ChatMessage[]): Conversation {
  return { messages, streaming: false, error: null };
}

describe('Transcript', () => {
  it('says so when nothing has been asked', () => {
    render(<Transcript conversation={emptyConversation} />);
    expect(screen.getByText('Nothing asked yet')).toBeTruthy();
  });

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

  it('keeps the text readable when it holds line breaks', () => {
    const { container } = render(
      <Transcript conversation={finished([{ ...assistantMessage('a1'), text: 'one\ntwo' }])} />,
    );
    const entry = container.querySelector('p.pre');
    expect(entry?.textContent).toBe('one\ntwo');
    expect(entry?.getAttribute('class')).toContain('pre');
  });
});
