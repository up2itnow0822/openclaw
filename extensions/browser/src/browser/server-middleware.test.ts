import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./server-middleware.js";

describe("browser server middleware", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (!server) {
        continue;
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  async function listen(app: express.Express): Promise<string> {
    const server = await new Promise<Server>((resolve, reject) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
      started.once("error", reject);
    });
    servers.push(server);
    const address = server.address() as AddressInfo | null;
    if (!address?.port) {
      throw new Error("server address missing");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it("does not 500 when IncomingMessage.signal is a native read-only getter", async () => {
    const app = express();
    installBrowserCommonMiddleware(app);
    app.get("/", (_req, res) => {
      res.status(200).send("OK");
    });
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("still returns 401 for unauthenticated browser requests", async () => {
    const app = express();
    installBrowserCommonMiddleware(app);
    installBrowserAuthMiddleware(app, { token: "secret-token" });
    app.get("/", (_req, res) => {
      res.status(200).send("OK");
    });
    const baseUrl = await listen(app);

    const unauth = await fetch(`${baseUrl}/`);
    expect(unauth.status).toBe(401);
    expect(await unauth.text()).toBe("Unauthorized");

    const authed = await fetch(`${baseUrl}/`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(authed.status).toBe(200);
    expect(await authed.text()).toBe("OK");
  });
});
