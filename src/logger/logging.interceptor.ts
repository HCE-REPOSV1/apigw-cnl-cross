import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { KafkaLoggerService } from './kafka-logger.service';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: KafkaLoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();

    // ── 0. Excluir /health — son pings del HEALTHCHECK de Docker, no tráfico real.
    if (req.url === '/health') {
      return next.handle();
    }

    const start = Date.now();

    // ── 1. Extraer identidad del JWT (decodificación sin verificación) ──
    //    Solo lectura de claims para audit — la verificación la hace JwtAuthGuard.
    //    El token puede venir como cookie (access_token) o como header Authorization;
    //    gateway.service.ts solo convierte cookie→Bearer DESPUÉS de que este interceptor
    //    ya corrió, así que hay que leer la cookie aquí también (igual que JwtAuthGuard).
    const cookieToken = req.cookies?.['access_token'] as string | undefined;
    const authHeader  = req.headers['authorization'] as string | undefined;
    const { userId, username, sessionId } = this.decodeJwt(
      cookieToken ? `Bearer ${cookieToken}` : authHeader,
    );

    // ── 2. Generar o propagar traceId ───────────────────────────────────
    //    Si el request ya trae X-Trace-ID (encadenado entre microservicios),
    //    se reutiliza. Si no, se genera uno nuevo.
    const traceId = (req.headers['x-trace-id'] as string) ?? randomUUID();

    // ── 3. Inyectar headers de audit en el request ─────────────────────
    //    gateway.service.ts copia req.headers al hacer el proxy,
    //    así los microservicios downstream reciben el contexto de audit.
    req.headers['x-trace-id'] = traceId;
    req.headers['x-user-id']  = userId;
    req.headers['x-username'] = username;

    return next.handle().pipe(
      tap({
        next: () => {
          const res      = context.switchToHttp().getResponse();
          const duration = Date.now() - start;
          // publishLog es void y fire-and-forget internamente —
          // nunca propaga errores de Kafka hacia este observable.
          this.logger.publishLog({
            event_type:    'GATEWAY_REQUEST',
            level:         'INFO',
            source_system: 'apigw-cnl-cross',
            trace_id:      traceId,
            user_id:       userId,
            username,
            session_id:    sessionId,
            action:        `${req.method} ${req.url}`,
            outcome:       res.statusCode < 400 ? 'SUCCESS' : 'FAILED',
            ip_address:    (req.headers['x-forwarded-for'] as string) ?? req.ip,
            user_agent:    req.headers['user-agent'] as string,
            message:       `${req.method} ${req.url} — ${res.statusCode} (${duration}ms)`,
            payload: {
              method:     req.method,
              url:        req.url,
              statusCode: res.statusCode,
              duration,
            },
          });
        },
        error: (err) => {
          const duration = Date.now() - start;
          this.logger.publishLog({
            event_type:    'GATEWAY_REQUEST',
            level:         'ERROR',
            source_system: 'apigw-cnl-cross',
            trace_id:      traceId,
            user_id:       userId,
            username,
            session_id:    sessionId,
            action:        `${req.method} ${req.url}`,
            outcome:       'ERROR',
            ip_address:    (req.headers['x-forwarded-for'] as string) ?? req.ip,
            user_agent:    req.headers['user-agent'] as string,
            message:       `${req.method} ${req.url} — ERROR (${duration}ms): ${err?.message}`,
            payload:       { method: req.method, url: req.url, duration, error: err?.message },
          });
        },
      }),
    );
  }

  /**
   * Decodifica el payload del JWT sin verificar la firma.
   * La verificación de firma ya la hace JwtAuthGuard en rutas protegidas.
   * Aquí solo necesitamos los claims para el registro de audit.
   */
  private decodeJwt(authHeader: string | undefined): { userId: string; username: string; sessionId: string } {
    const empty = { userId: 'anonymous', username: 'anonymous', sessionId: '' };
    try {
      if (!authHeader?.startsWith('Bearer ')) return empty;
      const token   = authHeader.split(' ')[1];
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
      return {
        userId:    payload.sub       ?? 'anonymous',
        username:  payload.username  ?? 'anonymous',
        sessionId: payload.sessionId ?? '',
      };
    } catch {
      return empty;
    }
  }
}
