import parseDuration, { Units } from "parse-duration";
import * as client from "./client.js";
import {
  INTERNAL_VERSION,
  RETRY_MAX_ATTEMPTS_PLACEHOLDER,
} from "./constants.js";
import { APIError, DeferError } from "./errors.js";
import { HTTPClient, makeHTTPClient } from "./httpClient.js";
import {
  debug,
  getEnv,
  randomUUID,
  sanitizeFunctionArguments,
} from "./utils.js";

const withDelay = (dt: Date, delay: Duration): Date =>
  new Date(dt.getTime() + parseDuration(delay)!);

export const __database = new Map<
  string,
  { id: string; state: client.ExecutionState; result?: any }
>();

function getHTTPClient(): HTTPClient | undefined {
  const accessToken = getEnv("DEFER_TOKEN");
  const endpoint = getEnv("DEFER_ENDPOINT") || "https://api.defer.run";

  if (accessToken) return makeHTTPClient(endpoint, accessToken);
  return;
}

export const deferEnabled = () => !!getEnv("DEFER_TOKEN");

async function execLocally(
  id: string,
  fn: any,
  args: any
): Promise<client.FetchExecutionResponse> {
  let state: client.ExecutionState = "succeed";
  let originalResult: any;
  try {
    originalResult = await fn(...args);
  } catch (error) {
    const e = error as Error;
    state = "failed";
    originalResult = {
      name: e.name,
      message: e.message,
      cause: e.cause,
      stack: e.stack,
    };
  }

  let result: any;
  try {
    result = JSON.parse(JSON.stringify(originalResult || ""));
  } catch (error) {
    const e = error as Error;
    throw new DeferError(`cannot serialize function return: ${e.message}`);
  }

  const response = { id, state, result };
  __database.set(id, response);

  return response;
}

async function enqueue<F extends DeferableFunction>(
  func: DeferredFunction<F>,
  ...args: Parameters<F>
): Promise<client.EnqueueExecutionResponse> {
  const originalFunction = func.__fn;
  const functionArguments = sanitizeFunctionArguments(args);
  debug(`[defer.run][${originalFunction.name}] invoked.`);

  const httpClient = getHTTPClient();
  if (httpClient) {
    const request: client.EnqueueExecutionRequest = {
      name: originalFunction.name,
      arguments: functionArguments,
      scheduleFor: new Date(),
      metadata: func.__execOptions?.metadata || {},
    };

    const delay = func.__execOptions?.delay;
    if (delay instanceof Date) {
      request.scheduleFor = delay;
    } else if (delay) {
      const now = new Date();
      request.scheduleFor = withDelay(now, delay);
    }

    const after = func.__execOptions?.discardAfter;
    if (after instanceof Date) {
      request.discardAfter = after;
    } else if (after) {
      const now = new Date();
      request.discardAfter = withDelay(now, after);
    }

    return client.enqueueExecution(httpClient, request);
  }

  debug(`[defer.run][${originalFunction.name}] defer ignore, no token found.`);

  const id = randomUUID();
  __database.set(id, { id: id, state: "started" });
  execLocally(id, originalFunction, functionArguments);
  return { id };
}

export type Duration = `${string}${Units}`;

export interface ExecutionMetadata {
  [key: string]: string;
}

export interface DeferredFunctionOptions {
  delay?: Duration | Date;
  metadata?: ExecutionMetadata;
  discardAfter?: Duration | Date;
}

// https://stackoverflow.com/questions/39494689/is-it-possible-to-restrict-number-to-a-certain-range/70307091#70307091
type Enumerate<
  N extends number,
  Acc extends number[] = []
> = Acc["length"] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc["length"]]>;

type Range<F extends number, T extends number> = Exclude<
  Enumerate<T>,
  Enumerate<F>
>;

export type Concurrency = Range<0, 51>;

export type NextRouteString = `/api/${string}`;

export interface Manifest {
  version: number;
  cron?: string;
  retry?: RetryPolicy;
  concurrency?: Concurrency | undefined;
  maxDuration?: number | undefined;
}

