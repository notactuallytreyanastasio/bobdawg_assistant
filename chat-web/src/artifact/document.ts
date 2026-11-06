// The document a chart runs in, as one string. The order is the security: the policy comes
// first so nothing runs without it, the lockdown and harness run before any data or code
// can, and the code goes last in a script of its own.

import harness from './frame/harness.js?raw';
import lockdown from './frame/lockdown.js?raw';
import { SHARE_HEIGHT, SHARE_WIDTH } from './limits';

// 'unsafe-eval' stays because d3.csvParse compiles a function. Eval reaches nothing the
// other directives do not already refuse, which was tested with a fetch from inside it.
export const FRAME_POLICY =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types default";

const GLOBALS = `(function(){var d=JSON.parse(document.getElementById('data').textContent);window.MESSAGES=d.messages;window.DATA=d.messages.join('\\n\\n');window.root=document.getElementById('root');window.width=d.width;window.height=d.height;})();`;

export type ArtifactInput = {
  readonly code: string;
  readonly messages: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly d3: string;
};

export type ArtifactDocument = {
  readonly html: string;
  // The document line of the code's first line, so a reported line can be turned back into
  // one the model wrote.
  readonly codeLine: number;
};

// Text inside a script element ends at the first </script, whatever the JavaScript around
// it means, and <!-- changes how the parser looks for that end. Both spellings mean the
// same to JavaScript inside a string with the backslash added.
export function escapeScript(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function script(source: string): string {
  return `<script>${source}</script>\n`;
}

function documentOf(input: ArtifactInput, watched: boolean): ArtifactDocument {
  const { messages, width, height } = input;
  const before = [
    '<!doctype html>\n',
    '<meta charset="utf-8">\n',
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">\n`,
    '<style>html,body{margin:0;color-scheme:light dark}svg{max-width:100%;height:auto}</style>\n',
    // The panel gives a chart its margin. A link has nothing around it to do that.
    watched ? '' : '<style>#root{padding:16px}</style>\n',
    '<div id="root"></div>\n',
    script(lockdown),
    watched ? script(harness) : '',
    script(escapeScript(input.d3)),
    `<script id="data" type="application/json">${jsonForScript({ messages, width, height })}</script>\n`,
    script(GLOBALS),
    '<script>(function(){\n',
  ].join('');
  const codeLine = before.split('\n').length;
  return { html: `${before}${escapeScript(input.code)}\n})();\n</script>\n`, codeLine };
}

export function artifactDocument(input: ArtifactInput): ArtifactDocument {
  return documentOf(input, true);
}

// The same document for a link. Nobody is on the other end to hear the harness, and the server
// holds this under a policy of its own, so the one in here is a courtesy and not the defence.
export function sharedDocument(input: Omit<ArtifactInput, 'width' | 'height'>): string {
  return documentOf({ ...input, width: SHARE_WIDTH, height: SHARE_HEIGHT }, false).html;
}
