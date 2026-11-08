import { readAgentRequest } from '@/lib/console/llm-guard';
import { fromThisSite, notFromThisSite } from '@/lib/http/same-origin';

export const dynamic = 'force-dynamic';

// The console's agent reaches the model through this route, so the key stays on the server.
// The model is fixed here, and a daily ceiling limits what an open page can spend.
// One question can take over a dozen calls when the agent hands work to Studio's agents.
const DAILY_LIMIT = 1500;
const PER_VISITOR_HOURLY_LIMIT = 120;
const MAX_BODY_CHARS = 200_000;
const MAX_OUTPUT_TOKENS = 2_000;

let day = '';
let used = 0;
const visitors = new Map<string, { hour: number; used: number }>();

// The route answers anyone, since the console needs no login, so one visitor cannot use it all.
function overVisitorLimit(request: Request): boolean {
  const visitor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const hour = Math.floor(Date.now() / 36e5);
  const entry = visitors.get(visitor);
  if (!entry || entry.hour !== hour) {
    if (visitors.size > 5000) visitors.clear();
    visitors.set(visitor, { hour, used: 1 });
    return false;
  }
  entry.used += 1;
  return entry.used > PER_VISITOR_HOURLY_LIMIT;
}

export async function POST(request: Request) {
  if (!fromThisSite(request)) return notFromThisSite();
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return Response.json({ error: { code: 'too_long', message: 'That conversation is too long. Start a new one.' } }, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const body = readAgentRequest(json);
  if (!body) return Response.json({ error: { code: 'not_this_console', message: "Only this console's assistant can use this route." } }, { status: 403 });

  if (overVisitorLimit(request)) return Response.json({ error: { code: 'rate_limited', message: 'Too many questions for now. Try again in a while.' } }, { status: 429 });

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
    body: JSON.stringify({ ...body, model, store: false, max_output_tokens: MAX_OUTPUT_TOKENS }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (!upstream) return Response.json({ error: { code: 'unavailable', message: 'The model did not answer.' } }, { status: 502 });
  if (!upstream.ok) {
    console.error('Console model returned', upstream.status);
    return Response.json({ error: { code: 'unavailable', message: 'The model did not answer.' } }, { status: 502 });
  }
  return Response.json(await upstream.json());
}
