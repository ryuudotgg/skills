import type { Bytes, Id } from "skills-core";
import type { Chain } from "./chain.ts";
import type { Refusal } from "./refusal.ts";
import type { Incarnations, Tx } from "./store.ts";

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export type CallerKind = "member" | "pending" | "recovery";

export type Caller =
  | { readonly kind: "anonymous" }
  | { readonly kind: "member"; readonly device: Id }
  | { readonly kind: "pending"; readonly device: Id; readonly invite: Id }
  | { readonly kind: "recovery" };

export type Access =
  | { readonly kind: "open" }
  | { readonly kind: "unsigned" }
  | { readonly kind: "signed"; readonly callers: readonly CallerKind[] };

export type Answer =
  | { readonly status: number; readonly body: unknown; readonly chain?: Chain }
  | Refusal;

export type Effect = (tx: Tx) => Answer;

export type HubState = {
  readonly incarnations: Incarnations;
  readonly initCode: string | undefined;
  readonly now: () => number;
};

export type Context<C extends Caller = Caller> = {
  readonly caller: C;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: Bytes;
  readonly chain: Chain;
  readonly hub: HubState;
};

export type Route = {
  readonly method: Method;
  readonly pattern: string;
  readonly access: Access;
  readonly limit: number;
  readonly prepare: (context: Context) => Promise<Effect>;
};

export const MEMBER: Access = { kind: "signed", callers: ["member"] };

export const KIB = 1024;

export const MIB = 1024 * KIB;

export function ok(body: unknown, status = 200): Effect {
  return () => ({ status, body });
}

export function member(caller: Caller): Id {
  if (caller.kind !== "member") throw new TypeError("this route admits member devices only");
  return caller.device;
}
