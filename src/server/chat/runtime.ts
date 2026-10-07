import Anthropic from '@anthropic-ai/sdk';
import { agentConfig, type AgentConfig } from '../agent/config';
import { createAgent } from '../agent/run';
import { assistantOn, conversations, pendingActions, registry, runTool } from '../tools';
import { contextualChips } from './chips';

let client: Anthropic | undefined;

/**
 * The assistant as it is right now. Off if the environment says so (the hard stop), if the owner switched it off in
 * Settings, or if there is no key. When it is off the buttons, forms, printouts and approvals all keep working.
 */
export async function assistantRuntime(overrides: Partial<AgentConfig> = {}) {
  const base = { ...agentConfig(), ...overrides };
  const settingOn = await assistantOn();
  const config: AgentConfig = { ...base, enabled: base.enabled && settingOn };
  const on = config.enabled && !!config.apiKey;
  if (on && !client) client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL });
  const agent = createAgent({
    registry, runTool, pending: pendingActions, store: conversations, config,
    client: client ?? new Anthropic({ apiKey: 'not-set' }),
    chips: (role, used, lastAsk) => contextualChips(role, used, lastAsk, (t) => registry.get(t) !== undefined),
  });
  return { agent, config, on };
}
