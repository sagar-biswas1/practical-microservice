import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { env } from "../config/env.js";
import {
  BadRequestError,
  ConflictError,
  ServiceUnavailableError,
  type AppError,
} from "../errors/app-error.js";
import { ACTOR_HEADER, REQUEST_ID_HEADER } from "../middlewares/request-context.js";
import { attempt, type Result } from "../utils/result.js";

/**
 * Client for the user service's profile API.
 *
 * A copy of a contract owned by another service, not a shared type. Only the
 * fields listed here are relied upon, and the shape is allowed to lag behind
 * theirs.
 */
export interface CreateUserProfileInput {
  /** This service's `auth_users.id`. The user service's key back to us. */
  authUserId: string;
  name: string;
  email: string;
  address: string;
  phone: string;
}

export interface UserProfile {
  id: string;
  authUserId: string;
  name: string;
  email: string;
}

export interface CallContext {
  requestId?: string | undefined;
  /** Attributes the write in the user service's audit log. */
  actor?: string | undefined;
}

export interface UserClient {
  createProfile(
    input: CreateUserProfileInput,
    context?: CallContext,
  ): Promise<Result<UserProfile>>;
  /** Resolves an existing profile, or `[null, null]` when there is none. */
  findByAuthUserId(
    authUserId: string,
    context?: CallContext,
  ): Promise<Result<UserProfile | null>>;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { message?: string };
}

export class HttpUserClient implements UserClient {
  private readonly http: AxiosInstance;

  constructor(
    baseUrl: string = env.USER_SERVICE_URL,
    timeoutMs: number = env.USER_TIMEOUT_MS,
    http?: AxiosInstance,
  ) {
    this.http =
      http ??
      axios.create({
        baseURL: baseUrl,
        timeout: timeoutMs,
        headers: { accept: "application/json" },
        validateStatus: () => true,
      });
  }

  async createProfile(
    input: CreateUserProfileInput,
    context?: CallContext,
  ): Promise<Result<UserProfile>> {
    const [error, profile] = await this.request<UserProfile>(
      "POST",
      "/api/v1/users",
      context,
      input,
    );
    if (error) return [error, null];
    return [null, profile as UserProfile];
  }

  async findByAuthUserId(
    authUserId: string,
    context?: CallContext,
  ): Promise<Result<UserProfile | null>> {
    return this.request<UserProfile | null>(
      "GET",
      `/api/v1/users/auth/${encodeURIComponent(authUserId)}`,
      context,
      undefined,
      { nullOn404: true },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    context?: CallContext,
    body?: unknown,
    options: { nullOn404?: boolean } = {},
  ): Promise<Result<T>> {
    const headers: Record<string, string> = {};
    // Propagated so one correlation id — and one actor — spans both services.
    if (context?.requestId) headers[REQUEST_ID_HEADER] = context.requestId;
    if (context?.actor) headers[ACTOR_HEADER] = context.actor;

    const [transportError, response] = await attempt(() =>
      this.http.request<Envelope<T>>({
        method,
        url: path,
        headers,
        ...(body !== undefined ? { data: body } : {}),
      }),
    );

    if (transportError) {
      return [new ServiceUnavailableError("User service is unreachable", transportError), null];
    }

    if (response.status === 204) return [null, null as T];

    if (response.status >= 200 && response.status < 300) {
      return [null, response.data.data];
    }

    if (response.status === 404 && options.nullOn404) return [null, null as T];

    return [this.toError(response), null];
  }

  /**
   * Translates a user-service failure into this service's vocabulary.
   *
   * A 409 is kept as a 409 because it is the one status with a meaning the
   * caller can act on: the profile already exists, which happens when a
   * previous hand-off committed there but its response never made it back
   * here. Everything else that is not our payload's fault becomes a 503.
   */
  private toError(response: AxiosResponse<Envelope<unknown>>): AppError {
    const message = response.data?.error?.message ?? `HTTP ${response.status}`;

    if (response.status >= 500) {
      return new ServiceUnavailableError(`User service failed: ${message}`);
    }

    switch (response.status) {
      case 409:
        return new ConflictError(message);
      case 404:
        return new ServiceUnavailableError(`User record is missing: ${message}`);
      default:
        return new BadRequestError(`User service rejected the request: ${message}`);
    }
  }
}
