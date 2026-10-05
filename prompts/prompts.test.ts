/**
 * The prompts may only name things that exist: tools, printouts, example artifacts.
 * A renamed tool must fail here before it confuses the model.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRINT_TEMPLATES } from '../reference/artifacts/catalog';
import { checkDoc } from '../reference/artifacts/artifact-check';

const root = join(__dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b));
const tools = JSON.parse(read('prompts/tool-descriptions.json')).tools as Record<string, { description: string }>;
const agentPrompt = between(read('docs/AGENT_PROMPT.md'), '<!-- PROMPT START -->', '<!-- PROMPT END -->');
const builderPrompt = between(read('prompts/ARTIFACT_BUILDER.md'), '<!-- BUILDER PROMPT START -->', '<!-- BUILDER PROMPT END -->');
// snake_case words that aren't tools but may appear (setting keys, JSON fields, vijaya API names)
const NOT_TOOLS = new Set(['approval_limit']);

const snake = (s: string) => [...new Set([...s.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]))];

describe('prompts name only real things', () => {
  for (const [name, text] of [['agent prompt', agentPrompt], ['artifact builder prompt', builderPrompt]] as const) {
    it(`${name}: every tool it names exists`, () => {
      expect(text.length, name).toBeGreaterThan(100);
      for (const w of snake(text)) if (!NOT_TOOLS.has(w)) expect(Object.keys(tools), `${name} mentions ${w}`).toContain(w);
    });
  }
  it('tool descriptions name only real tools', () => {
    for (const [n, d] of Object.entries(tools)) for (const w of snake(d.description)) if (!NOT_TOOLS.has(w)) expect(Object.keys(tools), `${n} mentions ${w}`).toContain(w);
  });
  it('open_printout and ARTIFACTS.md list every printout', () => {
    const doc = read('docs/ARTIFACTS.md');
    for (const t of Object.keys(PRINT_TEMPLATES)) {
      expect(tools.open_printout.description, t).toContain(t);
      expect(doc, t).toContain(`\`${t}\``);
      expect(agentPrompt, t).toContain(t);
    }
  });
  it('example artifacts the builder prompt points to exist (pages and documents)', () => {
    const found = [...read('prompts/ARTIFACT_BUILDER.md').matchAll(/reference\/artifacts\/examples\/([\w./-]+\.(?:html|vdoc))/g)].map((m) => m[1]);
    expect(found.some((f) => f.endsWith('.vdoc')) && found.some((f) => f.endsWith('.html'))).toBe(true);
    for (const f of found) expect(existsSync(join(root, 'reference/artifacts/examples', f)), f).toBe(true);
  });
  it('the builder prompt has a DOCUMENT mode and a PAGE mode and the document blocks', () => {
    for (const w of ['DOCUMENT MODE', 'PAGE MODE', 'vtable', 'vchart', 'vstats', 'mermaid', 'rowButtons', '$row.', 'EXACTLY ONCE', '{{KIND}}']) expect(builderPrompt, w).toContain(w);
  });
  it('the builder prompt lists no document block or format the renderer does not have', () => {
    // every fenced block name the prompt teaches must be a VDoc block language
    const langs = new Set([...builderPrompt.matchAll(/`(v(?:table|chart|stats))`/g)].map((m) => m[1]));
    expect([...langs].sort()).toEqual(['vchart', 'vstats', 'vtable']);
  });
  it('the two documents the builder prompt teaches pass checkDoc for the owner', () => {
    const docs = [...builderPrompt.matchAll(/````\n([\s\S]*?)\n````/g)].map((m) => m[1]).filter((d) => !d.includes('Markdown here.'));
    expect(docs.length).toBe(2);
    for (const d of docs) { const r = checkDoc(d, 'OWNER'); expect(r.issues.map((i) => i.message), d.slice(0, 40)).toEqual([]); }
  });
  it('the agent prompt knows the export formats and the two kinds', () => {
    for (const w of ['DOCUMENT', 'PAGE', 'PDF', 'Word', 'Excel', 'CSV', 'Markdown']) expect(agentPrompt, w).toContain(w);
    expect(agentPrompt).not.toMatch(/no PNG|no PDF|PNG or PDF files of an artifact/i);
  });
  it('the download tool names every format and make_artifact names both kinds', () => {
    for (const f of ['pdf', 'docx', 'xlsx', 'csv', 'png', 'md']) expect(tools.download_data.description, f).toContain(f);
    expect(tools.make_artifact.description).toMatch(/document/); expect(tools.make_artifact.description).toMatch(/page/);
  });
  it('the agent prompt routes every output kind', () => {
    for (const t of ['list_artifacts', 'open_artifact', 'make_artifact', 'edit_artifact', 'open_printout', 'download_data', 'share_artifact']) {
      expect(agentPrompt, t).toContain(t);
    }
  });
  it('no leftovers from pages, menu screens or blind counting', () => {
    for (const f of ['docs/AGENT_PROMPT.md', 'prompts/ARTIFACT_BUILDER.md', 'docs/TOOL_CATALOG.md']) {
      expect(read(f), f).not.toMatch(/make_page|find_pages|open_screen|print_document|export_data|publish_page|blind count|BLIND/);
    }
  });
});
