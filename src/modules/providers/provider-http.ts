import { HttpService } from '@nestjs/axios';
import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Readable } from 'node:stream';
import { firstValueFrom } from 'rxjs';
import { ProviderError } from './base.provider';

/**
 * Executes an HTTP request with a real abort signal. Unlike a bare RxJS
 * timeout, this cancels the underlying socket so a timed-out request cannot
 * continue consuming upstream capacity.
 */
export async function requestWithTimeout<T>(
  httpService: HttpService,
  config: AxiosRequestConfig,
  timeoutMs: number,
): Promise<AxiosResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, timeoutMs),
  );

  try {
    return await firstValueFrom(
      httpService.request<T>({ ...config, signal: controller.signal }),
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderError('PROVIDER_TIMEOUT', 'Provider request timed out');
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opens a server-sent-event response and returns the byte stream.
 *
 * `timeoutMs` bounds the wait for the response headers only; once the stream is
 * open the caller owns it and enforces idle and total limits. The caller's
 * `signal` stays attached after this function returns, so aborting it later
 * destroys the socket and stops a provider that is already talking.
 */
export async function openEventStream(
  httpService: HttpService,
  config: AxiosRequestConfig,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Readable> {
  const controller = new AbortController();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await firstValueFrom(
      httpService.request<Readable>({
        ...config,
        responseType: 'stream',
        signal: controller.signal,
      }),
    );

    return response.data;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new ProviderError('PROVIDER_TIMEOUT', 'Provider request timed out');
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function mapHttpProviderError(
  error: unknown,
  providerName: string,
): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  const err = error as any;
  const status = err?.response?.status;
  const message = typeof err?.message === 'string' ? err.message : '';

  if (
    err?.name === 'TimeoutError' ||
    err?.code === 'ECONNABORTED' ||
    err?.code === 'ERR_CANCELED' ||
    /timeout/i.test(message)
  ) {
    return new ProviderError(
      'PROVIDER_TIMEOUT',
      'Provider request timed out',
      status,
    );
  }

  if (status === 429) {
    return new ProviderError(
      'PROVIDER_RATE_LIMIT',
      'Provider rate limit exceeded',
      status,
    );
  }

  if (status === 400 || status === 422) {
    return new ProviderError(
      'PROVIDER_BAD_REQUEST',
      'Provider rejected the request',
      status,
    );
  }

  if (status === 401 || status === 403) {
    return new ProviderError(
      'PROVIDER_NOT_CONFIGURED',
      `Provider '${providerName}' rejected its credentials`,
      status,
    );
  }

  if (typeof status === 'number' && (status >= 500 || status === 529)) {
    return new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'Provider is unavailable',
      status,
    );
  }

  return new ProviderError(
    'PROVIDER_ERROR',
    'Provider request failed',
    status,
  );
}
