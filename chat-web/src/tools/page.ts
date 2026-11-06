// The page tool: a whole page rather than one chart. It comes down to code like any other, whose
// first act is to put the markup in root, so a page runs in the same frame under the same
// lockdown, and the guard on innerHTML reads every tag of it. Markup written straight into the
// document would have been parsed before any of that existed.

import type { ArtifactRunner } from '../artifact/protocol';
import { pageSource } from '../chat/artifact';
import { runDrawing } from './plot';
import { MAX_ROUNDS } from './tool';
import type { ToolDefinition } from './tool';

export function pageTool(runner: ArtifactRunner): ToolDefinition {
  return {
    name: 'page',
    description: `Build a whole page: several charts, headings, text, tables and controls, in the sandbox. Answers ok with what was drawn, or the runtime error. Every call spends one of ${MAX_ROUNDS} rounds, so each must be a real attempt at the whole page.`,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The name of the page.' },
        html: {
          type: 'string',
          description: 'The body of the page, with one <style> element at its start. Give an id to each place code will draw in.',
        },
        code: {
          type: 'string',
          description: 'JavaScript run after the html is in place, using d3, DATA, MESSAGES, root, width and height.',
        },
      },
      required: ['title', 'html'],
    },
    async run(args, context) {
      const code = pageSource(args);
      if (code === null) return { ok: false, text: 'page takes title and html, and code to go with them, all as strings' };
      return runDrawing(runner, 'page', code, context);
    },
  };
}
