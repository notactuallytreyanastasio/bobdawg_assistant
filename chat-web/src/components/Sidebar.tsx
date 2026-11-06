// The saved conversations. Deleting asks once, in place, because there is no undo and the
// button sits right beside the row that opens the chat.

import { useState } from 'react';
import type { SavedChat } from '../chat/library';
import { PlusIcon, TrashIcon } from './icons';

export type SidebarProps = {
  readonly chats: readonly SavedChat[];
  readonly activeId: string;
  readonly open: boolean;
  readonly onNew: () => void;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onClose: () => void;
};

export function Sidebar({ chats, activeId, open, onNew, onOpen, onDelete, onClose }: SidebarProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <>
      {open ? <button className="scrim" type="button" aria-label="Close chats" onClick={onClose} /> : null}
      <nav className={open ? 'sidebar open' : 'sidebar'} aria-label="Chats">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <h1>DwarfStar</h1>
        </div>
        <button className="new" type="button" onClick={onNew}>
          <PlusIcon />
          New chat
        </button>
        {chats.length === 0 ? (
          <p className="none">Your chats stay in this browser.</p>
        ) : (
          <ul className="chats">
            {chats.map((chat) => (
              <li key={chat.id} className={chat.id === activeId ? 'chat active' : 'chat'}>
                <button
                  className="open"
                  type="button"
                  title={chat.title}
                  aria-current={chat.id === activeId ? 'page' : undefined}
                  onClick={() => onOpen(chat.id)}
                >
                  {chat.title}
                </button>
                {confirming === chat.id ? (
                  <button
                    className="confirm"
                    type="button"
                    onBlur={() => setConfirming(null)}
                    onClick={() => {
                      setConfirming(null);
                      onDelete(chat.id);
                    }}
                    ref={(button) => button?.focus()}
                  >
                    Delete
                  </button>
                ) : (
                  <button
                    className="delete"
                    type="button"
                    aria-label={`Delete ${chat.title}`}
                    onClick={() => setConfirming(chat.id)}
                  >
                    <TrashIcon />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </nav>
    </>
  );
}
