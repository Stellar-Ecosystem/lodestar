/**
 * The single index of everything the API accepts.
 *
 * Each entry pairs a route's mount point with its declarative request schema.
 * `validate()` reads a spec to enforce it; `lib/openapi.js` reads this list to
 * document it. Adding a route means adding it to one of the modules below —
 * there is no second list to keep in sync.
 */
import * as agents from "./agents.js";
import * as demo from "./demo.js";
import * as registry from "./registry.js";
import * as services from "./services.js";

const GROUPS = [registry, agents, demo, services];

/**
 * Every route as `{ method, path, fullPath, summary, tags, request }`.
 * `path` is router-relative (what `router.get(...)` is given); `fullPath`
 * includes the mount point (what a client calls).
 */
export const routes = GROUPS.flatMap((group) =>
  group.routes.map((route) => ({
    ...route,
    basePath: group.basePath,
    fullPath: `${group.basePath}${route.path}`,
    tags: route.tags ?? group.tags,
  })),
);

export { agents, demo, registry, services };
