import { Controller, All, Get, Req, Res, UseGuards, Version, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { GatewayService } from './gateway.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller()
@UseGuards(ThrottlerGuard)
export class GatewayController {
  constructor(
    private readonly gatewayService: GatewayService,
    private readonly config: ConfigService,
  ) {}

  // Rutas públicas — sin JwtAuthGuard
  @All('auth{/*path}')
  async proxyAuth(@Req() req: Request, @Res() res: Response) {
    return this.gatewayService.proxyRequest(req, res, 'auth');
  }

  // Rutas protegidas — MS Canal cross-cutting (ms-cnl-cross-*)
  @All('audit{/*path}')
  @UseGuards(JwtAuthGuard)
  async proxyAudit(@Req() req: Request, @Res() res: Response) {
    return this.gatewayService.proxyRequest(req, res, 'audit');
  }

  @All('catalogs{/*path}')
  @UseGuards(JwtAuthGuard)
  async proxyCatalogs(@Req() req: Request, @Res() res: Response) {
    return this.gatewayService.proxyRequest(req, res, 'catalogs');
  }

  @All('organization{/*path}')
  @UseGuards(JwtAuthGuard)
  async proxyOrganization(@Req() req: Request, @Res() res: Response) {
    return this.gatewayService.proxyRequest(req, res, 'organization');
  }

  @All('media{/*path}')
  @UseGuards(JwtAuthGuard)
  async proxyMedia(@Req() req: Request, @Res() res: Response) {
    return this.gatewayService.proxyBinaryRequest(req, res, 'media');
  }

  @Version(VERSION_NEUTRAL)
  @Get('health')
  async health() {
    return this.gatewayService.healthCheck();
  }

  // S3: en producción no exponer la estructura interna del gateway
  @Version(VERSION_NEUTRAL)
  @Get()
  info() {
    if (this.config.get('NODE_ENV') === 'production') {
      return { status: 'OK' };
    }
    return {
      service:   'gw-pruebas-ag',
      type:      'API Gateway',
      timestamp: new Date().toISOString(),
      routes:    ['/api/v1/auth', '/api/v1/audit', '/api/v1/catalogs', '/api/v1/media'],
    };
  }
}
