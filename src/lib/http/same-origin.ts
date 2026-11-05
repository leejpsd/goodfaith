// These routes carry no login, so there is no session to steal. This keeps other sites and bare
// scripts from driving them, since browsers always send Origin on a POST.
export function fromThisSite(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const notFromThisSite = () => Response.json({ refused: 'bad_origin' }, { status: 403 });
