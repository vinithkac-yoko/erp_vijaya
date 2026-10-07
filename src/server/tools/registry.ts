import type { RegisteredTool, Role } from './types';

export class Registry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(tools: RegisteredTool[] = []) {
    for (const t of tools) this.register(t);
  }
  register(tool: RegisteredTool): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is registered twice.`);
    this.tools.set(tool.name, tool);
    return this;
  }
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }
  /** The tools a role may use. The agent is offered only these, so a storekeeper's assistant never sees approve_*. */
  forRole(role: Role): RegisteredTool[] {
    return this.list().filter((t) => t.roles.includes(role));
  }
}