export interface RetryPolicy {
  maxAttempts: number;
  initialInterval: number;
  randomizationFactor: number;
  multiplier: number;
  maxInterval: number;
}

export interface DeferOptions {
  retry?: boolean | number | Partial<RetryPolicy>;
  concurrency?: Concurrency;
  maxDuration?: number;
}

export type DeferableFunction = (...args: any) => Promise<any>;

export interface ExecutionOptions {
  delay?: Duration | Date;
  metadata?: ExecutionMetadata;
  discardAfter?: Duration | Date;
}

export interface DeferredFunction<F extends DeferableFunction> {
  (...args: Parameters<F>): Promise<client.EnqueueExecutionResponse>;
  __metadata: Manifest;
  __fn: F;
  __execOptions?: ExecutionOptions;
}

export interface DeferredFunctionConfiguration {
  retry?: boolean | number | Partial<RetryPolicy>;
  concurrency?: Concurrency;
  maxDuration?: number;
}

function defaultRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: 0,
    initialInterval: 30,
    randomizationFactor: 0.5,
    multiplier: 1.5,
    maxInterval: 60 * 10,
  };
}

function parseRetryPolicy(options?: DeferOptions): RetryPolicy {
  const retryPolicy: RetryPolicy = defaultRetryPolicy();
  switch (typeof options?.retry) {
    case "boolean": {
      if (options.retry) {
        retryPolicy.maxAttempts = RETRY_MAX_ATTEMPTS_PLACEHOLDER;
      }
      break;
    }
    case "number": {
      retryPolicy.maxAttempts = options.retry;
      break;
    }
    case "object": {
      if (options.retry.maxAttempts) {
        retryPolicy.maxAttempts = options.retry.maxAttempts;
      } else {
        options.retry.maxAttempts = RETRY_MAX_ATTEMPTS_PLACEHOLDER;
      }

      if (options.retry.initialInterval)
        retryPolicy.initialInterval = options.retry.initialInterval;

      if (options.retry.randomizationFactor)
        retryPolicy.randomizationFactor = options.retry.randomizationFactor;

      if (options.retry.multiplier)
        retryPolicy.multiplier = options.retry.multiplier;

      if (options.retry.maxInterval)
        retryPolicy.maxInterval = options.retry.maxInterval;

      break;
    }
    case "undefined": {
      retryPolicy.maxAttempts = 0;
      break;
    }
    default: {
      throw new Error("invalid retry options");
    }
  }

  return retryPolicy;
}

export function defer<F extends DeferableFunction>(
  fn: F,
  config?: DeferredFunctionConfiguration
): DeferredFunction<F> {
  const wrapped = async function (
    ...args: Parameters<typeof fn>
  ): Promise<client.EnqueueExecutionResponse> {
    return enqueue(wrapped, ...args);
  };

  wrapped.__fn = fn;
  wrapped.__metadata = {
    version: INTERNAL_VERSION,
    retry: parseRetryPolicy(config),
    concurrency: config?.concurrency,
    maxDuration: config?.maxDuration,
  };

  return wrapped;
}

defer.cron = function (
  fn: DeferableFunction,
  cronExpr: string,
  config?: DeferredFunctionConfiguration
): DeferredFunction<typeof fn> {
  const wrapped = async function (
    ...args: Parameters<typeof fn>
  ): Promise<client.EnqueueExecutionResponse> {
    return enqueue(wrapped, ...args);
  };

  wrapped.__fn = fn;
  wrapped.__metadata = {
    version: INTERNAL_VERSION,
    retry: parseRetryPolicy(config),
    cron: cronExpr,
    concurrency: config?.concurrency,
    maxDuration: config?.maxDuration,
  };

  return wrapped;
};

export function delay<F extends DeferableFunction>(
  fn: DeferredFunction<F>,
  delay: Duration | Date
): DeferredFunction<F> {
  const wrapped = async function (
    ...args: Parameters<typeof fn>
  ): Promise<client.EnqueueExecutionResponse> {
    return enqueue(wrapped, ...args);
  };

  wrapped.__fn = fn.__fn;
  wrapped.__metadata = fn.__metadata;
  wrapped.__execOptions = { ...fn.__execOptions, delay };
  return wrapped;
}

