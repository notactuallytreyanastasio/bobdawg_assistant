import { describe, expect, it } from 'vitest';
import { CARD_HEIGHT, COLUMN, ROW, layoutTree } from '../../src/graph/layout';

const leaf = (id: string) => ({ id, children: [] });
const tree = { id: 'a', children: [{ id: 'b', children: [leaf('d')] }, leaf('c')] };
const at = (layout: ReturnType<typeof layoutTree>, id: string) => layout.placed.find((node) => node.id === id);

describe('layoutTree', () => {
  it('gives each leaf a row and centres a parent on its children', () => {
    const layout = layoutTree(tree, new Set());
    expect(at(layout, 'd')).toMatchObject({ x: COLUMN * 2, y: 0 });
    expect(at(layout, 'c')).toMatchObject({ x: COLUMN, y: ROW });
    expect(at(layout, 'a')?.y).toBe(ROW / 2);
    expect(layout.height).toBe(ROW * 2);
  });

  it('starts a link at its parent’s final height', () => {
    const link = layoutTree(tree, new Set()).links.find((entry) => entry.to === 'c');
    expect(link?.path.startsWith(`M248 ${ROW / 2 + CARD_HEIGHT / 2} `)).toBe(true);
  });

  it('folds a branch away and counts what it hid', () => {
    const layout = layoutTree(tree, new Set(['b']));
    expect(at(layout, 'd')).toBeUndefined();
    expect(at(layout, 'b')?.hidden).toBe(1);
    expect(layout.links.some((entry) => entry.to === 'd')).toBe(false);
  });
});
