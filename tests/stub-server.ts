/**
 * A scripted "assistant" for the browser tests: `tsx tests/stub-server.ts`. It speaks Anthropic's real streaming protocol on
 * a local port, so the app's real SDK client talks to it (ANTHROPIC_BASE_URL). What it says depends on what the person typed.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { say, call, startStub, type StubRequest, type StubReply } from './helpers/anthropic-stub';

const good = (f: string) => readFileSync(join(process.cwd(), 'reference/artifacts/examples/good', f), 'utf8');
/** What the artifact builder (a separate call, forced to one tool) "writes", chosen by the request the assistant passed it. */
function builder(r: StubRequest): StubReply {
  const system = JSON.stringify(r.body.system ?? '');
  const request = /<request>\\n([\s\S]*?)\\n<\/request>/.exec(system)?.[1]?.toLowerCase() ?? system.toLowerCase();
  const repair = (r.body.messages as unknown[]).length > 1;
  if (r.body.tools?.[0]?.name === 'return_edit') {
    if (request.includes('supplier column')) return call('return_edit', { patches: [{ old: '"label":"Material"}', new: '"label":"Material"},{"field":"supplier","label":"Supplier"}' }], summary: 'Added a Supplier column.' });
    if (request.includes('nothing matches')) return call('return_edit', { patches: [{ old: 'THIS TEXT IS NOT THERE', new: 'x' }], summary: 'Changed it.' });
    return call('return_edit', { patches: [], summary: 'Nothing to change.' });
  }
  if (request.includes('hostile')) return repair ? call('return_artifact', { kind: 'document', title: 'Below minimum', source: DOC_BELOW }) : call('return_artifact', { kind: 'document', title: 'Bad', source: '---\ntitle: Bad\nreads:\n  a: list_reorder_alerts {}\n---\nWe have ₹5,000 here and {{a.count}}.\n' });
  if (request.includes('never works')) return call('return_artifact', { kind: 'document', title: 'Bad', source: '---\ntitle: Bad\nreads:\n  a: list_reorder_alerts {}\n---\nWe have ₹5,000 here and {{a.count}}.\n' });
  if (request.includes('diagram') || request.includes('how we receive')) return call('return_artifact', { kind: 'document', title: 'How we receive material', source: good('receiving-sop.vdoc') });
  if (request.includes('what if') || request.includes('what-if')) return call('return_artifact', { kind: 'page', title: 'If the copper rate changes', source: good('rate-whatif.html') });
  if (request.includes('stock value') || request.includes('stock position') || request.includes('owner report')) return call('return_artifact', { kind: 'document', title: 'Stock position', source: good('stock-report.vdoc') });
  return call('return_artifact', { kind: 'document', title: 'Below minimum', source: DOC_BELOW });
}
const DOC_BELOW = `---
title: Below minimum
reads:
  alerts: list_reorder_alerts {}
---
**{{alerts.count}}** materials are below their minimum level.

\`\`\`vtable
{"from":"alerts","columns":[{"field":"material","label":"Material"},{"field":"onHand","label":"On hand","format":"qty","unitField":"unit"},{"field":"shortfall","label":"Short by","format":"qty","unitField":"unit"}],"rowButtons":[{"label":"Make PO","tool":"create_purchase_order","prefill":{"lines":[{"materialId":"$row.materialId","quantity":"$row.shortfall"}]}}]}
\`\`\`
`;

const PORT = Number(process.env.STUB_PORT ?? 3199);

