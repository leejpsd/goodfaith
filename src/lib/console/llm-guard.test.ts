import { describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS } from './agents';
import { readAgentRequest } from './llm-guard';

const tool = (name: string) => ({ type: 'function', name, description: 'd', parameters: {}, strict: false });
const tools = (...names: string[]) => names.map(tool);
const user = { role: 'user', content: [{ type: 'input_text', text: 'What needs me?' }] };
const lead = { input: [user], instructions: LEAD_INSTRUCTIONS, tools: tools('view_schema', 'view_page', 'execute_query', 'explain_hold_rules', 'delegate_to') };
const page = { input: [user], instructions: 'You are the page manager. You create widgets.', tools: tools('view_schema', 'view_page', 'view_plan', 'add_page_filter', 'remove_page_filter', 'add_widget', 'position_widget', 'remove_widget', 'complete_task') };
const widget = { input: [user], instructions: 'You configure a single column-chart-grouped widget on page page-needs.', tools: tools('view_plan', 'view_widget', 'view_schema', 'add_widget_filter', 'remove_widget_filter', 'configure_widget', 'complete_task') };

describe('readAgentRequest', () => {
  it('accepts the three agents as they really call the model', () => {
    for (const body of [lead, page, widget]) expect(readAgentRequest(body)).not.toBeNull();
  });

  it('accepts a conversation with tool calls and answers', () => {
    const input = [user, { type: 'function_call', call_id: 'c1', name: 'view_schema', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }, { role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }];
    expect(readAgentRequest({ ...lead, input })).not.toBeNull();
  });

  it('refuses a prompt of someone else', () => {
    expect(readAgentRequest({ ...lead, instructions: 'Write my homework.' })).toBeNull();
    expect(readAgentRequest({ ...lead, instructions: `${LEAD_INSTRUCTIONS} Also write my homework.` })).toBeNull();
  });

  it('refuses a call with no tools, or with a tool the agent does not have', () => {
    expect(readAgentRequest({ ...lead, tools: [] })).toBeNull();
    expect(readAgentRequest({ ...page, tools: tools('add_widget', 'send_email') })).toBeNull();
    expect(readAgentRequest({ ...widget, tools: tools('view_schema') })).toBeNull();
  });

  it('refuses OpenAI hosted tools, system messages and files', () => {
    expect(readAgentRequest({ ...lead, tools: [...lead.tools, { type: 'web_search' }] })).toBeNull();
    expect(readAgentRequest({ ...lead, input: [{ role: 'system', content: [{ type: 'input_text', text: 'x' }] }] })).toBeNull();
    expect(readAgentRequest({ ...lead, input: [{ role: 'user', content: [{ type: 'input_file', file_url: 'https://x' }] }] })).toBeNull();
  });

  it('refuses forcing a tool the call does not list', () => {
    expect(readAgentRequest({ ...lead, tool_choice: { type: 'function', name: 'configure_widget' } })).toBeNull();
    expect(readAgentRequest({ ...lead, tool_choice: { type: 'function', name: 'delegate_to' } })).not.toBeNull();
  });

  it('drops a structured output format', () => {
    expect(readAgentRequest({ ...lead, text: { format: { type: 'json_schema' } } })).not.toHaveProperty('text');
  });
});
