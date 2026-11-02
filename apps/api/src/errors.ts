export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// Typed error base for the central error handler. Anything that is not an
// `ApiError` is treated as an unexpected failure and never leaks its message
// to the client.
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHENTICATED", message);
  }
}

export class InvalidJsonError extends ApiError {
  constructor() {
    super(400, "INVALID_JSON", "Malformed JSON body");
  }
}

export class PayloadTooLargeError extends ApiError {
  constructor() {
    super(413, "PAYLOAD_TOO_LARGE", "Payload too large");
  }
}

// body-parser reports its failures through a `type` property. We do not import
// body-parser (or its types) directly, so this guard recognises only the two
// failures we translate and treats everything else as unexpected.
export type BodyParserErrorType = "entity.parse.failed" | "entity.too.large";

export function getBodyParserErrorType(error: unknown): BodyParserErrorType | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const type = (error as { type?: unknown }).type;
  if (type === "entity.parse.failed" || type === "entity.too.large") {
    return type;
  }

  return null;
}

export function apiErrorBody(error: ApiError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
