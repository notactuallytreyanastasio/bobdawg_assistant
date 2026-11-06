import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/App';
import type { FetchLike } from '../src/api/chatClient';
import type { StoreLike } from '../src/chat/storage';

const encoder = new TextEncoder();

function sseResponse(payloads: readonly string[]): Response {
  return new Response(encoder.encode(payloads.join('')), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function contentChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
}

const done = 'data: [DONE]\n\n';

// One stub for both endpoints the page uses, so a test says what the server answers
// without caring which of the two the page asked.
function serverOf(chat: (payloads: readonly string[]) => Response): FetchLike {
  return async (input) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'alias' }, { id: 'other' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return chat([]);
  };
}

const served = serverOf(() => sseResponse([contentChunk('a gate held by water'), done]));

function textBox(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

function memoryStore(): StoreLike {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
  };
}

function question(text: string): HTMLElement {
  const found = screen.getAllByText(text).find((element) => element.closest('.transcript') !== null);
  if (found === undefined) throw new Error(`no question reading ${text} in the transcript`);
  return found;
}

describe('App', () => {
  it('names the model the server reported', async () => {
    render(<App origin="" fetchImpl={served} store={memoryStore()} />);
    await waitFor(() => expect(screen.getByText('alias').textContent).toBe('alias'));
  });

  it('keeps the composer closed until the server has answered', async () => {
    render(<App origin="" fetchImpl={served} store={memoryStore()} />);
    expect(textBox().disabled).toBe(true);
    await waitFor(() => expect(textBox().disabled).toBe(false));
  });

  it('carries the question to the model and brings the answer back', async () => {
    const user = userEvent.setup();
    render(<App origin="" fetchImpl={served} store={memoryStore()} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.type(textBox(), 'What is a redlock?{Enter}');

    expect(question('What is a redlock?').textContent).toBe('What is a redlock?');
    await waitFor(() =>
      expect(screen.getByText('a gate held by water').textContent).toBe('a gate held by water'),
    );
  });

  it('shows what the server said when it refused', async () => {
    const user = userEvent.setup();
    const refusing: FetchLike = async (input) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'alias' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { message: 'model alias not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };
    render(<App origin="" fetchImpl={refusing} store={memoryStore()} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.type(textBox(), 'anything{Enter}');

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('model alias not found'));
  });

  it('starts a new chat, leaving the old transcript behind', async () => {
    const user = userEvent.setup();
    render(<App origin="" fetchImpl={served} store={memoryStore()} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.type(textBox(), 'What is a redlock?{Enter}');
    await waitFor(() => expect(screen.getByText('a gate held by water').textContent).toBe('a gate held by water'));

    await user.click(screen.getByRole('button', { name: 'New chat' }));

    expect(screen.getByText('What are we working on?')).toBeTruthy();
    expect(screen.queryByText('a gate held by water')).toBeNull();
  });

  it('keeps the old chat in the list and brings it back', async () => {
    const user = userEvent.setup();
    render(<App origin="" fetchImpl={served} store={memoryStore()} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.type(textBox(), 'What is a redlock?{Enter}');
    await waitFor(() => expect(screen.getByText('a gate held by water')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    await user.click(screen.getByRole('button', { name: 'What is a redlock?' }));

    expect(screen.getByText('a gate held by water')).toBeTruthy();
  });

  it('comes back to the conversation it was showing after a reload', async () => {
    const user = userEvent.setup();
    const store = memoryStore();
    const first = render(<App origin="" fetchImpl={served} store={store} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));
    await user.type(textBox(), 'What is a redlock?{Enter}');
    await waitFor(() => expect(screen.getByText('a gate held by water')).toBeTruthy());
    first.unmount();

    render(<App origin="" fetchImpl={served} store={store} />);

    expect(screen.getByText('a gate held by water')).toBeTruthy();
  });

  it('starts from the welcome page once the open chat is deleted', async () => {
    const user = userEvent.setup();
    render(<App origin="" fetchImpl={served} store={memoryStore()} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));
    await user.type(textBox(), 'What is a redlock?{Enter}');
    await waitFor(() => expect(screen.getByText('a gate held by water')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Delete What is a redlock?' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByText('What are we working on?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'What is a redlock?' })).toBeNull();
  });

  it('asks a suggestion straight away', async () => {
    const user = userEvent.setup();
    render(<App origin="" fetchImpl={served} store={memoryStore()} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.click(screen.getByRole('button', { name: 'Explain how a KV cache speeds up inference' }));

    await waitFor(() => expect(screen.getByText('a gate held by water')).toBeTruthy());
  });

  it('keeps asking for the server until it answers', async () => {
    let up = false;
    const late: FetchLike = async (input, init) => {
      if (!up) throw new TypeError('connection refused');
      return served(input, init);
    };
    render(<App origin="" fetchImpl={late} store={memoryStore()} retryMs={5} />);

    await waitFor(() => expect(screen.getByText("Can't reach ds4-server yet, still trying")).toBeTruthy());
    expect(textBox().disabled).toBe(true);

    up = true;
    await waitFor(() => expect(textBox().disabled).toBe(false));
    expect(screen.queryByText("Can't reach ds4-server yet, still trying")).toBeNull();
  });

  it('offers no retry on a restored question until there is a model to ask', async () => {
    const user = userEvent.setup();
    const store = memoryStore();
    let up = true;
    const refusing: FetchLike = async (input, init) => {
      if (!up) throw new TypeError('connection refused');
      if (String(input).endsWith('/v1/models')) return served(input, init);
      return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 });
    };
    const first = render(<App origin="" fetchImpl={refusing} store={store} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));
    await user.type(textBox(), 'anything{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    first.unmount();

    up = false;
    render(<App origin="" fetchImpl={refusing} store={store} retryMs={5} />);

    expect(question('anything')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    up = true;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy());
  });

  it('hands each finished turn to the server for the graph, thinking left out', async () => {
    const user = userEvent.setup();
    const records: string[] = [];
    const recording: FetchLike = async (input, init) => {
      if (String(input).endsWith('/chat/record')) {
        records.push(String(init?.body));
        return new Response('{"recorded":true}');
      }
      return served(input, init);
    };
    render(<App origin="" fetchImpl={recording} store={memoryStore()} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.type(textBox(), 'What is a redlock?{Enter}');

    await waitFor(() => expect(records).toHaveLength(1));
    const turn = JSON.parse(records[0] ?? '{}');
    expect(turn.question).toBe('What is a redlock?');
    expect(turn.answer).toBe('a gate held by water');
    expect(turn.model).toBe('alias');
    await waitFor(() => expect(screen.getByText('In the decision graph')).toBeTruthy());
  });

  it('keeps one id for a conversation across its turns', async () => {
    const user = userEvent.setup();
    const chats: string[] = [];
    const recording: FetchLike = async (input, init) => {
      if (String(input).endsWith('/chat/record')) {
        chats.push(JSON.parse(String(init?.body)).chat);
        return new Response('{}');
      }
      return served(input, init);
    };
    render(<App origin="" fetchImpl={recording} store={memoryStore()} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.type(textBox(), 'one{Enter}');
    await waitFor(() => expect(chats).toHaveLength(1));
    await user.type(textBox(), 'two{Enter}');
    await waitFor(() => expect(chats).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    await user.type(textBox(), 'three{Enter}');
    await waitFor(() => expect(chats).toHaveLength(3));

    expect(chats[0]).toBe(chats[1]);
    expect(chats[2]).not.toBe(chats[0]);
  });

  it('says when a turn did not reach the graph, and not when the server does not record', async () => {
    const user = userEvent.setup();
    let status = 404;
    const refusing: FetchLike = async (input, init) => {
      if (String(input).endsWith('/chat/record')) return new Response('{}', { status });
      return served(input, init);
    };
    render(<App origin="" fetchImpl={refusing} store={memoryStore()} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.type(textBox(), 'one{Enter}');
    await waitFor(() => expect(screen.getByText('a gate held by water')).toBeTruthy());
    expect(screen.queryByText('Last turn not recorded')).toBeNull();

    status = 503;
    await user.type(textBox(), 'two{Enter}');
    await waitFor(() => expect(screen.getByText('Last turn not recorded')).toBeTruthy());
  });

  it('asks the failed question again from the banner', async () => {
    const user = userEvent.setup();
    let refused = true;
    const flaky: FetchLike = async (input, init) => {
      if (!String(input).endsWith('/v1/models') && refused) {
        refused = false;
        return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 });
      }
      return served(input, init);
    };
    render(<App origin="" fetchImpl={flaky} store={memoryStore()} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));
    await user.type(textBox(), 'anything{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('busy'));

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByText('a gate held by water')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
