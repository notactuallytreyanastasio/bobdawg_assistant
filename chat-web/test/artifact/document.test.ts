import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FRAME_POLICY, artifactDocument, escapeScript, sharedDocument } from '../../src/artifact/document';
import { SHARE_WIDTH } from '../../src/artifact/limits';

const input = { code: 'draw();', messages: ['data'], width: 600, height: 400, d3: 'var d3={};' };

function parsed(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const SCRIPTS = 6;

describe('escapeScript', () => {
  it('breaks a closing tag in any case', () => {
    expect(escapeScript('"</script>"')).toBe('"<\\/script>"');
    expect(escapeScript('"</SCRIPT >"')).toBe('"<\\/SCRIPT >"');
  });

  it('breaks an HTML comment opener', () => {
    expect(escapeScript('"<!--"')).toBe('"<\\!--"');
  });

  it('means the same to JavaScript inside a string', () => {
    const source = '"</script><!--"';
    expect(new Function(`return ${escapeScript(source)}`)()).toBe('</script><!--');
  });
});

describe('artifactDocument', () => {
  it('has exactly the policy that was tested', () => {
    expect(FRAME_POLICY).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types default",
    );
  });

  // The draw size has a floor, so a narrow panel has to shrink the chart rather than cut it off.
  it('holds an svg to the width of the frame, whatever the code set on it', () => {
    const { html } = artifactDocument(input);
    expect(parsed(html).querySelector('style')?.textContent).toContain('svg{max-width:100%;height:auto}');
  });

  it('puts the charset, then the policy, before anything else', () => {
    const { html } = artifactDocument(input);
    const doc = parsed(html);
    const metas = doc.head.querySelectorAll('meta');
    expect(metas[0]?.getAttribute('charset')).toBe('utf-8');
    expect(metas[1]?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(metas[1]?.getAttribute('content')).toBe(FRAME_POLICY);
    expect(doc.head.firstElementChild).toBe(metas[0]);
    expect(metas[1]?.nextElementSibling?.tagName).toBe('STYLE');
  });

  it('runs lockdown, harness, D3, data, globals, then the code', () => {
    const scripts = [...parsed(artifactDocument(input).html).querySelectorAll('script')].map((s) => s.textContent ?? '');
    expect(scripts).toHaveLength(SCRIPTS);
    expect(scripts[0]).toContain("createPolicy('default'");
    expect(scripts[1]).toContain('var HEARTBEAT_MS');
    expect(scripts[2]).toBe('var d3={};');
    expect(JSON.parse(scripts[3] ?? '')).toEqual({ messages: ['data'], width: 600, height: 400 });
    expect(scripts[4]).toContain('window.DATA');
    expect(scripts[5]).toBe('(function(){\ndraw();\n})();\n');
  });

  it('gives the root an empty div before any script', () => {
    const doc = parsed(artifactDocument(input).html);
    expect(doc.body.firstElementChild?.id).toBe('root');
  });

  it.each([
    ['</script>', 'closing tag'],
    ['</SCRIPT >', 'upper case with a space'],
    ['</script/x>', 'slash form'],
    ['<!-- <script>', 'comment and open tag'],
    ['<script><!--', 'double escape'],
    ['</script><img src=x onerror=alert(1)>', 'closing tag then markup'],
  ])('holds %s (%s) in code, data and a title', (hostile) => {
    const code = `// title: ${hostile}\nconst a = "${hostile}";`;
    const doc = parsed(artifactDocument({ ...input, code, messages: [hostile], d3: `var x="${hostile}";` }).html);
    expect(doc.querySelectorAll('script')).toHaveLength(SCRIPTS);
    expect(doc.querySelectorAll('img')).toHaveLength(0);
    const data = doc.getElementById('data')?.textContent ?? '';
    expect(JSON.parse(data).messages).toEqual([hostile]);
  });

  it('counts the line the code starts on', () => {
    const { html, codeLine } = artifactDocument({ ...input, code: 'first();\nsecond();' });
    const lines = html.split('\n');
    expect(lines[codeLine - 1]).toBe('first();');
    expect(lines[codeLine]).toBe('second();');
  });

  it('counts past new lines in D3 and in the data', () => {
    const { html, codeLine } = artifactDocument({ ...input, d3: 'a\nb\nc', messages: ['x\ny'] });
    expect(html.split('\n')[codeLine - 1]).toBe('draw();');
  });
});

describe('the shared document and the server', () => {
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../ds4_share.h'), 'utf8');
  const policy = [...server.matchAll(/^\s+"(.*?)"(?: \\)?$/gm)].map((match) => match[1]).join('');

  it('is held by the server to everything a frame in the chat is held to', () => {
    for (const directive of FRAME_POLICY.split('; ')) expect(policy).toContain(directive);
  });

  it('adds the sandbox and refuses frames, which a top-level reply needs', () => {
    expect(policy.startsWith('sandbox allow-scripts; ')).toBe(true);
    expect(policy).toContain("frame-src 'none'");
  });

  it('is drawn at a fixed size and carries no harness', () => {
    const html = sharedDocument({ code: 'draw()', messages: ['m'], d3: 'd3' });
    expect(html).toContain(`"width":${SHARE_WIDTH}`);
    expect(html).not.toContain('HEARTBEAT_MS');
  });
});
