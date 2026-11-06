/**
 * Entry point. This is the second module allowed to reach the platform, and it
 * is deliberately thin: it supplies the random source, opens the terminal,
 * keeps the current state, schedules gravity with the interval the level calls
 * for, and forwards keys to the action function. No rule lives here.
 */
import { exit } from 'node:process';

import { applyAction, createGame, gravityIntervalMs, type GameState } from './game.ts';
import { frameOf } from './render/frame.ts';
import { QUIT, type KeySignal } from './render/keys.ts';
import { openTerm, type Term } from './render/term.ts';

function randomOf(): number {
  return Math.random();
}

function play(term: Term): void {
  let state: GameState = createGame(randomOf);
  let timer: NodeJS.Timeout | null = null;

  const render = (): void => {
    term.render(frameOf(state));
  };

  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    stop();
    if (state.status === 'over') {
      return;
    }
    timer = setTimeout(tick, gravityIntervalMs(state.level));
  };

  function tick(): void {
    state = applyAction(state, 'tick', randomOf);
    render();
    schedule();
  }

  term.onKey((signal: KeySignal): void => {
    if (signal === QUIT) {
      stop();
      term.close();
      exit(0);
      return;
    }
    state = applyAction(state, signal, randomOf);
    render();
    schedule();
  });

  render();
  schedule();
}

const term = openTerm();
if (term === null) {
  exit(1);
} else {
  play(term);
}
