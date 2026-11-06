// What a slash means in Workspace mode. /init and /review say the same as ds4-agent's, and a file
// at .ds4/commands/<name>.md in the workspace makes a command of its own, read from the sandbox.
// Anything else stays what it was, because a question can start with a slash.

export type ReadFile = (path: string) => Promise<{ readonly ok: boolean; readonly text: string }>;

const COMMAND = /^\/([A-Za-z0-9_-]{1,64})(?:\s+([\s\S]*))?$/;

const BUILT_IN: Readonly<Record<string, string>> = {
  init: 'Read this workspace and write an AGENT.md at its root for future sessions: how to build it, how to run its tests and a single test, how the code is laid out, and the rules a newcomer would break. Keep to what cannot be seen at a glance, and to what you checked. If one exists, improve it rather than replacing it. $ARGUMENTS',
  review: 'Review the changes in this workspace that are not committed yet: run git status and git diff, and read what you need around them. Report real defects first, each with the file, the line and what would go wrong, then anything else worth saying, and change nothing. $ARGUMENTS',
};

function fill(body: string, args: string): string {
  if (body.includes('$ARGUMENTS')) return body.replaceAll('$ARGUMENTS', args).trim();
  return args === '' ? body.trim() : `${body.trim()}\n\n${args}`;
}

export async function expandCommand(text: string, read: ReadFile): Promise<string> {
  const found = COMMAND.exec(text.trim());
  if (found === null) return text;
  const [, name = '', args = ''] = found;
  const own = await read(`.ds4/commands/${name}.md`).catch(() => null);
  if (own?.ok === true) return fill(own.text, args);
  const builtIn = BUILT_IN[name];
  return builtIn === undefined ? text : fill(builtIn, args);
}
