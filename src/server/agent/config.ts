export interface AgentConfig {
  /** The hard stop. AGENT_ENABLED=false turns the assistant off; forms, printouts and approvals keep working. */
  enabled: boolean;
  apiKey?: string;
  baseURL?: string;
  model: string;
  /** How hard the model thinks. Medium suits multi-step tool use; tune it with the evals (milestone 8). */
  effort: 'low' | 'medium' | 'high';
  maxToolCalls: number;
  turnTimeoutMs: number;
  /** Tokens one person's assistant may use per day (India time). */
  dailyTokens: number;
  /** Ask the API to re-run a declined request on a fallback model (recommended for this model family). */
  refusalFallback: boolean;
  /** At most this many messages per person per minute. */
  messagesPerMinute: number;
}

const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);

export function agentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const effort = env.ANTHROPIC_EFFORT;
  return {
    enabled: env.AGENT_ENABLED !== 'false',
    apiKey: env.ANTHROPIC_API_KEY || undefined,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    effort: effort === 'low' || effort === 'high' ? effort : 'medium',
    maxToolCalls: int(env.AGENT_MAX_TOOL_CALLS, 8),
    turnTimeoutMs: int(env.AGENT_TURN_TIMEOUT_MS, 60_000),
    dailyTokens: int(env.AGENT_DAILY_TOKENS, 500_000),
    refusalFallback: env.ANTHROPIC_REFUSAL_FALLBACK !== 'false',
    messagesPerMinute: int(env.AGENT_MESSAGES_PER_MINUTE, 20),
  };
}

/** What the person is told when the assistant can't be used. The same words whether it is off, unset, or down. */
export const ASSISTANT_OFF = 'The assistant is off. The buttons above still work.';
export const ASSISTANT_DOWN = "I can't answer right now. The buttons above still work.";
