// Node has no `cloudflare:workers`; the OAuth provider only needs WorkerEntrypoint from it to exist.
import { registerHooks } from "node:module";

registerHooks({
  resolve: (specifier, context, next) => specifier === "cloudflare:workers" ? { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true } : next(specifier, context),
});
