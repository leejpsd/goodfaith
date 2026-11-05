import { z } from 'zod';

export const dynamic = 'force-dynamic';

// The console's agent reaches the model through this route, so the key stays on the server.
// The model is fixed here, and a daily ceiling limits what an open page can spend.
const DAILY_LIMIT = 400;
const MAX_BODY_CHARS = 200_000;
const MAX_OUTPUT_TOKENS = 2_000;

let day = '';
let used = 0;

const input = z.object({
  input: z.array(z.unknown()).max(200),
  instructions: z.string().max(40_000).optional(),
  tools: z.array(z.object({ type: z.literal('function'), name: z.string(), description: z.string(), parameters: z.unknown(), strict: z.literal(false) })).max(40).optional(),
  tool_choice: z.unknown().optional(),
  text: z.unknown().optional(),
});

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return Response.json({ error: { code: 'too_long', message: 'That conversation is too long. Start a new one.' } }, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const parsed = input.safeParse(json);
  if (!parsed.success) return Response.json({ error: { code: 'bad_request', message: 'The request could not be read.' } }, { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    used = 0;
  }
  if (++used > DAILY_LIMIT) return Response.json({ error: { code: 'daily_limit', message: 'The assistant has reached its limit for today.' } }, { status: 429 });

  const { OPENAI_API_KEY: key, OPENAI_MODEL: model } = process.env;
  if (!key || !model) return Response.json({ error: { code: 'unavailable', message: 'The assistant is not set up on this server.' } }, { status: 503 });

  const upstream = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...parsed.data, model, store: false, max_output_tokens: MAX_OUTPUT_TOKENS }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (!upstream) return Response.json({ error: { code: 'unavailable', message: 'The model did not answer.' } }, { status: 502 });
  if (!upstream.ok) {
    console.error('Console model returned', upstream.status);
    return Response.json({ error: { code: 'unavailable', message: 'The model did not answer.' } }, { status: 502 });
  }
  return Response.json(await upstream.json());
}
