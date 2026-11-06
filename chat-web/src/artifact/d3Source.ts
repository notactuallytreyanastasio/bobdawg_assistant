// D3 as text, to be written into each frame. It ships in the build because a frame has no
// network, and it is only fetched from the page's own origin the first time a chart runs.

export async function loadD3(): Promise<string> {
  // By path, because the package's exports do not name its dist files.
  const source = await import('../../node_modules/d3/dist/d3.min.js?raw');
  return source.default;
}
