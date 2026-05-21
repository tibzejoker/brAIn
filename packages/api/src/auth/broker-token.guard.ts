import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { BrokerService, getDb, getSetting } from "@brain/core";
import { timingSafeEqual } from "node:crypto";

/**
 * Gates mutating node operations behind the broker token.
 *
 * Only enforced when WE are an **embedded hub that owns a token** — i.e.
 * another machine could have joined our bus and could otherwise POST to
 * our `/nodes` endpoint unauthenticated (the bus join needs the token, but
 * the HTTP port doesn't). A guest must present that same broker token as
 * `Authorization: Bearer <token>` to spawn/kill at us.
 *
 * In external mode (we joined someone else) we hold no token of our own,
 * so the guard is a no-op for our own local dashboard. The token-based
 * model is the first pass; a per-type "network-spawnable" allowlist is a
 * later evolution.
 */
@Injectable()
export class BrokerTokenGuard implements CanActivate {
  constructor(private readonly broker: BrokerService) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.broker.getMode() !== "embedded") return true;
    const token = getSetting(getDb(), "broker_token");
    if (!token) return true; // token-less hub — nothing to enforce

    const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
      ? auth.slice(7).trim()
      : null;
    if (bearer && safeEqual(bearer, token)) return true;
    throw new UnauthorizedException("missing or invalid broker token");
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
