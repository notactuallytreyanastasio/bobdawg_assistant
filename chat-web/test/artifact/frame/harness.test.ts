import { describe, expect, it } from 'vitest';
import source from '../../../src/artifact/frame/harness.js?raw';
import { ERRORS_KEPT, HEARTBEAT_MS, LOGS_KEPT, REPORT_TEXT_CHARS, SETTLE_MS } from '../../../src/artifact/limits';

const SVG = 'http://www.w3.org/2000/svg';

type Shape = { readonly tag: string; readonly d?: string; readonly className?: string };

type SvgSize = Readonly<Record<string, string>>;

// The harness run for real against the test's document, up to its report. jsdom has no layout,
// so every shape is given a size, and the clock runs what it is handed straight away.
function marksOf(shapes: readonly Shape[], size: SvgSize = {}): unknown {
  document.body.innerHTML = '<div id="root"></div>';
  const svg = document.createElementNS(SVG, 'svg');
  for (const [name, value] of Object.entries(size)) svg.setAttribute(name, value);
  Object.assign(svg, { getBBox: () => ({ width: 9, height: 9 }) });
  for (const { tag, d, className } of shapes) {
    const shape = document.createElementNS(SVG, tag);
    if (d !== undefined) shape.setAttribute('d', d);
    if (className !== undefined) shape.setAttribute('class', className);
    Object.assign(shape, { getBBox: () => ({ width: 9, height: 9 }) });
    svg.appendChild(shape);
  }
  document.getElementById('root')?.appendChild(svg);
  const sent: { readonly kind: string; readonly marks?: unknown }[] = [];
  const handlers = new Map<string, () => void>();
  const frame = new Function(
    'parent',
    'setTimeout',
    'setInterval',
    'ResizeObserver',
    'addEventListener',
    'console',
    source,
  );
  frame(
    { postMessage: (message: { kind: string }) => sent.push(message) },
    (run: () => void) => run(),
    () => 0,
    class {
      observe(): void {}
    },
    (name: string, run: () => void) => handlers.set(name, run),
    { log() {}, error() {} },
  );
  handlers.get('load')?.();
  return sent.find((message) => message.kind === 'report')?.marks;
}

describe('what the harness counts as data marks', () => {
  it('counts a line by its segments, because a line is one path', () => {
    expect(marksOf([{ tag: 'path', d: 'M0,0L1,1L2,2L3,3L4,4' }])).toBe(4);
  });

  it('counts a curve the same way', () => {
    expect(marksOf([{ tag: 'path', d: 'M0,0C1,1,2,2,3,3C4,4,5,5,6,6C7,7,8,8,9,9' }])).toBe(3);
  });

  it('counts a slice of a pie as one', () => {
    expect(marksOf([{ tag: 'path', d: 'M0,-9A9,9,0,1,1,0,9Z' }])).toBe(1);
  });

  it('counts each bar as one, and an axis as none', () => {
    expect(marksOf([{ tag: 'rect' }, { tag: 'rect' }, { tag: 'path', d: 'M0,0L9,0', className: 'domain' }])).toBe(2);
  });
});

describe('what the harness does for an svg with no viewBox', () => {
  function viewBoxOf(size: SvgSize): string | null | undefined {
    marksOf([{ tag: 'rect' }], size);
    return document.querySelector('svg')?.getAttribute('viewBox');
  }

  it('gives it one from its size, so it can shrink to fit rather than be cut off', () => {
    expect(viewBoxOf({ width: '640', height: '416' })).toBe('0 0 640 416');
  });

  it('leaves one the code set', () => {
    expect(viewBoxOf({ width: '640', height: '416', viewBox: '0 0 10 10' })).toBe('0 0 10 10');
  });

  it('leaves a size that is not a number of pixels', () => {
    expect(viewBoxOf({ width: '100%', height: '416' })).toBeNull();
    expect(viewBoxOf({})).toBeNull();
  });
});

describe('harness', () => {
  it('parses', () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it('keeps the same numbers as the page', () => {
    expect(source).toContain(`var HEARTBEAT_MS = ${HEARTBEAT_MS};`);
    expect(source).toContain(`var SETTLE_MS = ${SETTLE_MS};`);
    expect(source).toContain(`var ERRORS_KEPT = ${ERRORS_KEPT};`);
    expect(source).toContain(`var LOGS_KEPT = ${LOGS_KEPT};`);
    expect(source).toContain(`var REPORT_TEXT_CHARS = ${REPORT_TEXT_CHARS};`);
  });

  it('captures its tools before any listener is set', () => {
    const first = source.indexOf("addEventListener('");
    for (const capture of ['var post = target.postMessage', 'var later = setTimeout', 'var every = setInterval']) {
      expect(source.indexOf(capture)).toBeGreaterThanOrEqual(0);
      expect(source.indexOf(capture)).toBeLessThan(first);
    }
  });

  it('measures the root, never the document', () => {
    expect(source).toContain('root.getBoundingClientRect().height');
    expect(source).not.toContain('document' + 'Element.scrollHeight');
  });

  it('never reports the address a violation carried', () => {
    expect(source).not.toContain('blocked' + 'URI');
  });

  it('counts neither axes nor shapes with no size as data marks', () => {
    expect(source).toContain("var NOT_DATA = '.tick,.domain,");
    expect(source).toContain('hasSize(element)');
    expect(source).toContain('marks: markCount()');
  });

  it('holds no closing script tag', () => {
    expect(source).not.toContain('</script');
    expect(source).not.toContain('<!--');
  });
});
