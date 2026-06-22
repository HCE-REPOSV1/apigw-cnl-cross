import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer, logLevel } from 'kafkajs';

/** Tamaño máximo del buffer de logs pendientes cuando Kafka no está disponible en runtime. */
const BUFFER_MAX_SIZE = 500;

/** Pausa entre intentos de reconexión en runtime (ms). */
const RECONNECT_DELAY_MS = 5_000;

@Injectable()
export class KafkaLoggerService implements OnModuleInit, OnModuleDestroy {
  private readonly nestLogger = new Logger(KafkaLoggerService.name);
  private producer!: Producer;
  private topic!: string;

  /** true mientras el producer tiene una conexión activa con el broker. */
  private connected = false;

  /** true mientras hay un intento de reconexión en curso (evita concurrencia). */
  private reconnecting = false;

  /**
   * Buffer en memoria para logs que no pudieron enviarse durante una caída
   * de Kafka en runtime. Tiene un tamaño máximo para evitar fuga de memoria.
   */
  private readonly pendingBuffer: Array<Record<string, unknown>> = [];

  /** true si el audit logger está habilitado vía AUDIT_LOGGER_ENABLED. */
  private readonly enabled: boolean;

  constructor(private readonly cfg: ConfigService) {
    this.enabled = this.cfg.get<string>('AUDIT_LOGGER_ENABLED', 'true').trim().toLowerCase() !== 'false';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ARRANQUE — Fail-fast: si Kafka no está disponible el bootstrap falla.
  // Si AUDIT_LOGGER_ENABLED=false, el audit logger queda deshabilitado por
  // completo: no se construye el cliente Kafka ni se intenta conectar.
  // ─────────────────────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.nestLogger.log('Audit logger deshabilitado (AUDIT_LOGGER_ENABLED=false) — Kafka no será utilizado.');
      return;
    }

    const brokers = this.cfg.get<string>('KAFKA_BROKER', 'localhost:9092').split(',');
    this.topic    = this.cfg.get<string>('KAFKA_TOPIC',  'platform.logs');

    const kafka = new Kafka({
      clientId: 'gateway-logger',
      brokers,
      logLevel: logLevel.ERROR,
      // Límite de reintentos en el arranque para no bloquear demasiado en dev.
      // En producción Kafka debe estar arriba antes que el gateway.
      retry: {
        retries:        2,
        initialRetryTime: 300,
        factor:           1.5,
      },
    });

    this.producer = kafka.producer();

    // Sin try/catch intencionado: si connect() falla, la excepción se propaga
    // hasta NestJS bootstrap → process.exit(1) vía el catch en main.ts.
    await this.producer.connect();
    this.connected = true;
    this.nestLogger.log(`Kafka producer conectado a [${brokers.join(', ')}]`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled && this.connected) {
      await this.producer.disconnect();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RUNTIME — Fire-and-forget con buffer y reconexión en background.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Publica un log en Kafka de forma asíncrona sin bloquear el request.
   * El llamador NO debe usar `await` sobre este método; el interceptor
   * lo invoca sin await intencionalmente para mantener el fire-and-forget.
   */
  publishLog(entry: Record<string, unknown>): void {
    if (!this.enabled) return;

    // Encolar y despachar sin esperar — nunca lanzar hacia el caller.
    this.dispatchLog(entry).catch(() => {
      // dispatchLog ya maneja todos los errores internamente.
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────────

  private async dispatchLog(entry: Record<string, unknown>): Promise<void> {
    if (!this.connected) {
      this.bufferLog(entry);
      this.scheduleReconnect();
      return;
    }

    try {
      await this.producer.send({
        topic:    this.topic,
        messages: [{ value: JSON.stringify(entry) }],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.nestLogger.warn(`Kafka send fallido, encolando log. Causa: ${message}`);
      this.connected = false;
      this.bufferLog(entry);
      this.scheduleReconnect();
    }
  }

  private bufferLog(entry: Record<string, unknown>): void {
    if (this.pendingBuffer.length >= BUFFER_MAX_SIZE) {
      // Descartamos el más antiguo para no crecer indefinidamente.
      this.pendingBuffer.shift();
      this.nestLogger.warn(`Buffer Kafka lleno (${BUFFER_MAX_SIZE} items). Log más antiguo descartado.`);
    }
    this.pendingBuffer.push(entry);
  }

  /**
   * Intenta reconectar el producer en background.
   * Si ya hay una reconexión en curso, no inicia otra (idempotente).
   */
  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;

    setTimeout(() => this.attemptReconnect(), RECONNECT_DELAY_MS);
  }

  private async attemptReconnect(): Promise<void> {
    this.nestLogger.log('Intentando reconexión con Kafka...');
    try {
      await this.producer.disconnect().catch(() => {
        // Ignorar error del disconnect — el producer puede estar en mal estado.
      });
      await this.producer.connect();
      this.connected    = true;
      this.reconnecting = false;
      this.nestLogger.log('Reconexión con Kafka exitosa. Drenando buffer...');
      await this.drainBuffer();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.nestLogger.warn(`Reconexión fallida: ${message}. Reintentando en ${RECONNECT_DELAY_MS}ms.`);
      this.reconnecting = false;
      // Programa otro intento; scheduleReconnect es idempotente.
      this.scheduleReconnect();
    }
  }

  /**
   * Envía los logs acumulados en el buffer después de reconectar.
   * Si alguno falla, vuelven al buffer (a través de dispatchLog).
   */
  private async drainBuffer(): Promise<void> {
    const pending = this.pendingBuffer.splice(0);
    for (const entry of pending) {
      await this.dispatchLog(entry);
    }
  }
}
