import { describe, expect, it } from 'vitest';
import { TOOL_RESULT_CHARS } from '../../src/artifact/limits';
import { roundLine, runToolCall, toWireTools } from '../../src/tools/tool';
import type { ToolContext, ToolDefinition } from '../../src/tools/tool';

function context(signal = new AbortController().signal): ToolContext {
  return { callId: 'c1', messages: [], signal };
}

function tool(run: ToolDefinition['run'], name = 'plot'): ToolDefinition {
  return { name, description: 'draws', parameters: { type: 'object' }, run };
}

const call = (args: string, name = 'plot') => ({ id: 'c1', name, arguments: args });

describe('runToolCall', () => {
  it('hands the parsed arguments to the tool and returns its result', async () => {
    const seen: unknown[] = [];
    const echo = tool(async (args) => {
      seen.push(args);
      return { ok: true, text: 'drawn' };
    });
    await expect(runToolCall([echo], call('{"code":"x"}'), context())).resolves.toEqual({ ok: true, text: 'drawn' });
    expect(seen).toEqual([{ code: 'x' }]);
  });

  it('keeps fatal', async () => {
    const fatal = tool(async () => ({ ok: false, text: 'left', fatal: true }));
    await expect(runToolCall([fatal], call('{}'), context())).resolves.toMatchObject({ fatal: true });
  });

  it('answers arguments that are not JSON', async () => {
    const result = await runToolCall([tool(async () => ({ ok: true, text: 'x' }))], call('{oops'), context());
    expect(result.ok).toBe(false);
    expect(result.text).toContain('JSON');
  });

  it('answers arguments that are JSON but not an object', async () => {
    const result = await runToolCall([tool(async () => ({ ok: true, text: 'x' }))], call('[1]'), context());
    expect(result.ok).toBe(false);
  });

  it('names the tools there are when the name is unknown', async () => {
    const result = await runToolCall([tool(async () => ({ ok: true, text: 'x' }))], call('{}', 'draw'), context());
    expect(result).toEqual({ ok: false, text: 'there is no tool called draw; the tools are: plot' });
  });

  it('turns a thrown error into a result', async () => {
    const thrower = tool(async () => {
      throw new Error('kaput');
    });
    await expect(runToolCall([thrower], call('{}'), context())).resolves.toEqual({ ok: false, text: 'kaput' });
  });

  it('turns a thrown non-error into a result', async () => {
    const thrower = tool(() => {
      throw 'just text';
    });
    await expect(runToolCall([thrower], call('{}'), context())).resolves.toEqual({ ok: false, text: 'just text' });
  });

  it('answers at once when already stopped, and never runs the tool', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const marker = tool(async () => {
      ran = true;
      return { ok: true, text: 'x' };
    });
    const result = await runToolCall([marker], call('{}'), context(controller.signal));
    expect(result).toEqual({ ok: false, text: 'stopped by the reader' });
    expect(ran).toBe(false);
  });

  it('does not wait for a tool that ignores the stop', async () => {
    const controller = new AbortController();
    const hung = tool(() => new Promise(() => undefined));
    const running = runToolCall([hung], call('{}'), context(controller.signal));
    controller.abort();
    await expect(running).resolves.toEqual({ ok: false, text: 'stopped by the reader' });
  });

  it('says stopped when a stop made the tool throw', async () => {
    const controller = new AbortController();
    const thrower = tool(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expect(runToolCall([thrower], call('{}'), context(controller.signal))).resolves.toEqual({
      ok: false,
      text: 'stopped by the reader',
    });
  });

  it('holds every result to the limit', async () => {
    const long = tool(async () => ({ ok: true, text: 'x'.repeat(TOOL_RESULT_CHARS * 2) }));
    const result = await runToolCall([long], call('{}'), context());
    const held = (text: string) => text.length < TOOL_RESULT_CHARS + 60 && text.includes('[cut here: ');
    expect(held(result.text)).toBe(true);
    const thrower = tool(async () => {
      throw new Error('y'.repeat(TOOL_RESULT_CHARS * 2));
    });
    expect(held((await runToolCall([thrower], call('{}'), context())).text)).toBe(true);
    const name = 'n'.repeat(TOOL_RESULT_CHARS * 2);
    expect(held((await runToolCall([], call('{}', name), context())).text)).toBe(true);
  });
});

describe('toWireTools', () => {
  it('is the OpenAI shape', () => {
    expect(toWireTools([tool(async () => ({ ok: true, text: '' }))])).toEqual([
      { type: 'function', function: { name: 'plot', description: 'draws', parameters: { type: 'object' } } },
    ]);
  });
});

describe('roundLine', () => {
  it('counts the rounds', () => {
    expect(roundLine(1, 5)).toBe('Round 1 of 5.');
    expect(roundLine(3, 5)).toBe('Round 3 of 5.');
  });

  it('warns on the round before the last that the next call is the last', () => {
    expect(roundLine(4, 5)).toContain('Round 4 of 5');
    expect(roundLine(4, 5)).toContain('your next call is your last');
    expect(roundLine(4, 5)).toContain('will not see its result');
  });

  it('says when none are left', () => {
    expect(roundLine(5, 5)).toBe('Round 5 of 5: no rounds left.');
  });
});
