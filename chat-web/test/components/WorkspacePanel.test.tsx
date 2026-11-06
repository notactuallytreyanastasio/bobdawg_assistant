import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { WorkspacePanel, parseTree } from '../../src/components/WorkspacePanel';
import type { WorkspacePanelProps } from '../../src/components/WorkspacePanel';

function panel(run: WorkspacePanelProps['run'], overrides: Partial<WorkspacePanelProps> = {}) {
  return <WorkspacePanel open version="1" busy={false} run={run} onClose={() => undefined} {...overrides} />;
}

const fake: WorkspacePanelProps['run'] = async (tool, args) => {
  if (tool === 'tree') return { ok: true, text: 'a.py\t12\nsub/b.txt\t2048' };
  if (tool === 'read') return { ok: true, text: `<b>body of ${String(args['path'])}</b>` };
  return { ok: true, text: 'the workspace is back' };
};

describe('parseTree', () => {
  it('reads paths and sizes, and skips blank lines', () => {
    expect(parseTree('a\t1\n\nb c\tnope')).toEqual([
      { path: 'a', size: 1 },
      { path: 'b c', size: 0 },
    ]);
  });
});

describe('WorkspacePanel', () => {
  it('lists the files when open, and asks for nothing when shut', async () => {
    const run = vi.fn(fake);
    const view = render(panel(run, { open: false }));
    expect(run).not.toHaveBeenCalled();
    view.rerender(panel(run));
    expect((await screen.findByText('sub/b.txt')).textContent).toBe('sub/b.txt');
    expect(screen.getByText('2 KB').textContent).toBe('2 KB');
  });

  it('shows a file as text, never as markup', async () => {
    const user = userEvent.setup();
    const { container } = render(panel(fake));
    await user.click(await screen.findByText('a.py'));
    expect((await screen.findByText('<b>body of a.py</b>')).textContent).toBe('<b>body of a.py</b>');
    expect(container.querySelector('pre b')).toBeNull();
  });

  it('undoes, says so, and reloads', async () => {
    const user = userEvent.setup();
    const run = vi.fn(fake);
    render(panel(run));
    await user.click(screen.getByRole('button', { name: 'Undo last turn' }));
    expect((await screen.findByRole('status')).textContent).toContain('back');
    expect(run).toHaveBeenCalledWith('restore', {});
    await waitFor(() => expect(run.mock.calls.filter(([tool]) => tool === 'tree').length).toBeGreaterThan(1));
  });

  it('will not undo under a running turn', () => {
    render(panel(fake, { busy: true }));
    expect((screen.getByRole('button', { name: 'Undo last turn' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says why when the sandbox cannot answer', async () => {
    render(panel(async () => ({ ok: false, text: 'no workspaces here' })));
    expect((await screen.findByRole('status')).textContent).toBe('no workspaces here');
  });
});
