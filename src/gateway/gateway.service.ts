import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class GatewayService {
  private readonly svcMap: Record<string, string>;

  constructor(
    private readonly http: HttpService,
    private readonly cfg:  ConfigService,
  ) {
    this.svcMap = {
      '/auth':         this.cfg.get('AUTH_URL',          'http://localhost:10701'),
      '/audit':        this.cfg.get('CNL_AUDIT_URL',     'http://localhost:10703'),
      '/catalogs':     this.cfg.get('CNL_CATALOGS_URL',  'http://localhost:10704'),
      '/organization': this.cfg.get('CNL_CATALOGS_URL',  'http://localhost:10704'),
      '/i18n':         this.cfg.get('CNL_CATALOGS_URL',  'http://localhost:10704'),
      '/media':        this.cfg.get('CNL_MEDIA_URL',     'http://localhost:10702'),
    };
  }

  async proxyRequest(req: Request, res: Response, prefix: string) {
    const baseUrl = this.svcMap[`/${prefix}`];
    if (!baseUrl) return res.status(404).json({ error: `Service /${prefix} not found` });

    // Prevenir path traversal antes de construir la URL destino
    const rawUrl = req.url ?? '/';
    if (rawUrl.includes('..') || /%2e%2e/i.test(rawUrl)) {
      return res.status(400).json({ error: 'Ruta no permitida' });
    }

    const targetUrl = `${baseUrl}${rawUrl}`;
    const headers   = { ...req.headers };
    delete headers['host'];
    delete headers['connection'];
    delete headers['content-length'];

    // Si no hay Authorization header pero sí cookie, inyectar el token como Bearer
    // para que los microservicios downstream puedan validarlo
    if (!headers['authorization'] && req.cookies?.['access_token']) {
      headers['authorization'] = `Bearer ${req.cookies['access_token']}`;
    }

    try {
      const r = await firstValueFrom(
        this.http.request({
          method: req.method as any,
          url: targetUrl,
          headers,
          data: req.body,
          validateStatus: () => true,
        }),
      );

      // Reenviar Set-Cookie del servicio upstream al navegador
      const setCookie = r.headers['set-cookie'];
      if (setCookie) res.setHeader('set-cookie', setCookie);

      return res.status(r.status).json(r.data);
    } catch (err: any) {
      return res.status(502).json({ error: 'Bad Gateway', detail: err.message });
    }
  }

  async proxyBinaryRequest(req: Request, res: Response, prefix: string) {
    const baseUrl = this.svcMap[`/${prefix}`];
    if (!baseUrl) return res.status(404).json({ error: `Service /${prefix} not found` });

    const rawUrl = req.url ?? '/';
    if (rawUrl.includes('..') || /%2e%2e/i.test(rawUrl)) {
      return res.status(400).json({ error: 'Ruta no permitida' });
    }

    const targetUrl = `${baseUrl}${rawUrl}`;
    const headers   = { ...req.headers };
    delete headers['host'];
    delete headers['connection'];
    delete headers['content-length'];

    if (!headers['authorization'] && req.cookies?.['access_token']) {
      headers['authorization'] = `Bearer ${req.cookies['access_token']}`;
    }

    try {
      const r = await firstValueFrom(
        this.http.request({
          method:         req.method as any,
          url:            targetUrl,
          headers,
          data:           req.body,
          responseType:   'stream',
          validateStatus: () => true,
        }),
      );

      // Reenviar headers binarios relevantes al cliente
      const binaryHeaders = [
        'content-type', 'content-disposition', 'cache-control',
        'accept-ranges', 'content-range', 'content-length',
      ];
      for (const h of binaryHeaders) {
        if (r.headers[h]) res.setHeader(h, r.headers[h]);
      }

      const setCookie = r.headers['set-cookie'];
      if (setCookie) res.setHeader('set-cookie', setCookie);

      res.status(r.status);
      (r.data as NodeJS.ReadableStream).pipe(res);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Bad Gateway', detail: err.message });
      }
    }
  }

  async healthCheck() {
    const results: Record<string, any> = {};
    for (const [route, url] of Object.entries(this.svcMap)) {
      try {
        await firstValueFrom(this.http.get(`${url}/health`, { timeout: 5000, validateStatus: () => true }));
        results[route] = { status: 'UP', url };
      } catch {
        results[route] = { status: 'DOWN', url };
      }
    }
    return { gateway: { status: 'UP', timestamp: new Date().toISOString() }, services: results };
  }
}
