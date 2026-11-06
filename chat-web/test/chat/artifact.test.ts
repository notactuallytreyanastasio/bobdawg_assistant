import { describe, expect, it } from 'vitest';
import { artifactsOf, consentText, frameTexts, plotCharacters, titleOfCode } from '../../src/chat/artifact';
import { MAX_DATA_CHARS } from '../../src/artifact/limits';
import { assistantMessage, toolMessage, userMessage } from '../../src/chat/message';
import type { ChatMessage } from '../../src/chat/message';

function calling(id: string, callId: string, code: string): ChatMessage {
  return {
    ...assistantMessage(id),
    calls: [{ id: callId, name: 'plot', arguments: JSON.stringify({ code }) }],
  };
}

describe('titleOfCode', () => {
  it('reads the first title comment', () => {
    expect(titleOfCode('// title: Loaves by day\n// title: no\nd3.select(root)')).toBe('Loaves by day');
  });

  it('allows the comment below other lines', () => {
    expect(titleOfCode('const a = 1;\n   //title:   Later  \n')).toBe('Later');
  });

  it('falls back when there is none', () => {
    expect(titleOfCode('d3.select(root)')).toBe('Chart');
  });

  it('holds a title to 80 characters', () => {
    expect(titleOfCode(`// title: ${'x'.repeat(200)}`)).toHaveLength(80);
  });
});

describe('frameTexts', () => {
  const plotted = (id: string, text: string) => userMessage(id, text, true);

  it('holds only what was sent with Plot on, oldest first', () => {
    const messages = [userMessage('u1', 'private'), plotted('u2', 'one'), plotted('u3', 'two'), calling('a1', 'c1', 'x')];
    expect(frameTexts(messages, 'c1')).toEqual({ texts: ['one', 'two'], truncated: false, withheld: 1 });
  });

  it('stops at the message that holds the call', () => {
    const messages = [plotted('u1', 'one'), calling('a1', 'c1', 'x'), plotted('u2', 'two'), calling('a2', 'c2', 'x')];
    expect(frameTexts(messages, 'c1').texts).toEqual(['one']);
    expect(frameTexts(messages, 'c2').texts).toEqual(['one', 'two']);
  });

  it('takes the newest occurrence when an id repeats across turns', () => {
    const messages = [plotted('u1', 'one'), calling('a1', 'c1', 'x'), plotted('u2', 'two'), calling('a2', 'c1', 'x')];
    expect(frameTexts(messages, 'c1').texts).toEqual(['one', 'two']);
  });

  it('holds nothing for a call it cannot find', () => {
    expect(frameTexts([plotted('u1', 'one')], 'c9')).toEqual({ texts: [], truncated: false, withheld: 0 });
  });

  it('drops whole old messages to fit the cap', () => {
    const half = 'x'.repeat(MAX_DATA_CHARS / 2);
    const messages = [plotted('u1', 'gone'), plotted('u2', half), plotted('u3', half.slice(2)), calling('a1', 'c1', 'x')];
    const frame = frameTexts(messages, 'c1');
    expect(frame.texts).toHaveLength(2);
    expect(frame.truncated).toBe(true);
    expect(frame.texts.join('\n\n').length).toBeLessThanOrEqual(MAX_DATA_CHARS);
  });

  it('cuts the newest when it alone is past the cap', () => {
    const messages = [plotted('u1', 'old'), plotted('u2', 'x'.repeat(MAX_DATA_CHARS + 5)), calling('a1', 'c1', 'x')];
    const frame = frameTexts(messages, 'c1');
    expect(frame.texts).toHaveLength(1);
    expect(frame.texts[0]).toHaveLength(MAX_DATA_CHARS);
    expect(frame.truncated).toBe(true);
  });

  it('counts what the reader is told about', () => {
    expect(plotCharacters(['ab', 'cd'])).toBe(6);
    expect(plotCharacters([])).toBe(0);
  });
});

describe('what a chart was not given', () => {
  it('counts the earlier questions sent with Plot off, and only those before the call', () => {
    const messages = [
      userMessage('u1', 'tickets per team'),
      userMessage('u2', 'plot that', true),
      calling('a1', 'c1', 'x'),
      toolMessage('t1', 'c1', true, 'ok'),
      userMessage('u3', 'later'),
    ];
    expect(frameTexts(messages, 'c1').withheld).toBe(1);
    expect(artifactsOf(messages)[0]?.withheld).toBe(1);
  });
});

describe('consentText', () => {
  it('names the size and the risk', () => {
    expect(consentText(42)).toBe(
      'This code will run with the 42 characters you sent with Plot on. A hostile chart could leak that text through DNS, which this page cannot stop.',
    );
  });

  it('says what was left out, and that the model can still copy it', () => {
    expect(consentText(9, 1)).toBe(
      'This code will run with the 9 characters you sent with Plot on. Your earlier message sent with Plot off is not given to the chart, though the model can copy what it read into its code. A hostile chart could leak that text through DNS, which this page cannot stop.',
    );
    expect(consentText(9, 3)).toContain('Your 3 earlier messages sent with Plot off are not given to the chart');
  });
});

describe('artifactsOf', () => {
  const asked = userMessage('u1', 'data', true);

  it('reads title, code, texts and status from a finished call', () => {
    const list = artifactsOf([asked, calling('a1', 'c1', '// title: One\nx'), toolMessage('t1', 'c1', true, 'ok: drew')]);
    expect(list).toEqual([
      {
        key: 'a1/c1',
        callId: 'c1',
        title: 'One',
        code: '// title: One\nx',
        messages: ['data'],
        withheld: 0,
        status: 'ok',
        detail: 'ok: drew',
      },
    ]);
  });

  it('says a failed call failed and an unanswered one is unchecked', () => {
    const failed = artifactsOf([asked, calling('a1', 'c1', 'x'), toolMessage('t1', 'c1', false, 'boom')]);
    expect(failed[0]).toMatchObject({ status: 'failed', detail: 'boom' });
    expect(artifactsOf([asked, calling('a1', 'c1', 'x')])[0]).toMatchObject({ status: 'unchecked', detail: '' });
  });

  it('keeps calls with the same id apart across turns', () => {
    const list = artifactsOf([
      asked,
      calling('a1', 'c1', 'one'),
      toolMessage('t1', 'c1', false, 'boom'),
      userMessage('u2', 'more', true),
      calling('a2', 'c1', 'two'),
      toolMessage('t2', 'c1', true, 'ok'),
    ]);
    expect(list.map((entry) => [entry.key, entry.status, entry.messages.length])).toEqual([
      ['a1/c1', 'failed', 1],
      ['a2/c1', 'ok', 2],
    ]);
  });

  it('does not borrow a result from outside the tool block', () => {
    const list = artifactsOf([asked, calling('a1', 'c1', 'x'), userMessage('u2', 'more'), toolMessage('t1', 'c1', true, 'ok')]);
    expect(list[0]?.status).toBe('unchecked');
  });

  it('leaves out other tools, and survives arguments that are not JSON', () => {
    const other = { ...assistantMessage('a1'), calls: [{ id: 'c1', name: 'search', arguments: '{}' }] };
    expect(artifactsOf([asked, other])).toEqual([]);
    const broken = { ...assistantMessage('a2'), calls: [{ id: 'c2', name: 'plot', arguments: '{oops' }] };
    expect(artifactsOf([asked, broken])[0]).toMatchObject({ code: '', title: 'Chart' });
  });
});
