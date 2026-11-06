// A tree laid out left to right: depth across, and each leaf on a row of its own, with a parent
// centred on its children. Plain arithmetic, so the shape can be tested without a browser.

import type { TreeNode } from './model';

export const COLUMN = 300;
export const ROW = 62;
export const CARD_WIDTH = 248;
export const CARD_HEIGHT = 48;

export type Placed = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly hidden: number;
};

export type Link = {
  readonly from: string;
  readonly to: string;
  readonly path: string;
};

export type Layout = {
  readonly placed: readonly Placed[];
  readonly links: readonly Link[];
  readonly width: number;
  readonly height: number;
};

function countUnder(node: TreeNode): number {
  return node.children.reduce((total, child) => total + 1 + countUnder(child), 0);
}

export function layoutTree(tree: TreeNode, folded: ReadonlySet<string>): Layout {
  const placed: Placed[] = [];
  const links: Link[] = [];
  let row = 0;
  let deepest = 0;

  const place = (node: TreeNode, depth: number): number => {
    deepest = Math.max(deepest, depth);
    const x = depth * COLUMN;
    const shut = folded.has(node.id);
    const shown = shut ? [] : node.children;
    let y: number;
    if (shown.length === 0) {
      y = row * ROW;
      row += 1;
    } else {
      const ys = shown.map((child) => {
        const childY = place(child, depth + 1);
        const midX = x + CARD_WIDTH + (COLUMN - CARD_WIDTH) / 2;
        const startY = 0;
        links.push({
          from: node.id,
          to: child.id,
          path: `${x + CARD_WIDTH} ${startY} ${midX} ${childY + CARD_HEIGHT / 2} ${x + COLUMN} ${childY + CARD_HEIGHT / 2}`,
        });
        return childY;
      });
      y = ((ys[0] ?? 0) + (ys.at(-1) ?? 0)) / 2;
    }
    placed.push({ id: node.id, x, y, hidden: shut ? countUnder(node) : 0 });
    return y;
  };
  place(tree, 0);

  // A link can only start from its parent's height once that is known, which is after its
  // children are placed.
  const heightOf = new Map(placed.map((node) => [node.id, node.y]));
  const drawn = links.map((link) => {
    const [startX, , midX, endY, endX] = link.path.split(' ');
    const startY = (heightOf.get(link.from) ?? 0) + CARD_HEIGHT / 2;
    return { ...link, path: `M${startX} ${startY} C${midX} ${startY} ${midX} ${endY} ${endX} ${endY}` };
  });
  return {
    placed,
    links: drawn,
    width: deepest * COLUMN + CARD_WIDTH,
    height: Math.max(row, 1) * ROW,
  };
}
