import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to enforce Content-Type: application/json for endpoints that require JSON bodies
 * This middleware should be applied before express.json() parser to ensure proper content-type validation
 */
export function requireJson(req: Request, res: Response, next: NextFunction) {
  // Skip content-type validation for GET, HEAD, DELETE requests that typically don't have bodies
  if (['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    return next();
  }

  // For POST, PUT, PATCH requests, check if Content-Type header is present and correct
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.header('Content-Type');
    
    // Check if the request has a body (based on Content-Length or Transfer-Encoding)
    const hasBody = req.headers['content-length'] && 
                   parseInt(req.headers['content-length'] as string, 10) > 0 ||
                   req.headers['transfer-encoding'] === 'chunked';

    // If there's a body, enforce application/json content type
    if (hasBody) {
      if (!contentType) {
        return res.status(415).json({
          success: false,
          error: 'Unsupported Media Type',
          message: 'Content-Type header is required for requests with a body'
        });
      }

      // Check if content type is application/json (allow charset parameter)
      if (!contentType.toLowerCase().startsWith('application/json')) {
        return res.status(415).json({
          success: false,
          error: 'Unsupported Media Type',
          message: 'Content-Type must be application/json'
        });
      }
    }
  }

  next();
}

/**
 * Middleware to validate JSON payload and handle parse errors consistently
 * This should be applied after express.json() parser
 */
export function validateJsonPayload(req: Request, res: Response, next: NextFunction) {
  // Skip validation for methods that typically don't have bodies
  if (['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    return next();
  }

  // Check if there was a JSON parsing error
  if ((req as any).jsonParseError) {
    return res.status(400).json({
      success: false,
      error: 'Bad Request',
      message: 'Invalid JSON payload'
    });
  }

  next();
}

/**
 * Combined middleware that handles both content-type enforcement and JSON validation
 * This should be used as a replacement for the standard express.json() middleware
 */
export function jsonMiddleware() {
  return [
    requireJson,
    // Custom JSON parser that captures parse errors
    (req: Request, res: Response, next: NextFunction) => {
      const originalJson = require('express').json;
      const parser = originalJson({ limit: '10mb' });
      
      parser(req, res, (err: any) => {
        if (err) {
          (req as any).jsonParseError = err;
        }
        next();
      });
    },
    validateJsonPayload
  ];
}
