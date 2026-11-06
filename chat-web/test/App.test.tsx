import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/App';
import type { FetchLike } from '../src/api/chatClient';

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

describe('App', () => {
  it('names the model the server reported', async () => {
    render(<App origin="" fetchImpl={served} />);
    await waitFor(() => expect(screen.getByText('alias').textContent).toBe('alias'));
  });

  it('keeps the composer closed until the server has answered', async () => {
    render(<App origin="" fetchImpl={served} />);
    expect(textBox().disabled).toBe(true);
    await waitFor(() => expect(textBox().disabled).toBe(false));
  });

  it('carries the question to the model and brings the answer back', async () => {
    const user = userEvent.setup();
    render(<App origin="" fetchImpl={served} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.type(textBox(), 'What is a redlock?{Enter}');

    expect(screen.getByText('What is a redlock?').textContent).toBe('What is a redlock?');
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
    render(<App origin="" fetchImpl={refusing} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.type(textBox(), 'anything{Enter}');

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('model alias not found'));
  });

  it('starts a new chat, leaving the old transcript behind', async () => {
    const user = userEvent.setup();
    render(<App origin="" fetchImpl={served} />);
    await waitFor(() => expect(textBox().disabled).toBe(false));

    await user.type(textBox(), 'What is a redlock?{Enter}');
    await waitFor(() => expect(screen.getByText('a gate held by water').textContent).toBe('a gate held by water'));

    await user.click(screen.getByRole('button', { name: 'New chat' }));

    expect(screen.getByText('Nothing asked yet')).toBeTruthy();
    expect(screen.queryByText('a gate held by water')).toBeNull();
    expect(screen.queryByText('What is a redlock?')).toBeNull();
  });
});