function script(r: StubRequest): StubReply {
  const t = r.userText.toLowerCase();
  const answered = r.toolResults.length > 0;
  const owner = r.body.system?.[1]?.text?.includes('the OWNER') as boolean;

  if (/^return_(artifact|edit)$/.test(r.body.tools?.[0]?.name ?? '')) return builder(r);
  // "தமிழ்": the translator is a separate call; the stub puts a Tamil word in front of each text and keeps the text (so every number survives)
  if (JSON.stringify(r.body.system ?? '').includes('You translate short messages')) {
    const texts = JSON.parse(r.userText) as string[];
    return say(JSON.stringify(texts.map((x) => (x.includes('NOTRANSLATE') ? 'தவறு' : `தமிழில்: ${x}`))));
  }
  if (t.includes('trigger api down')) return { httpError: 529 };
  if (t.includes('how much') && t.includes('copper')) return answered ? say('There is no 22 SWG Copper Wire in the list yet.') : call('get_material_balance', { materialNames: ['copper wire'] }, 'Let me check.');
  if (t.includes('below its minimum')) return answered ? say('These are below their minimum.') : call('list_reorder_alerts', {});
  if (t.includes('show stock') || t.includes('stock on hand')) return answered ? say('Here is the stock.') : call('get_material_balance', {});
  if (t.includes('add ferrite')) return call('create_material', { name: 'Ferrite Core E-30', uom: 'NOS', stockType: 'STANDING', minimumLevel: 50 }, 'Check the unit and the minimum before you add it.');
  if (t.includes('add 22 swg')) return call('create_material', { name: '22 SWG Copper Wire', uom: 'KG', stockType: 'PER_JOB' }, 'Here is the form for it.');
  if (t.includes('add copper wire 22')) return call('create_material', { name: 'Copper Wire 22 SWG', uom: 'KG', stockType: 'PER_JOB' }, 'Here is the form for it.');
  if (t.includes('add supplier')) return call('create_party', { name: 'Sundaram Ferrites', role: 'SUPPLIER', city: 'Chennai' }, 'Check the name and the city.');
  if (t.includes('approval limit')) return owner ? call('update_setting', { key: 'po.approval_limit', value: 75000 }, 'Check the new limit.') : say('Only the owner can change the approval limit. It is ₹50,000 now.');
  if (t.includes('create a login')) return owner ? call('create_user', { name: 'Ravi Kumar', login: 'ravi@e2e.local', role: 'STOREKEEPER' }, 'You type the first password in the form.') : say('Only the owner adds logins.');
  if (t.includes('switch the assistant off')) return call('update_setting', { key: 'agent.enabled', value: 'off' }, 'This switches the assistant off.');
  if (t.includes('record a customer po')) return call('create_customer_po', { customerName: 'Ashok Transformers', number: 'AT/2627/118' }, 'Check the PO number.');
  if (t.includes('open jobs')) return answered ? say('Here are the open jobs.') : call('list_jobs', { status: 'OPEN' });
  if (t.includes('close the job')) return call('close_job', {}, 'Check the job and say if anything came back.');
  if (t.includes('stock leaking')) return owner ? (answered ? say('Here is where the counts differed.') : call('get_leak_report', {})) : say('The leak report is the owner\'s. I can show you the count for a material.');
  if (t.includes('bobbin history')) return answered ? say('Every count of the bobbins, newest first.') : call('get_count_history', { materialNames: ['Bobbin Type-B'] });
  if (t.includes('job costs')) return owner ? (answered ? say('Here are the jobs and what they cost.') : call('get_job_cost_report', { includeOpen: true })) : say('Job costs are the owner\'s.');
  if (t.includes('copper goes up')) return owner ? (answered ? say('Here is what that does to the open jobs.') : call('estimate_job_cost', { materialNames: ['22 SWG Copper Wire'], newRate: 900 })) : say('That is for the owner.');
  if (t.includes('done today')) return owner ? (answered ? say('Here is what was done today.') : call('get_activity', { from: '@today' })) : say('Only the owner sees that.');
  if (t.includes('make a below minimum report')) return answered ? say('It is open beside the chat. Save it?') : call('make_artifact', { request: 'Materials below minimum, with a Make PO button on each row' }, 'Building it.');
  if (t.includes('draw how we receive')) return answered ? say('The flow is open beside the chat.') : call('make_artifact', { request: 'Draw a diagram of how we receive material', kind: 'document' }, 'Drawing it.');
  if (t.includes('what-if page')) return answered ? say('The what-if is open beside the chat.') : call('make_artifact', { request: 'What if the copper rate changes, as a what-if page', kind: 'page' }, 'Building it.');
  if (t.includes('stock position report')) return owner ? (answered ? say('The report is open beside the chat.') : call('make_artifact', { request: 'An owner report of the stock position with value' }, 'Building it.')) : say('The stock position is the owner’s report.');
  if (t.includes('hostile report')) return answered ? say('Done.') : call('make_artifact', { request: 'hostile report that needs repair' }, 'Building it.');
  if (t.includes('impossible report')) return answered ? say('I could not build that one. Here is the nearest table.') : call('make_artifact', { request: 'a report that never works' });
  if (t.includes('add a supplier column')) return answered ? say('I added the column.') : call('edit_artifact', { request: 'add a supplier column' });
  if (t.includes('edit nothing matches')) return answered ? say('That did not work.') : call('edit_artifact', { request: 'nothing matches' });
  if (t.includes('share this report')) return owner ? call('share_artifact', {}, 'Check who gets it.') : say('Only the owner shares reports.');
  if (t.includes('print the po')) return answered ? say('The printout is open.') : call('open_printout', { template: 'purchase-order', with: { purchaseOrder: '1' } });
  if (t.includes('print the grn')) return answered ? say('The printout is open.') : call('open_printout', { template: 'goods-receipt-note', with: { receipt: '1' } });
  if (t.includes('print the issue slip')) return answered ? say('The printout is open.') : call('open_printout', { template: 'issue-slip', with: { job: '1' } });
  if (t.includes('print the count sheet')) return answered ? say('The printout is open.') : call('open_printout', { template: 'count-sheet', with: {} });
  if (t.includes('print the cost sheet')) return answered ? say('The printout is open.') : call('open_printout', { template: 'job-cost-sheet', with: { job: '1' } });
  if (t.includes('stock value in excel')) return answered ? say('Tap the button for the file.') : call('download_data', { format: 'xlsx', source: { tool: 'get_stock_value', input: {} }, title: 'Stock value' });
  if (t.includes('this as pdf')) return answered ? say('Tap the button for the file.') : call('download_data', { format: 'pdf' });
  if (t.includes('this as word')) return answered ? say('Tap the button for the file.') : call('download_data', { format: 'docx' });
  if (t.includes('start the demo again')) return owner ? call('reset_demo_data', {}, 'This clears the demo and fills it in again.') : say('Only the owner can start the demo again.');
  if (t.includes('add the part')) return call('create_part', { customerName: 'Medha Servo Drives', partNumber: '90308200008', description: 'TXFR FOR M634VOC' }, 'Check the part number and what it is.');
  if (t.includes('new job for part')) return call('create_job', { partId: '90308200008', quantity: 400 }, 'Check the part and how many.');
  if (t.includes('record the medha po')) return call('create_customer_po', { customerName: 'Medha Servo Drives', number: '5100033466', lines: [{ partId: '90305600201', quantity: 492 }] }, 'Check the parts and how many of each.');
  if (t.includes('left on the medha po')) return answered ? say('Here is what is left to plan.') : call('get_customer_po', { customerPoId: '5100033466', customerName: 'Medha Servo Drives' });
  if (t.includes('margin by part')) return owner ? (answered ? say('Here is the margin by part, material only.') : call('get_margin_by_part', {})) : say('The margin is the owner\'s.');
  if (t.includes('explain this question')) return answered ? say('That question is about what goes on the top of your printouts.') : call('get_decision', { decisionId: 'company letterhead printouts' });
  if (t.includes('my answer on the letterhead')) return owner ? call('answer_decision', { decisionId: 'company letterhead printouts', choice: 'Name / address / GSTIN / state / phone', note: 'Vijaya Electronics, Kollapakkam' }, 'Check your answer.') : say('Only the owner answers those.');
  if (t.includes('collected scrap')) return call('record_scrap_in', {}, 'Check the scrap and the quantity.');
  if (t.includes('sold scrap')) return call('record_scrap_sale', {}, 'Check the buyer, the quantity and the rate.');
  if (t.includes('reverse an entry')) return owner ? call('reverse_movement', {}, 'Choose the entry and say why.') : say('Only the owner can reverse an entry.');
  return say('I can help with stock questions, and with adding materials, suppliers and customers.');
}

void startStub(script, PORT).then((s) => console.log(`[stub] listening on ${s.url}`));

// A stand-in for Google's listener (GEMINI_BASE_URL), for the voice button: whatever audio it is given, it "hears" this sentence.
const GEMINI_PORT = Number(process.env.STUB_GEMINI_PORT ?? 3198);
createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('stub ok'); return; }
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { contents?: { parts?: { inlineData?: { data: string } }[] }[] };
    const audio = body.contents?.[0]?.parts?.find((p) => p.inlineData)?.inlineData?.data ?? '';
    const heard = req.headers['x-goog-api-key'] === 'e2e-not-a-real-key' && audio.length > 100 ? 'copper wire evlo irukku, how much copper do we have' : '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: heard }] } }] }));
  });
}).listen(GEMINI_PORT, '127.0.0.1', () => console.log(`[stub] listener on ${GEMINI_PORT}`));
