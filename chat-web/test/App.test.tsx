import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/App';
import type { FetchLike } from '../src/api/chatClient';
import type { ArtifactHost, HostRun, HostStatus } from '../src/artifact/host';
import { emptyReport } from '../src/artifact/protocol';
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

  describe('with Plot', () => {
    type Body = { readonly messages: readonly { readonly role: string }[]; readonly tools?: unknown };

    const code = '// title: Loaves\ndraw()';
    const callChunk = `data: ${JSON.stringify({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'plot', arguments: JSON.stringify({ code }) } }] },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n\n`;

    // A server that calls the tool first and speaks second, and a host that draws at once.
    function rig() {
      const bodies: Body[] = [];
      const fetchImpl: FetchLike = async (input, init) => {
        if (String(input).endsWith('/v1/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'alias' }] }));
        }
        if (String(input).endsWith('/chat/record')) return new Response('{}');
        bodies.push(JSON.parse(String(init?.body)) as Body);
        return bodies.length === 1
          ? sseResponse([callChunk, done])
          : sseResponse([contentChunk('Saturdays lead.'), done]);
      };
      const runs: HostRun[] = [];
      const removed = vi.fn();
      let status: HostStatus = { live: false, checking: false, ended: null };
      const listeners = new Set<() => void>();
      const set = (next: HostStatus) => {
        status = next;
        for (const listener of listeners) listener();
      };
      const createHost = (): ArtifactHost => ({
        run: async (input) => {
          runs.push(input);
          set({ live: true, checking: false, ended: null });
          return { ...emptyReport, nodes: 3, svgs: 1, marks: 3, bbox: { w: 5, h: 5 } };
        },
        remove: () => {
          removed();
          set({ live: false, checking: false, ended: null });
        },
        status: () => status,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose: () => undefined,
      });
      return { bodies, runs, removed, fetchImpl, createHost };
    }

    async function ask(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
      await waitFor(() => expect(textBox().disabled).toBe(false));
      await user.type(textBox(), `${text}{Enter}`);
    }

    function panel(): Element {
      const found = document.querySelector('.panel');
      if (found === null) throw new Error('no panel');
      return found;
    }

    it('remembers the toggle', async () => {
      const user = userEvent.setup();
      const store = memoryStore();
      const first = render(<App origin="" fetchImpl={served} store={store} />);
      await user.click(screen.getByRole('button', { name: 'Plot' }));
      first.unmount();
      render(<App origin="" fetchImpl={served} store={store} />);
      expect(screen.getByRole('button', { name: 'Plot' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('sends no tools with Plot off', async () => {
      const user = userEvent.setup();
      const server = rig();
      render(<App origin="" fetchImpl={server.fetchImpl} store={memoryStore()} createHost={server.createHost} />);
      await ask(user, 'hello');
      await waitFor(() => expect(server.bodies).toHaveLength(1));
      expect(server.bodies[0]?.tools).toBeUndefined();
    });

    it('runs nothing until Run, then reveals the chart and carries on', async () => {
      const user = userEvent.setup();
      const server = rig();
      render(<App origin="" fetchImpl={server.fetchImpl} store={memoryStore()} createHost={server.createHost} />);
      await user.click(screen.getByRole('button', { name: 'Plot' }));
      await ask(user, 'the data');
      const run = await screen.findByRole('button', { name: 'Run' });
      expect(server.runs).toHaveLength(0);
      expect(panel().className).toBe('panel');
      await user.click(run);
      await screen.findByText('Saturdays lead.');
      expect(server.runs).toHaveLength(1);
      expect(server.runs[0]?.messages).toEqual(['the data']);
      await waitFor(() => expect(panel().className).toBe('panel open'));
      expect(server.bodies[1]?.messages.map((message) => message.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
      ]);
    });

    it('shows the code before running, with no frame', async () => {
      const user = userEvent.setup();
      const server = rig();
      render(<App origin="" fetchImpl={server.fetchImpl} store={memoryStore()} createHost={server.createHost} />);
      await user.click(screen.getByRole('button', { name: 'Plot' }));
      await ask(user, 'the data');
      await screen.findByRole('button', { name: 'Run' });
      const card = document.querySelector('.card');
      if (!(card instanceof HTMLElement)) throw new Error('no card');
      await user.click(within(card).getByRole('button', { name: 'Code' }));
      expect(document.querySelector('.panel-code')?.textContent).toBe(code);
      expect(panel().className).toBe('panel open');
      expect(server.runs).toHaveLength(0);
    });

    it('takes Stop at the Run prompt as no', async () => {
      const user = userEvent.setup();
      const server = rig();
      render(<App origin="" fetchImpl={server.fetchImpl} store={memoryStore()} createHost={server.createHost} />);
      await user.click(screen.getByRole('button', { name: 'Plot' }));
      await ask(user, 'the data');
      await screen.findByRole('button', { name: 'Run' });
      await user.click(screen.getByRole('button', { name: 'Stop' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Run' })).toBeNull());
      expect(server.runs).toHaveLength(0);
      expect(server.bodies).toHaveLength(1);
    });

    it('runs nothing on reopening a chat, until the placeholder is tapped', async () => {
      const user = userEvent.setup();
      const server = rig();
      const store = memoryStore();
      const first = render(<App origin="" fetchImpl={server.fetchImpl} store={store} createHost={server.createHost} />);
      await user.click(screen.getByRole('button', { name: 'Plot' }));
      await ask(user, 'the data');
      await user.click(await screen.findByRole('button', { name: 'Run' }));
      await screen.findByText('Saturdays lead.');
      await screen.findByRole('button', { name: 'Send' });
      first.unmount();
      server.runs.length = 0;
      render(<App origin="" fetchImpl={server.fetchImpl} store={store} createHost={server.createHost} />);
      expect(server.runs).toHaveLength(0);
      expect(panel().className).toBe('panel');
      await user.click(await screen.findByRole('button', { name: /Loaves/ }));
      expect(panel().className).toBe('panel open');
      expect(server.runs).toHaveLength(0);
      await user.click(screen.getByRole('button', { name: 'Run' }));
      expect(server.runs).toHaveLength(1);
    });

    it('clears the panel for a new chat', async () => {
      const user = userEvent.setup();
      const server = rig();
      render(<App origin="" fetchImpl={server.fetchImpl} store={memoryStore()} createHost={server.createHost} />);
      await user.click(screen.getByRole('button', { name: 'Plot' }));
      await ask(user, 'the data');
      await user.click(await screen.findByRole('button', { name: 'Run' }));
      await screen.findByText('Saturdays lead.');
      await waitFor(() => expect(panel().className).toBe('panel open'));
      await user.click(screen.getByRole('button', { name: 'New chat' }));
      expect(panel().className).toBe('panel');
      expect(server.removed).toHaveBeenCalled();
    });

    it('takes the frame down when a retry removes the chart it belongs to', async () => {
      const user = userEvent.setup();
      const server = rig();
      render(<App origin="" fetchImpl={server.fetchImpl} store={memoryStore()} createHost={server.createHost} />);
      await user.click(screen.getByRole('button', { name: 'Plot' }));
      await ask(user, 'the data');
      await user.click(await screen.findByRole('button', { name: 'Run' }));
      await screen.findByText('Saturdays lead.');
      await waitFor(() => expect(panel().className).toBe('panel open'));
      server.removed.mockClear();
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(server.removed).toHaveBeenCalled());
      expect(panel().className).toBe('panel');
    });

    it('keeps the panel third in the row, and renders it with no chart', async () => {
      const { container } = render(<App origin="" fetchImpl={served} store={memoryStore()} />);
      const shell = container.querySelector('.app');
      expect(shell?.lastElementChild?.className).toBe('panel');
      expect(shell?.textContent).toContain('Do not type anything private into it.');
    });
  });
});
