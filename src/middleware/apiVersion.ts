import type { Request, Response, NextFunction } from "express";

/**
 * Middleware that sets an `Api-Version` response header so clients
 * can always see which API version served the request.
 */
export const apiVersionHeader =
  (version: string) => (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Api-Version", version);
    next();
  };
