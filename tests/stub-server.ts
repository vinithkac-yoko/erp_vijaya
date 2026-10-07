/**
 * A scripted "assistant" for the browser tests: `tsx tests/stub-server.ts`. It speaks Anthropic's real streaming protocol on
 * a local port, so the app's real SDK client talks to it (ANTHROPIC_BASE_URL). What it says depends on what the person typed.
 */
import { say, call, startStub, type StubRequest, type StubReply } from './helpers/anthropic-stub';

const PORT = Number(process.env.STUB_PORT ?? 3199);

function script(r: StubRequest): StubReply {
  const t = r.userText.toLowerCase();
  const answered = r.toolResults.length > 0;
  const owner = r.body.system?.[1]?.text?.includes('the OWNER') as boolean;

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
  if (t.includes('collected scrap')) return call('record_scrap_in', {}, 'Check the scrap and the quantity.');
  if (t.includes('sold scrap')) return call('record_scrap_sale', {}, 'Check the buyer, the quantity and the rate.');
  if (t.includes('reverse an entry')) return owner ? call('reverse_movement', {}, 'Choose the entry and say why.') : say('Only the owner can reverse an entry.');
  return say('I can help with stock questions, and with adding materials, suppliers and customers.');
}

void startStub(script, PORT).then((s) => console.log(`[stub] listening on ${s.url}`));