export function addMetadata<F extends DeferableFunction>(
  fn: DeferredFunction<F>,
  metadata: ExecutionMetadata
): DeferredFunction<F> {
  const gatheredMetadata = { ...fn.__execOptions?.metadata, ...metadata };
  const wrapped = async function (
    ...args: Parameters<typeof fn>
  ): Promise<client.EnqueueExecutionResponse> {
    return enqueue(wrapped, ...args);
  };
  wrapped.__fn = fn.__fn;
  wrapped.__metadata = fn.__metadata;
  wrapped.__execOptions = { ...fn.__execOptions, metadata: gatheredMetadata };
  return wrapped;
}

export function discardAfter<F extends DeferableFunction>(
  fn: DeferredFunction<F>,
  value: Duration | Date
): DeferredFunction<F> {
  const wrapped = async function (
    ...args: Parameters<typeof fn>
  ): Promise<client.EnqueueExecutionResponse> {
    return enqueue(wrapped, ...args);
  };

  wrapped.__fn = fn.__fn;
  wrapped.__metadata = fn.__metadata;
  wrapped.__execOptions = { ...fn.__execOptions, discardAfter: value };
  return wrapped;
}

export function awaitResult<F extends DeferableFunction>(
  fn: DeferredFunction<F>
): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> {
  return async function (
    ...args: Parameters<F>
  ): Promise<Awaited<ReturnType<F>>> {
    const originalFunction = fn.__fn;
    const functionArguments = sanitizeFunctionArguments(args);
    const httpClient = getHTTPClient();

    let response: client.FetchExecutionResponse;
    if (httpClient) {
      const { id } = await client.enqueueExecution(httpClient, {
        name: originalFunction.name,
        arguments: functionArguments,
        scheduleFor: new Date(),
        metadata: {},
      });
      response = await client.waitExecutionResult(httpClient, { id: id });
    } else {
      const id = randomUUID();
      __database.set(id, { id: id, state: "started" });
      response = await execLocally(id, originalFunction, functionArguments);
    }

    if (response.state === "failed") {
      let error = new DeferError("Defer execution failed");
      if (response.result?.message) {
        error = new DeferError(response.result.message);
        error.stack = response.result.stack;
      } else if (response.result) {
        error = response.result;
      }
      throw error;
    }

    return response.result;
  };
}

export async function getExecution(
  id: string
): Promise<client.FetchExecutionResponse> {
  const httpClient = getHTTPClient();
  if (httpClient) return client.fetchExecution(httpClient, { id });
  const response = __database.get(id);
  if (response)
    return Promise.resolve({
      ...response,
      state: response.state,
    });

  throw new APIError("execution not found", "not found");
}

export async function cancelExecution(
  id: string,
  force = false
): Promise<client.CancelExecutionResponse> {
  const httpClient = getHTTPClient();
  if (httpClient) return client.cancelExecution(httpClient, { id, force });

  return {};
}

export async function getExecutionTries(
  id: string
): Promise<client.GetExecutionTriesResponse> {
  const httpClient = getHTTPClient();
  if (httpClient) return client.getExecutionTries(httpClient, { id });

  const response = __database.get(id);
  if (response)
    return Promise.resolve([{ id: response.id, state: response.state }]);

  throw new APIError("execution not found", "not found");
}

export async function rescheduleExecution(
  id: string,
  scheduleFor: Duration | Date | undefined
): Promise<client.RescheduleExecutionResponse> {
  const request: client.RescheduleExecutionRequest = {
    id,
    scheduleFor: new Date(),
  };
  if (scheduleFor instanceof Date) {
    request.scheduleFor = scheduleFor;
  } else if (scheduleFor) {
    const now = new Date();
    request.scheduleFor = withDelay(now, scheduleFor);
  }

  const httpClient = getHTTPClient();
  if (httpClient) return client.rescheduleExecution(httpClient, request);

  return {};
}
