import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

// Express 4 does not forward rejected promises to the error handler, so every
// async route/controller is wrapped explicitly. No extra dependency needed.
export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req, res, next): void => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
