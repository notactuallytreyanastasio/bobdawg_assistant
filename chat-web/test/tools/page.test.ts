import { describe, expect, it, vi } from 'vitest';
import { emptyReport } from '../../src/artifact/protocol';
import type { ArtifactRunner, RunReport } from '../../src/artifact/protocol';
import type { ChatMessage } from '../../src/chat/message';
import { pageTool } from '../../src/tools/page';
import { plotAssistant } from '../../src/tools/assistant';

const drawn: RunReport = { ...emptyReport, nodes: 12, bbox: { w: 600, h: 400 } };

function context() {
  return { callId: 'c1', messages: [] as readonly ChatMessage[], signal: new AbortController().signal };
}

describe('pageTool', () => {
  it('runs the markup as code, held to what a page has to do and not to a chart', async () => {
    const runner = vi.fn<ArtifactRunner>(async () => drawn);
    const result = await pageTool(runner).run({ title: 'Loaves', html: '<h1>Hi</h1>', code: 'draw()' }, context());

    const input = runner.mock.calls[0]?.[0];
    expect(input?.drawing).toBe('page');
    expect(input?.code).toBe('// title: Loaves\nroot.innerHTML = "<h1>Hi</h1>";\ndraw()');
    expect(result.ok).toBe(true);
    expect(result.text.split('\n')[0]).toBe('ok: drew a page of 12 elements');
    expect(result.text).toContain('Stop now and describe the page');
  });

  it('still fails a page that threw or drew nothing', async () => {
    const threw = { ...drawn, errors: [{ message: '<markup> is not available', line: 2, source: null }] };
    const tool = pageTool(async () => threw);
    expect((await tool.run({ title: 't', html: '<a href=x>', code: '' }, context())).ok).toBe(false);
    const empty = pageTool(async () => emptyReport);
    expect((await empty.run({ title: 't', html: '<p>' }, context())).ok).toBe(false);
  });

  it('answers a call missing its markup without running anything', async () => {
    const runner = vi.fn<ArtifactRunner>(async () => drawn);
    const result = await pageTool(runner).run({ title: 't', html: ' ' }, context());
    expect(result.ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('sits beside plot in the assistant', () => {
    const names = plotAssistant(async () => drawn).tools.map((tool) => tool.name);
    expect(names).toEqual(['plot', 'page']);
  });
});
