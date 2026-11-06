// Following a growing transcript without fighting the reader. The view stays on the newest
// text while it is at the bottom; scrolling up lets go, and it takes a new question or the
// jump button to hold on again.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

// Near enough to count as the bottom: a trackpad rarely lands on the exact pixel.
const SLACK = 48;

export type StickToBottom = {
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly content: RefObject<HTMLDivElement | null>;
  readonly pinned: boolean;
  readonly onScroll: () => void;
  readonly jump: () => void;
};

export function useStickToBottom(growth: unknown, newTurn: unknown): StickToBottom {
  const scroller = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const held = useRef(true);
  const [pinned, setPinned] = useState(true);

  const hold = useCallback((value: boolean) => {
    held.current = value;
    setPinned(value);
  }, []);

  const follow = useCallback(() => {
    const element = scroller.current;
    if (element !== null && held.current) element.scrollTop = element.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    hold(element.scrollHeight - element.scrollTop - element.clientHeight <= SLACK);
  }, [hold]);

  const jump = useCallback(() => {
    hold(true);
    follow();
  }, [hold, follow]);

  useLayoutEffect(() => {
    hold(true);
    follow();
  }, [newTurn, hold, follow]);

  useLayoutEffect(follow, [growth, follow]);

  // Markdown settles a little after the text does, and a fold can open: the content's own
  // size is the signal that covers both. Not every environment has the observer.
  useEffect(() => {
    const element = content.current;
    if (element === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [follow]);

  return { scroller, content, pinned, onScroll, jump };
}
