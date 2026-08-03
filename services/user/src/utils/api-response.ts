import type { Response } from "express";

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface SuccessBody<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}

export function sendSuccess<T>(res: Response, data: T, statusCode = 200): Response {
  const body: SuccessBody<T> = { success: true, data };
  return res.status(statusCode).json(body);
}

export function sendCreated<T>(res: Response, data: T): Response {
  return sendSuccess(res, data, 201);
}

export function sendNoContent(res: Response): Response {
  return res.status(204).send();
}

export function sendPaginated<T>(
  res: Response,
  items: T[],
  { page, limit, total }: { page: number; limit: number; total: number },
): Response {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  const body: SuccessBody<T[]> = {
    success: true,
    data: items,
    meta: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1 && total > 0,
    },
  };
  return res.status(200).json(body);
}
