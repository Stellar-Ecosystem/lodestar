/**
 * Request schemas for the x402-paid demo services (mounted at `/demo`).
 */
import { z, floatQueryParam, intQueryParam, requiredString } from "./common.js";
import { ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT } from "../lib/activityFeed.js";

export const basePath = "/demo";
export const tags = ["demo-services"];

/** Correlates a demo run with the activity entry it produces. */
const demoRunId = z
  .string()
  .optional()
  .describe("Opaque ID echoed into the activity feed");

export const getWeather = {
  method: "get",
  path: "/weather",
  summary: "Current weather for a coordinate pair",
  request: {
    query: {
      schema: z.object({
        lat: floatQueryParam({
          field: "lat",
          min: -90,
          max: 90,
          defaultValue: 40.7128,
          message: "Coordinates out of range",
        }).describe("Latitude in degrees"),
        lon: floatQueryParam({
          field: "lon",
          min: -180,
          max: 180,
          defaultValue: -74.006,
          message: "Coordinates out of range",
        }).describe("Longitude in degrees"),
        demoRunId,
      }),
      code: "INVALID_COORDINATES",
    },
  },
};

export const getSearch = {
  method: "get",
  path: "/search",
  summary: "Web search results",
  request: {
    query: {
      schema: z.object({
        q: requiredString("q", { description: "Search terms" }),
        demoRunId,
      }),
      code: "MISSING_QUERY",
      message: "Query parameter `q` is required",
    },
  },
};

export const getActivity = {
  method: "get",
  path: "/activity",
  summary: "Recent paid-service activity across all agents",
  request: {
    query: {
      schema: z.object({
        limit: intQueryParam({
          field: "limit",
          min: 1,
          max: ACTIVITY_MAX_LIMIT,
          defaultValue: ACTIVITY_DEFAULT_LIMIT,
          message: "`limit` must be a positive integer",
        }).describe(`Entries per page; clamped to ${ACTIVITY_MAX_LIMIT}`),
        offset: intQueryParam({
          field: "offset",
          defaultValue: 0,
          message: "`offset` must be a non-negative integer",
        }).describe("Entries to skip"),
      }),
      code: "INVALID_PAGINATION",
    },
  },
};

export const routes = [getWeather, getSearch, getActivity];
