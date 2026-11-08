import type { AgAiConversationItem } from 'ag-studio';
import { describe, expect, it } from 'vitest';
import { fromOpenAi, toOpenAiBody, toOpenAiInput } from './adapter';

describe('toOpenAiInput', () => {
  it('maps each kind of conversation item', () => {
    const items: AgAiConversationItem[] = [
      { id: '1', kind: 'input', type: 'message', role: 'user', status: 'completed', content: [{ type: 'text', text: 'Hi' }] },
      { id: '2', kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: 'Hello', annotations: [] }] },
      { id: '3', kind: 'output', type: 'function_call', callId: 'c1', name: 'view_schema', arguments: '{}' },
      { type: 'function_call_output', callId: 'c1', output: 'ok', status: 'completed' },
    ];
    expect(toOpenAiInput(items)).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
      { type: 'function_call', call_id: 'c1', name: 'view_schema', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ]);
  });

  it('drops reasoning items', () => {
    expect(toOpenAiInput([{ id: 'r', kind: 'output', type: 'reasoning', summary: [] }])).toEqual([]);
  });
});

describe('toOpenAiBody', () => {
  it('maps tools, a forced tool and a JSON format', () => {
    const body = toOpenAiBody({
      input: [],
      tools: [{ name: 't', description: 'd', parameters: {} }],
      toolChoice: { name: 't' },
      responseFormat: { type: 'json', name: 'n', schema: {} },
    });
    expect(body.tools).toEqual([{ type: 'function', name: 't', description: 'd', parameters: {}, strict: false }]);
    expect(body.tool_choice).toEqual({ type: 'function', name: 't' });
    expect(body.text).toEqual({ format: { type: 'json_schema', name: 'n', schema: {}, strict: false } });
  });

  it('sends no format for plain text', () => {
    expect(toOpenAiBody({ input: [], responseFormat: { type: 'text' } }).text).toBeUndefined();
  });
});

describe('fromOpenAi', () => {
  it('turns a message and a tool call into output and events', () => {
    const { response, events } = fromOpenAi({
      id: 'r1',
      created_at: 10,
      status: 'completed',
      output: [
        { id: 'm', type: 'message', content: [{ type: 'output_text', text: 'Hi' }] },
        { id: 'f', type: 'function_call', call_id: 'c1', name: 'q', arguments: '{"a":1}' },
        { id: 'x', type: 'reasoning' },
      ],
    });
    expect(response.createdAt).toBe(10_000);
    expect(response.output.map((item) => item.type)).toEqual(['message', 'function_call']);
    expect(events.map((event) => event.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END']);
  });

  it('reports a failed response as failed, with nothing to show', () => {
    const { response, events } = fromOpenAi({ status: 'failed', output: [] });
    expect(response.status).toBe('failed');
    expect(events).toEqual([]);
  });

  it('reports an incomplete response', () => {
    expect(fromOpenAi({ status: 'incomplete', output: [] }).response.status).toBe('incomplete');
  });
});
