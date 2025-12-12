import { Request } from "express";

// Error with code
export interface ErrorWithCode extends Error {
  code?: number | string;
}

// Express request with query params
export interface RequestWithQuery extends Request {
  query: {
    uuid?: string;
    uid?: string;
    eventId?: string;
    attendees?: string | string[];
    calendarId?: string;
    code?: string;
  };
}

// Task dispatch options
export interface TaskDispatchOptions {
  functionName: string;
  data: unknown;
  deadline?: number;
  scheduleDelaySeconds?: number;
  location?: string;
}

// Async result tuple
export type AsyncResult<T> = [Error | null, T | null];

// Analytics event params
export interface AnalyticsEventParams {
  traffic_type?: string;
  action?: string;
  reason?: string;
  error_type?: string;
  result?: string;
  operation?: string;
  [key: string]: string | undefined;
}
