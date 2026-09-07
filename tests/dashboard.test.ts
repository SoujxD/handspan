/**
 * The dashboard is one HTML file with an inline script, and nothing compiled it.
 *
 * TypeScript checks every other file in this project; this one is a string on
 * disk that the server hands to a browser. So a single bad escape inside it is
 * a syntax error the whole toolchain is blind to — and because a browser
 * abandons a script that will not parse, the failure is total and silent: every
 * tab stops responding, and the server still answers `200` with the full page,
 * so any check that looks at status or byte count reports success.
 *
 * That is exactly what happened. A heredoc turned `\n` into a real newline
 * inside a string literal, the script stopped parsing, and the page was dead
 * while `curl -o /dev/null -w '%{http_code}'` said 200 and 22kB.
 *
 * Parsing it here is the cheapest possible guard: `vm.Script` compiles the
 * source without running any of it, so this asserts the browser could at least
 * get as far as executing it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';

const html = readFileSync(join(process.cwd(), 'src', 'catalog', 'dashboard.html'), 'utf8');

describe('dashboard.html', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');

  it('has an inline script to check', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it('every inline script parses as JavaScript', () => {
    scripts.forEach((source, i) => {
      // Throws SyntaxError if the browser could not parse it either.
      expect(() => new Script(source, { filename: `dashboard.html#script${i}` })).not.toThrow();
    });
  });

  it('wires up every tab the nav declares', () => {
    // A tab whose panel does not exist looks identical to a dead script: you
    // click, and nothing happens.
    const tabs = [...html.matchAll(/data-tab="([a-z-]+)"/g)].map((m) => m[1]);
    expect(tabs.length).toBeGreaterThanOrEqual(4);
    for (const tab of tabs) {
      expect(html).toContain(`id="${tab}"`);
    }
  });
});
