import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Artifact } from '../../src/chat/artifact';
import { ArtifactPanel } from '../../src/components/ArtifactPanel';
import type { ArtifactPanelProps } from '../../src/components/ArtifactPanel';

const FULL_SCREEN_PANEL_WIDTH = 1100;
// The test runner empties css imports, so the rules are read from the file.
const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/styles.css'), 'utf8');

const NOTICE =
  'Written by the model and running in a sandbox. Do not type anything private into it. Running without errors does not make the numbers right, so check them against your data.';

const artifact: Artifact = {
  key: 'a1/c1',
  callId: 'c1',
  title: 'Loaves <b>',
  code: '// title: Loaves\ndraw()',
  messages: ['abcd'],
  withheld: 0,
  status: 'ok',
  detail: 'ok',
};

function props(overrides: Partial<ArtifactPanelProps> = {}): ArtifactPanelProps {
  return {
    slot: createRef<HTMLDivElement>(),
    artifact,
    position: { index: 0, count: 1 },
    tab: 'preview',
    checking: false,
    live: false,
    ended: null,
    full: false,
    busy: false,
    onTab: vi.fn(),
    onRun: vi.fn(),
    onStop: vi.fn(),
    onClose: vi.fn(),
    onFull: vi.fn(),
    onStep: vi.fn(),
    onShare: vi.fn(),
    ...overrides,
  };
}

function panel(container: HTMLElement): Element {
  const found = container.querySelector('.panel');
  if (found === null) throw new Error('no panel');
  return found;
}

describe('ArtifactPanel', () => {
  it('always renders the notice, the slot and the shell, even with nothing open', () => {
    const { container } = render(<ArtifactPanel {...props({ artifact: null, position: { index: -1, count: 0 } })} />);
    expect(screen.getByText(NOTICE).textContent).toBe(NOTICE);
    expect(container.querySelector('.slot')).not.toBeNull();
    expect(panel(container).className).toBe('panel');
  });

  it('moves between checking, open and full by class alone, on the same nodes', () => {
    const shape = props();
    const view = render(<ArtifactPanel {...shape} checking />);
    const shell = panel(view.container);
    const slot = view.container.querySelector('.slot');
    expect(shell.className).toBe('panel checking');
    view.rerender(<ArtifactPanel {...shape} />);
    expect(shell.className).toBe('panel open');
    view.rerender(<ArtifactPanel {...shape} full />);
    expect(shell.className).toBe('panel open full');
    expect(panel(view.container)).toBe(shell);
    expect(view.container.querySelector('.slot')).toBe(slot);
  });

  it('keeps React out of the slot, so a frame there survives a render', () => {
    const shape = props();
    const view = render(<ArtifactPanel {...shape} live />);
    const slot = view.container.querySelector('.slot');
    const frame = document.createElement('iframe');
    slot?.appendChild(frame);
    view.rerender(<ArtifactPanel {...shape} live full />);
    view.rerender(<ArtifactPanel {...shape} live tab="code" />);
    expect(frame.parentElement).toBe(slot);
  });

  it('shows the title and code as text', () => {
    const view = render(<ArtifactPanel {...props({ tab: 'code' })} />);
    expect(screen.getByText('Loaves <b>').tagName).toBe('B');
    expect(view.container.querySelector('pre')?.textContent).toBe(artifact.code);
    expect(view.container.querySelector('.panel-title b b')).toBeNull();
  });

  it('never claims more than that it ran without errors', () => {
    const view = render(<ArtifactPanel {...props()} />);
    expect(view.container.textContent).toContain('Ran without errors');
    expect(view.container.textContent?.toLowerCase()).not.toContain('safe');
  });

  it('offers the Run placeholder when no frame is up, with the risk beside it', async () => {
    const user = userEvent.setup();
    const shape = props();
    render(<ArtifactPanel {...shape} />);
    screen.getByText(/This code will run with the 4 characters/);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(shape.onRun).toHaveBeenCalledOnce();
  });

  it('says on the placeholder what was sent with Plot off', () => {
    render(<ArtifactPanel {...props({ artifact: { ...artifact, withheld: 1 } })} />);
    screen.getByText(/Your earlier message sent with Plot off is not given to the chart/);
  });

  it('hides the placeholder while a frame is up', () => {
    render(<ArtifactPanel {...props({ live: true })} />);
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
  });

  it('refuses to run by hand while a turn holds the frame', () => {
    render(<ArtifactPanel {...props({ busy: true })} />);
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('wires its buttons', async () => {
    const user = userEvent.setup();
    const shape = props({ live: true, position: { index: 1, count: 3 } });
    render(<ArtifactPanel {...shape} />);
    await user.click(screen.getByRole('button', { name: 'Code' }));
    expect(shape.onTab).toHaveBeenCalledWith('code');
    await user.click(screen.getByRole('button', { name: 'Previous attempt' }));
    expect(shape.onStep).toHaveBeenCalledWith(-1);
    await user.click(screen.getByRole('button', { name: 'Next attempt' }));
    expect(shape.onStep).toHaveBeenCalledWith(1);
    await user.click(screen.getByRole('button', { name: 'Full view' }));
    expect(shape.onFull).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole('button', { name: 'Stop the chart' }));
    expect(shape.onStop).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Close the chart' }));
    expect(shape.onClose).toHaveBeenCalledOnce();
  });

  it('cannot step past either end, or stop what is not running', () => {
    render(<ArtifactPanel {...props()} />);
    const disabled = (name: string) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
    expect(disabled('Previous attempt')).toBe(true);
    expect(disabled('Next attempt')).toBe(true);
    expect(disabled('Stop the chart')).toBe(true);
  });

  it('says a chart left the page, and how others ended', () => {
    const view = render(<ArtifactPanel {...props({ ended: 'blocked' })} />);
    screen.getByText('This chart tried to leave the page and was stopped. It may have reached the network by DNS.');
    view.rerender(<ArtifactPanel {...props({ ended: 'hidden' })} />);
    screen.getByText('This chart was stopped while the tab was hidden.');
  });
});

describe('how the panel sits beside the chat', () => {
  function rulesAt(width: number): string {
    const found = new RegExp(`@media \\(max-width: ${width}px\\) \\{([\\s\\S]*?)\\n\\}`).exec(styles);
    return found?.[1] ?? '';
  }

  // At 820 pixels the chat was left about 170 wide, and the Plot toggle was cut off.
  it('takes the whole screen on a tablet, where the sidebar leaves no room for both', () => {
    expect(rulesAt(FULL_SCREEN_PANEL_WIDTH)).toContain('.panel.open');
    expect(FULL_SCREEN_PANEL_WIDTH).toBeGreaterThanOrEqual(1100);
    expect(rulesAt(800)).not.toContain('.panel.open');
  });
});
