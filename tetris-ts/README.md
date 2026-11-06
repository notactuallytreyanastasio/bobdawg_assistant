# Tetris

A Tetris game written in pure TypeScript with no build step: Node's type
stripping runs the source directly, and `node --test` is the test runner.

```
npm test      # the test suite
npm run check # type check, then the test suite
npm run play  # play in the terminal
```

Requires Node 26 or later for type stripping. There are no runtime
dependencies.

## Keys

| Key              | Action                                              |
| ---------------- | --------------------------------------------------- |
| Left, Right      | move one column, refused into an occupied column      |
| Down             | soft drop, one row, one point                        |
| Space            | hard drop, two points per row, then lock             |
| Up, x            | rotate clockwise                                    |
| z                | rotate counter-clockwise                            |
| c, h             | hold, once per piece                                 |
| q, Ctrl-C        | quit                                                |

A held key repeats at the terminal's own rate; the game adds no auto-repeat of
its own.

## The frame

The field is the standard ten columns by twenty rows plus two hidden rows above
it, drawn as fixed-size text: a framed field with the ghost piece shown where a
hard drop would land, and a panel with the next seven pieces, the hold slot,
score, level, lines and combo streak. A gravity step is one row, and the
interval comes from the level.

The frame needs a terminal that supports raw mode and at least 41 columns by 24
rows. It is drawn with block glyphs and box-drawing borders, with no colour.
Resizing the window does not rebuild the frame.

## Rules

Rotation follows the Super Rotation System, with one quarter turn per action and
the kick table applied to the published offsets. A piece locks on the tick after
it can no longer fall; there is no lock delay and no slide reset. The game ends
when a new piece has nowhere to spawn, or when a piece locks entirely inside the
hidden rows.

Scoring is one hundred, three hundred, five hundred or eight hundred times the
level for one, two, three or four rows, plus one point per soft-drop row, two
points per hard-drop row and fifty times the combo streak times the level. The
level rises every forty cleared lines up to level fifteen, and the gravity
interval shrinks by fifteen percent per level down to a floor of fifty
milliseconds.

## Not implemented

These are deliberate gaps, each held in the decision graph with its reason:

- no restart or pause key after a game ends
- no back-to-back bonus and no spawn animation
- no lock delay or slide reset
- no colour and no resize handling
- no auto-repeat of a held key
