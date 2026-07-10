import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { buildOutboundHttpsAgent } from '../ssl/ssl-config.util';

@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (cfg: ConfigService) => ({
        timeout: Number(cfg.get('REQUEST_TIMEOUT', '120000')),
        httpsAgent: buildOutboundHttpsAgent(),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [GatewayController],
  providers: [GatewayService, JwtAuthGuard],
})
export class GatewayModule {}
