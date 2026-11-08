import { z } from 'zod';
import { AGENTS } from './agents';

const text = z.object({ type: z.enum(['input_text', 'output_text']), text: z.string() }).strict();

// Text and tool results only. A system message, an image or a file is not something these agents send.
const item = z.union([
  z.object({ role: z.enum(['user', 'assistant']), content: z.array(text).max(20) }).strict(),
  z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(), arguments: z.string() }).strict(),
  z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: z.string() }).strict(),
]);

const tool = z.object({ type: z.literal('function'), name: z.string(), description: z.string(), parameters: z.unknown(), strict: z.literal(false) }).strict();

// Anything else on the request, such as a structured output format, is dropped here.
const request = z.object({
  input: z.array(item).max(200),
  instructions: z.string().max(40_000),
  tools: z.array(tool).min(1).max(40),
  tool_choice: z.union([z.enum(['auto', 'none', 'required']), z.object({ type: z.literal('function'), name: z.string() }).strict()]).optional(),
});

export type AgentRequest = z.infer<typeof request>;

// Returns the request only if it is one of the console's own agents, so the route cannot be used
// to run a prompt or tools of someone else's. What a person types in the chat is still free text.
export function readAgentRequest(json: unknown): AgentRequest | null {
  const parsed = request.safeParse(json);
  if (!parsed.success) return null;
  const { instructions, tools, tool_choice: choice } = parsed.data;
  const names = tools.map((t) => t.name);
  const agent = AGENTS.find((a) => a.matches(instructions));
  if (!agent || !names.includes(agent.needs)) return null;
  const allowed: readonly string[] = agent.tools;
  if (!names.every((name) => allowed.includes(name))) return null;
  if (typeof choice === 'object' && !names.includes(choice.name)) return null;
  return parsed.data;
}
