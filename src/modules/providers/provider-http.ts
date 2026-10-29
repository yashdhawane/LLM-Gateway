import { HttpService } from '@nestjs/axios';
import { AxiosRequestConfig, AxiosResponse } from 'axios';
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
