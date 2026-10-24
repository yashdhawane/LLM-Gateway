import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const TraceId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.traceId ?? request.id;
  },
);

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

export const RequestId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const incoming = request.headers?.['x-request-id'];
    const headerValue = Array.isArray(incoming) ? incoming[0] : incoming;
    const fallback = request.traceId ?? request.id ?? 'unknown';

    return String(headerValue || fallback).slice(0, 128);
  },
);