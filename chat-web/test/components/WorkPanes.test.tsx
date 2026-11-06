import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { WorkPanes, linesOfSelection, paneWidths } from '../../src/components/WorkPanes';
import type { WorkPanesProps } from '../../src/components/WorkPanes';
import type { Change, Work } from '../../src/chat/work';

const change: Change = {
  key: 'a1/c1',
  thought: 'a1',
  path: 'c.py',
  whole: false,
  lines: [
    { kind: 'del', text: 'pop()' },
    { kind: 'add', text: 'pop(0)' },
  ],
  why: 'The pop takes the newest key.',
  goal: 'Fix the cache.',
  ok: true,
};
const work: Work = {
  thoughts: [{ key: 'a1', title: 'Eviction is wrong.', text: 'Eviction is wrong.', did: ['edit c.py'], changes: ['a1/c1'] }],
  changes: [change],
};

function panes(overrides: Partial<WorkPanesProps> = {}) {
  return (
    <WorkPanes
      work={work}
      notes={[]}
      live={false}
      queued={0}
      sizes={{ thinking: null, chat: null }}
      onSizes={() => undefined}
      onNote={() => undefined}
      {...overrides}
    />
  );
}

function highlight(from: RegExp, to: RegExp): void {
  const start = screen.getByText(from);
  const end = screen.getByText(to);
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.childNodes.length);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.pointerUp(document);
}

describe('WorkPanes', () => {
  it('shows each change with the reason the model gave', () => {
    render(panes());
    expect(screen.getByText('The pop takes the newest key.').textContent).toContain('newest');
    expect(screen.getByText('Led to a change').textContent).toBe('Led to a change');
    expect(screen.getByText('Accepted unless you object').textContent).toContain('Accepted');
  });

  it('says so when nothing has changed', () => {
    render(panes({ work: { thoughts: [], changes: [] } }));
    expect(screen.getByText(/Nothing changed yet/).textContent).toContain('Edits appear');
  });

  it('opens a box on a highlight, and sends what is written there', async () => {
    const onNote = vi.fn();
    render(panes({ onNote }));
    highlight(/pop\(\)/, /pop\(0\)/);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Your note' }), 'Is this O(n)?');
    await userEvent.click(screen.getByRole('button', { name: 'Send to chat' }));
    expect(onNote).toHaveBeenCalledWith({
      change: 'a1/c1',
      path: 'c.py',
      kind: 'comment',
      code: 'pop()\npop(0)',
      text: 'Is this O(n)?',
      first: 0,
      last: 1,
    });
    expect(screen.queryByRole('textbox', { name: 'Your note' })).toBeNull();
  });

  it('rejects with no words needed, but will not send an empty note', async () => {
    const onNote = vi.fn();
    render(panes({ onNote }));
    highlight(/pop\(0\)/, /pop\(0\)/);
    await screen.findByRole('textbox', { name: 'Your note' });
    expect((screen.getByRole('button', { name: 'Send to chat' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onNote).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reject', text: '', code: 'pop(0)' }));
  });

  it('opens nothing for a click or a highlight outside the code', async () => {
    render(panes());
    fireEvent.pointerUp(document);
    highlight(/The pop takes/, /The pop takes/);
    await new Promise((done) => setTimeout(done, 5));
    expect(screen.queryByRole('textbox', { name: 'Your note' })).toBeNull();
  });

  it('keeps a note on its lines, and strikes rejected ones', () => {
    const note = { id: 'n', change: 'a1/c1', path: 'c.py', kind: 'reject', code: 'pop(0)', text: 'Keep it.', first: 1, last: 1 } as const;
    render(panes({ notes: [note] }));
    expect(screen.getByText('Keep it.').textContent).toContain('Keep it.');
    expect(screen.getByText(/pop\(0\)/).className).toContain('struck');
  });

  it('says when notes are waiting for the turn', () => {
    render(panes({ queued: 2 }));
    expect(screen.getByText('2 notes waiting for this turn to end').textContent).toContain('2 notes');
  });
});

describe('resizing', () => {
  it('follows a drag until the button comes up', () => {
    const onSizes = vi.fn();
    render(panes({ onSizes }));
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize the thinking pane' }));
    act(() => {
      dispatchEvent(new MouseEvent('pointermove', { clientX: 333 }));
      dispatchEvent(new MouseEvent('pointerup'));
      dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }));
    });
    expect(onSizes).toHaveBeenCalledTimes(1);
    expect(onSizes).toHaveBeenCalledWith({ thinking: 333, chat: null });
  });

  it('moves with the arrow keys, and resets on a double click', () => {
    const onSizes = vi.fn();
    render(panes({ onSizes, sizes: { thinking: 300, chat: 400 } }));
    const bar = screen.getByRole('separator', { name: 'Resize the chat' });
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(onSizes).toHaveBeenLastCalledWith({ thinking: 300, chat: 24 });
    fireEvent.doubleClick(bar);
    expect(onSizes).toHaveBeenLastCalledWith({ thinking: 300, chat: null });
  });

  it('sets only the widths the reader chose', () => {
    expect(paneWidths({ thinking: null, chat: null })).toBeUndefined();
    expect(paneWidths({ thinking: 310, chat: null })).toEqual({ '--work-thinking': '310px' });
  });
});

describe('linesOfSelection', () => {
  it('finds nothing without a highlight', () => {
    expect(linesOfSelection(null, [change])).toBeNull();
    expect(linesOfSelection(getSelection(), [change])).toBeNull();
  });
});
