import type { Express, Request, Response } from "express";
import express from "express";
import { browserMutationGuardMiddleware } from "./csrf.js";
import { isAuthorizedBrowserRequest } from "./http-auth.js";

export const BROWSER_AUTH_VERIFIED_FLAG = "__openclawBrowserAuthVerified";

type BrowserAuthMarkedRequest = Request & {
  [BROWSER_AUTH_VERIFIED_FLAG]?: boolean;
};

export function hasVerifiedBrowserAuth(req: Request): boolean {
  return (req as BrowserAuthMarkedRequest)[BROWSER_AUTH_VERIFIED_FLAG] === true;
}

function markVerifiedBrowserAuth(req: Request) {
  (req as BrowserAuthMarkedRequest)[BROWSER_AUTH_VERIFIED_FLAG] = true;
}

function readRequestSignal(req: Request): AbortSignal | undefined {
  const signal = (req as unknown as { signal?: AbortSignal }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function canAssignRequestSignal(req: Request): boolean {
  const descriptor =
    Object.getOwnPropertyDescriptor(req, "signal") ??
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(req), "signal");
  if (!descriptor) {
    return true;
  }
  if (descriptor.writable === true) {
    return true;
  }
  return typeof descriptor.set === "function";
}

function attachRequestAbortSignal(req: Request, res: Response): void {
  if (readRequestSignal(req) || !canAssignRequestSignal(req)) {
    return;
  }
  const ctrl = new AbortController();
  const abort = () => {
    if (!ctrl.signal.aborted) {
      ctrl.abort(new Error("request aborted"));
    }
  };
  req.once("aborted", abort);
  res.once("close", () => {
    if (!res.writableEnded) {
      abort();
    }
  });
  (req as unknown as { signal?: AbortSignal }).signal = ctrl.signal;
}

export function installBrowserCommonMiddleware(app: Express) {
  app.use((req, res, next) => {
    // Node 24+ exposes a read-only IncomingMessage.signal getter. Reuse it
    // and only polyfill on runtimes where the property is still writable.
    attachRequestAbortSignal(req, res);
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(browserMutationGuardMiddleware());
}

export function installBrowserAuthMiddleware(
  app: Express,
  auth: { token?: string; password?: string },
) {
  if (!auth.token && !auth.password) {
    return;
  }
  app.use((req, res, next) => {
    if (isAuthorizedBrowserRequest(req, auth)) {
      markVerifiedBrowserAuth(req);
      return next();
    }
    res.status(401).send("Unauthorized");
  });
}
