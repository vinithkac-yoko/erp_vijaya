/**
 * An artifact is made only when the person asks for a report, memo, SOP, diagram, chart, dashboard, comparison, what-if
 * or long list (docs/ARTIFACTS.md §2). This is the code-level guard behind the prompt, and the same words the agent
 * evals check (evals/assert.ts ARTIFACT_ASKED: tests/artifacts.port.test.ts keeps the two equal).
 */
export const ARTIFACT_ASKED = new RegExp([
  'report', 'memo', '\\bsops?\\b', 'diagram', 'flow ?chart', '\\bdraw\\b', 'write[- ]?up', 'explainer', 'document', 'chart', 'graph', 'plot', 'dashboard', 'compar', 'what[ -]?if', 'what would', 'trend', 'calculator', 'slider', 'artifact',
  'screen', 'page', 'board', 'overview', 'visual',
  'list (all|every)', 'every (goods |purchase |job |material |supplier |receipt |po\\b|movement|issue)', 'all (the )?(goods |purchase )?(receipts|jobs|materials|suppliers|pos|movements|issues)',
  '\\bif\\b.{0,40}\\b(goes|go|rises|rise|drops|falls|changes|becomes)\\b',
].join('|'), 'i');
