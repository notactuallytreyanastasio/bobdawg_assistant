// What the transcript holds, as it holds it: entries in order, thinking folded beside the
// answer it belongs to, and one status line while the model is still working. The text is
// rendered as written, so a line break from the model stays a line break.

import type { Conversation } from '../chat/conversation';
import type { ChatMessage } from '../chat/message';

function statusOf(conversation: Conversation): string | null {
  if (!conversation.streaming) return null;
  const last = conversation.messages.at(-1);
  if (last === undefined || last.role !== 'assistant') return 'waiting';
  return last.text === '' ? 'waiting for the model' : 'answering';
}

function Entry({ message }: { message: ChatMessage }) {
  return (
    <li className={`entry ${message.role}`}>
      <b className="role">{message.role === 'user' ? 'You' : 'Model'}</b>
      {message.reasoning === '' ? null : (
        <details className="reasoning">
          <summary>Thinking</summary>
          <p className="pre">{message.reasoning}</p>
        </details>
      )}
      <p className="pre">{message.text}</p>
    </li>
  );
}

export function Transcript({ conversation }: { conversation: Conversation }) {
  const status = statusOf(conversation);
  if (conversation.messages.length === 0 && status === null) {
    return <p className="empty">Nothing asked yet</p>;
  }
  return (
    <section className="transcript">
      <ul className="entries">
        {conversation.messages.map((message) => (
          <Entry key={message.id} message={message} />
        ))}
      </ul>
      {status === null ? null : (
        <p className="status" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
