import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useStickToBottom } from '../../src/hooks/useStickToBottom';

function View({ growth, turn }: { growth: number; turn: number }) {
  const view = useStickToBottom(growth, turn);
  return (
    <div>
      <div data-testid="scroller" ref={view.scroller} onScroll={view.onScroll} />
      <button type="button" onClick={view.jump}>
        {view.pinned ? 'pinned' : 'free'}
      </button>
    </div>
  );
}

function measure(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true });
}

function scrollTo(element: HTMLElement, top: number): void {
  act(() => {
    element.scrollTop = top;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

describe('useStickToBottom', () => {
  it('follows new text while at the bottom', () => {
    const view = render(<View growth={0} turn={0} />);
    const scroller = screen.getByTestId('scroller');
    measure(scroller, 1000, 300);

    view.rerender(<View growth={1} turn={0} />);

    expect(scroller.scrollTop).toBe(1000);
  });

  it('lets go when the reader scrolls up, and leaves them there', () => {
    const view = render(<View growth={0} turn={0} />);
    const scroller = screen.getByTestId('scroller');
    measure(scroller, 1000, 300);

    scrollTo(scroller, 100);
    view.rerender(<View growth={1} turn={0} />);

    expect(scroller.scrollTop).toBe(100);
    expect(screen.getByRole('button').textContent).toBe('free');
  });

  it('holds on again at a new question', () => {
    const view = render(<View growth={0} turn={0} />);
    const scroller = screen.getByTestId('scroller');
    measure(scroller, 1000, 300);
    scrollTo(scroller, 100);

    view.rerender(<View growth={0} turn={1} />);

    expect(scroller.scrollTop).toBe(1000);
    expect(screen.getByRole('button').textContent).toBe('pinned');
  });

  it('holds on again from the jump button', () => {
    render(<View growth={0} turn={0} />);
    const scroller = screen.getByTestId('scroller');
    measure(scroller, 1000, 300);
    scrollTo(scroller, 100);

    act(() => screen.getByRole('button').click());

    expect(scroller.scrollTop).toBe(1000);
  });
});
