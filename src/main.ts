import { NestFactory }    from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { AppModule }      from './app.module';
import { json, urlencoded } from 'express';
import * as http   from 'http';
import * as https  from 'https';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { buildHttpsOptions } from './ssl/ssl-config.util';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });

  app.use(helmet());
  app.use(cookieParser());
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());

  // api/v{n}/<servicio>/... — cada ruta de negocio versiona independiente del MS downstream.
  // health y '/' quedan fuera del prefijo/versión para no romper los healthcheck de Docker.
  app.setGlobalPrefix('api', { exclude: ['health', '/'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1', prefix: 'v' });

  const origins = process.env.ALLOWED_ORIGINS;
  app.enableCors({
    origin:         process.env.NODE_ENV === 'development' ? true : (origins ? origins.split(',') : false),
    methods:        ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials:    true,
  });

  await app.init();
  const expressApp = app.getHttpAdapter().getInstance();

  // ── HTTP siempre activo ──
  const port = Number(process.env.PORT ?? 10601);
  http.createServer(expressApp).listen(port, () => {
    console.log(`🚀 apigw-cnl-cross  HTTP  → http://localhost:${port}`);
  });

  // ── HTTPS si USE_SSL=true y hay certificados ──
  const httpsOptions = buildHttpsOptions();
  if (httpsOptions) {
    const sslPort = Number(process.env.SSL_PORT ?? 20601);
    try {
      https.createServer(httpsOptions, expressApp).listen(sslPort, () => {
        console.log(`🔒 apigw-cnl-cross  HTTPS → https://localhost:${sslPort}`);
      });
    } catch (e: any) {
      console.error('❌ Error al iniciar HTTPS:', e.message, '— solo HTTP activo');
    }
  }
}

bootstrap().catch(err => {
  console.error('Error fatal al iniciar el gateway:', err);
  process.exit(1);
});
