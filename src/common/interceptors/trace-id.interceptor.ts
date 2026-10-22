import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class TraceIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const traceId = request.headers['x-trace-id'] as string || uuidv4();

    request.traceId = traceId;

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse();
        response.header('x-trace-id', traceId);
      }),
    );
  }
}