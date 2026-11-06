// The files in the workspace, beside the chat. Everything here comes from the sandbox by the same
// tools the model uses, and all of it is shown as text.

import { useCallback, useEffect, useState } from 'react';
import { CopyButton } from './CopyButton';
import { CloseIcon } from './icons';

type Answer = { readonly ok: boolean; readonly text: string };

export type WorkspacePanelProps = {
  readonly open: boolean;
  // Changes when the files may have.
  readonly version: string;
  // Undo cannot run under a turn that is still writing.
  readonly busy: boolean;
  readonly run: (tool: string, args: Readonly<Record<string, unknown>>) => Promise<Answer>;
  readonly onClose: () => void;
};

type Entry = { readonly path: string; readonly size: number };

export function parseTree(text: string): readonly Entry[] {
  return text.split('\n').flatMap((line) => {
    const [path = '', size = ''] = line.split('\t');
    return path === '' ? [] : [{ path, size: Number(size) || 0 }];
  });
}

function sizeOf(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

export function WorkspacePanel({ open, version, busy, run, onClose }: WorkspacePanelProps) {
  const [files, setFiles] = useState<readonly Entry[]>([]);
  const [shown, setShown] = useState<{ readonly path: string; readonly text: string } | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const answer = await run('tree', {});
    setFiles(answer.ok ? parseTree(answer.text) : []);
    if (!answer.ok) setNote(answer.text);
  }, [run]);

  useEffect(() => {
    if (open && !busy) void load();
  }, [open, busy, version, load]);

  async function show(path: string): Promise<void> {
    const answer = await run('read', { path, raw: true });
    setShown({ path, text: answer.text });
  }

  async function undo(): Promise<void> {
    const answer = await run('restore', {});
    setNote(answer.text);
    setShown(null);
    await load();
  }

  return (
    <aside className={open ? 'panel open' : 'panel'} aria-label="Workspace files">
      <header className="panel-head">
        <div className="panel-title">
          <b>Workspace</b>
          <span className="state">{files.length === 1 ? '1 file' : `${files.length} files`}</span>
        </div>
        <div className="panel-tools">
          <button className="tool" type="button" disabled={busy} onClick={() => void undo()}>
            <span>Undo last turn</span>
          </button>
          <span className="spacer" />
          <button className="square" type="button" aria-label="Close the files" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
      </header>
      <p className="panel-notice">
        A sandbox with no network, private to this browser. Undo puts back everything as the last turn found it.
      </p>
      {note === '' ? null : (
        <p className="panel-ended" role="status">
          {note}
        </p>
      )}
      <ul className="files">
        {files.map((file) => (
          <li key={file.path}>
            <button type="button" aria-pressed={shown?.path === file.path} onClick={() => void show(file.path)}>
              <span>{file.path}</span>
              <span className="size">{sizeOf(file.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {shown === null ? null : (
        <div className="file-view">
          <CopyButton text={shown.text} label={`Copy ${shown.path}`} />
          <pre className="panel-code">{shown.text}</pre>
        </div>
      )}
    </aside>
  );
}
