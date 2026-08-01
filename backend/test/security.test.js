import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import helmet from "helmet";

describe("Security Headers (Helmet Middleware)", () => {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.get("/healthz", (_req, res) => res.json({ status: "healthy" }));

  it("omits the X-Powered-By header", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("includes X-Content-Type-Options: nosniff", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("includes X-Frame-Options header", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["x-frame-options"]).toBeDefined();
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("includes Strict-Transport-Security header", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["strict-transport-security"]).toBeDefined();
  });

  it("includes Content-Security-Policy header", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["content-security-policy"]).toBeDefined();
  });
});
