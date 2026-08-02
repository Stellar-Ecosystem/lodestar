/**
 * Request schema for the demo orchestration route (mounted at `/api`).
 */
import { z, positiveIntegerField } from "./common.js";

export const basePath = "/api";
export const tags = ["demo"];

/**
 * Only the two categories that have a loopback demo endpoint are accepted.
 * `demoValidate.js` still owns the SSRF rewrite of the on-chain URL — that runs
 * against contract state, not against the request, so it stays where it is.
 */
export const runDemo = {
  method: "post",
  path: "/demo-run",
  summary: "Pay for and call a registered demo service end to end",
  request: {
    body: z.object({
      serviceId: positiveIntegerField("serviceId"),
      category: z.enum(["weather", "search"], {
        error: "`category` must be weather or search",
      }),
    }),
  },
};

export const routes = [runDemo];
