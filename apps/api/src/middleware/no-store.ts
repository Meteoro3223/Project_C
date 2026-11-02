import type { RequestHandler } from "express";

export const CACHE_CONTROL_HEADER = "Cache-Control";
export const NO_STORE_CACHE_CONTROL = "no-store";

// API responses are per-workspace and must never be cached by a browser or an
// intermediary proxy.
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader(CACHE_CONTROL_HEADER, NO_STORE_CACHE_CONTROL);
  next();
};
