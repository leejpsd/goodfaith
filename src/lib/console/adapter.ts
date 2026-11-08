import type { AgAiConversationItem, AgAiEvent, AgAiOutputItem, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from 'ag-studio';

// AG Studio ships no connection to a provider. This one speaks the OpenAI Responses format
// through the app's own route, so the key never reaches the browser.
const ENDPOINT = '/api/console/llm';

export function toOpenAiInput(items: AgAiConversationItem[]): unknown[] {
  return items.flatMap((item): unknown[] => {
    switch (item.type) {
      case 'message':
        if (item.role === 'assistant') {
          const text = item.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
          return text ? [{ role: 'assistant', content: [{ type: 'output_text', text }] }] : [];
        }
        return [{ role: item.role, content: item.content.flatMap((part) => (part.type === 'text' ? [{ type: 'input_text', text: part.text }] : [])) }];
      case 'function_call':
        return [{ type: 'function_call', call_id: item.callId, name: item.name, arguments: item.arguments }];
      case 'function_call_output':
        return [{ type: 'function_call_output', call_id: item.callId, output: item.output }];
      default:
        // Reasoning items belong to the turn that made them, and the route does not store turns.
        return [];
    }
  });
}

export function toOpenAiBody(request: AgLlmRequest) {
  const { toolChoice, responseFormat } = request;
  return {
    input: toOpenAiInput(request.input),
    instructions: request.instructions,
    tools: request.tools?.map((tool) => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: false as const })),
    tool_choice: typeof toolChoice === 'object' ? { type: 'function', name: toolChoice.name } : toolChoice,
    text: responseFormat?.type === 'json' ? { format: { type: 'json_schema', name: responseFormat.name, schema: responseFormat.schema, strict: false } } : undefined,
  };
}

interface OpenAiOutput {
  id?: string;
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string; refusal?: string }[];
}

export function fromOpenAi(body: { id?: string; created_at?: number; status?: string; model?: string; output?: OpenAiOutput[]; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }): { response: AgLlmResponse; events: AgAiEvent[] } {
  if (body.status === 'failed') return { response: failure('unavailable', 'The model did not answer.'), events: [] };
  const output: AgAiOutputItem[] = [];
  const events: AgAiEvent[] = [];
  for (const [index, item] of (body.output ?? []).entries()) {
    const id = item.id ?? `item-${index}`;
    if (item.type === 'message') {
      const text = (item.content ?? []).map((part) => part.text ?? part.refusal ?? '').join('');
      output.push({ id, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text, annotations: [] }] });
      events.push({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text || ' ' }, { type: 'TEXT_MESSAGE_END', messageId: id });
    } else if (item.type === 'function_call' && item.call_id && item.name) {
      output.push({ id, kind: 'output', type: 'function_call', callId: item.call_id, name: item.name, arguments: item.arguments ?? '{}', status: 'completed' });
      events.push(
        { type: 'TOOL_CALL_START', toolCallId: item.call_id, toolCallName: item.name },
        { type: 'TOOL_CALL_ARGS', toolCallId: item.call_id, delta: item.arguments ?? '{}' },
        { type: 'TOOL_CALL_END', toolCallId: item.call_id },
      );
    }
  }
  return {
    events,
    response: {
      id: body.id ?? 'response',
      createdAt: (body.created_at ?? Math.floor(Date.now() / 1000)) * 1000,
      output,
      status: body.status === 'incomplete' ? 'incomplete' : 'completed',
      model: body.model,
    },
  };
}

function failure(code: string, message: string): AgLlmResponse {
  return { id: 'failed', createdAt: Date.now(), output: [], status: 'failed', error: { code, message } };
}

export const consoleAdapter: AgLlmAdapter = {
  executeTurn(request, options) {
    const turn = (async () => {
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toOpenAiBody(request)),
        signal: options?.signal,
      });
      const body = (await r.json().catch(() => ({}))) as Parameters<typeof fromOpenAi>[0] & { error?: { code: string; message: string } };
      if (!r.ok) return { response: failure(body.error?.code ?? 'unavailable', body.error?.message ?? 'The model did not answer.'), events: [] as AgAiEvent[] };
      return fromOpenAi(body);
    })();
    return {
      // The route answers a whole turn at once, so the events arrive together at the end of it.
      stream: {
        async *[Symbol.asyncIterator]() {
          const { events } = await turn;
          yield* events;
        },
      },
      complete: turn.then(({ response }) => response),
    };
  },
};
