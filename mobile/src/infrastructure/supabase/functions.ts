// Edge Function の呼び出し。本文の error と code を ApiError にして返す
import { FunctionsHttpError } from '@supabase/supabase-js';

import { ApiError } from '../../lib/errors';
import { requireSupabase } from './client';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function callFunction<T>(path: string, method: HttpMethod, body?: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireSupabase().functions.invoke(path, { method, body });
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    const payload = await response.json().catch(() => null);
    throw new ApiError(
      typeof payload?.error === 'string' ? payload.error : error.message,
      response.status,
      typeof payload?.code === 'string' ? payload.code : undefined,
    );
  }
  if (error) throw error;
  return data as T;
}
