import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { WorkPanes, linesAt } from '../../src/components/WorkPanes';
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
  return <WorkPanes work={work} notes={[]} live={false} queued={0} onNote={() => undefined} {...overrides} />;
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

  it('sends a comment on the line right-clicked', async () => {
    const onNote = vi.fn();
    render(panes({ onNote }));
    fireEvent.contextMenu(screen.getByText(/pop\(0\)/));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Comment' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Comment' }), 'Is this O(n)?');
    await userEvent.click(screen.getByRole('button', { name: 'Send to chat' }));
    expect(onNote).toHaveBeenCalledWith({
      change: 'a1/c1',
      path: 'c.py',
      kind: 'comment',
      code: 'pop(0)',
      text: 'Is this O(n)?',
      first: 1,
      last: 1,
    });
  });

  it('wants words for a comment but not for a rejection', async () => {
    render(panes());
    fireEvent.contextMenu(screen.getByText(/pop\(0\)/));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Comment' }));
    expect((screen.getByRole('button', { name: 'Send to chat' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.contextMenu(screen.getByText(/pop\(0\)/));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reject' }));
    expect((screen.getByRole('button', { name: 'Send to chat' }) as HTMLButtonElement).disabled).toBe(false);
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

describe('linesAt', () => {
  it('takes the highlighted range inside the change', () => {
    render(panes());
    const first = screen.getByText(/pop\(\)/);
    const second = screen.getByText(/pop\(0\)/);
    const selection = { isCollapsed: false, anchorNode: second, focusNode: first } as unknown as Selection;
    expect(linesAt(second, selection, change)).toMatchObject({ first: 0, last: 1 });
  });

  it('falls back to the line clicked, and finds nothing outside the code', () => {
    render(panes());
    const line = screen.getByText(/pop\(0\)/);
    expect(linesAt(line, null, change)).toMatchObject({ first: 1, last: 1 });
    expect(linesAt(document.body, null, change)).toBeNull();
  });
});
