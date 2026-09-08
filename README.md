# apigw-cnl-cross

> API Gateway generado por **Jarvis Platform** — 10/6/2026

Proxy inverso con rate limiting, CORS, SSL opcional y validación JWT local (sin llamada HTTP al Auth Service).

## Servicios proxiados

| Ruta | Variable env | Descripción |
|------|-------------|-------------|
| `/auth/*` | `AUTH_URL` | Redirige al Auth Service (`ms-cnl-cross-auth-profile`) |
| `/audit/*` | `CNL_AUDIT_URL` | Redirige al MS Canal cross-cutting de auditoría |
| `/catalogs/*` | `CNL_CATALOGS_URL` | Redirige al MS Canal cross-cutting de catálogos |
| `/organization/*` | `CNL_CATALOGS_URL` | Mismo downstream que `/catalogs` — comparte servicio |
| `/i18n/*` | `CNL_CATALOGS_URL` | Mismo downstream que `/catalogs` — comparte servicio |
| `/media/*` | `CNL_MEDIA_URL` | Redirige al MS Canal cross-cutting de media (proxy binario, streaming) |

## Endpoints propios

Todas las rutas proxiadas van con prefijo de versión `/api/v1/...` (`app.setGlobalPrefix('api')` +
`enableVersioning` en `main.ts`, `defaultVersion: '1'`); `health`, `health/deep` y `/` están excluidos
del prefijo `api` y no llevan versión.

| Método | Ruta | Protección | Descripción |
|--------|------|------------|-------------|
| ALL | `/api/v1/auth/*` | Público | Proxy hacia el Auth Service (`ms-cnl-cross-auth-profile`) |
| ALL | `/api/v1/i18n/locales` | Público | Proxy — manifest de idiomas y namespaces (necesario antes de que exista sesión, ej. boot de mf-shell / mf-auth) |
| ALL | `/api/v1/i18n/public/*` | Público | Proxy — namespaces públicos de i18n (allow-list validada del lado de `ms-cnl-cross-catalogs`) |
| ALL | `/api/v1/audit/*` | `JwtAuthGuard` | Proxy hacia el MS Canal de auditoría |
| ALL | `/api/v1/catalogs/*` | `JwtAuthGuard` | Proxy hacia el MS Canal de catálogos |
| ALL | `/api/v1/i18n/*` | `JwtAuthGuard` | Proxy — resto de rutas i18n (catch-all, va después de las rutas públicas de i18n) |
| ALL | `/api/v1/organization/*` | `JwtAuthGuard` | Proxy hacia el MS Canal de catálogos (organización) |
| ALL | `/api/v1/media/*` | `JwtAuthGuard` | Proxy binario (streaming) hacia el MS Canal de media |
| GET | `/health` | Público | Health check — verifica conectividad con todos los servicios proxiados |
| GET | `/health/deep` | Público | Health check profundo — mismo detalle que `/health` con estado por servicio |
| GET | `/` | Público | Info del gateway (respuesta reducida a `{status: OK}` en `NODE_ENV=production`) |

## Variables de entorno

| Variable | Requerida | Default | Descripción |
|----------|:---------:|---------|-------------|
| `PORT` | — | `10601` | Puerto HTTP |
| `NODE_ENV` | — | `development` | Entorno (`development` / `production`) |
| `ALLOWED_ORIGINS` | — | — | Orígenes CORS permitidos (coma-separados). En `development` se acepta cualquier origen |
| `RATE_LIMIT_TTL` | — | `60` | Ventana de rate limiting en segundos |
| `RATE_LIMIT_MAX` | — | `100` | Máximo de requests por ventana por IP |
| `REQUEST_TIMEOUT` | — | `120000` | Timeout de requests HTTP salientes en ms |
| `JWT_SECRET` | ✓ | — | Mismo valor que `JWT_SECRET` del Auth Service — el gateway valida el token **localmente** con `jsonwebtoken` sin llamar al Auth Service |
| `AUTH_URL` | ✓ | — | URL base del Auth Service — usada para **proxy** de rutas `/auth/*` |
| `USE_SSL` | — | `false` | `true` activa el servidor HTTPS adicional |
| `SSL_PORT` | — | `20601` | Puerto HTTPS (solo si `USE_SSL=true`) |
| `CERT_PATH` | — | `/app/certs` | Ruta a los certificados SSL (`server.crt` + `server.key` o `server.pfx`) |
| `SERVER_NAME` | — | — | Nombre del servidor para certificados PFX con múltiples entradas |
| `KAFKA_BROKER` | — | `localhost:9092` | Broker(s) Kafka (coma-separados) |
| `KAFKA_TOPIC` | — | `platform.logs` | Topic donde se publican eventos de gateway |

> **Nota sobre validación JWT (S6):** El guard usa `jsonwebtoken` directamente con `JWT_SECRET`.
> Si el usuario hace logout, la cookie se elimina en el cliente pero el token sigue siendo criptográficamente
> válido hasta que expire (`JWT_EXPIRES_IN`, default 4h). Esto es aceptable con TTL corto y
> cookie `httpOnly` eliminada al logout.

## Rate Limiting

- Ventana: `RATE_LIMIT_TTL` segundos (default 60s)
- Máximo: `RATE_LIMIT_MAX` requests por IP (default 100)
- Respuesta al exceder: `429 Too Many Requests`

## SSL

- `USE_SSL=true` levanta un servidor HTTPS adicional en `SSL_PORT` (el HTTP sigue activo)
- Formatos soportados: `server.crt` + `server.key`, o `server.pfx`
- Certificados en la ruta definida por `CERT_PATH`
- `SSL_VERIFY=false` en el Auth Service si usa certificado autofirmado internamente

## Path traversal

El gateway rechaza con `400` cualquier URL que contenga `..` o `%2e%2e`
antes de hacer el proxy al servicio upstream.

## Cómo ejecutar

### Local sin Docker

```bash
npm install
# Copiar .env.example a .env y completar los valores
npm run start:dev
```

El gateway queda disponible en `http://localhost:10601`.

### Local con Docker

Usa `docker-compose.dev.yml`, que lee el `.env` local:

```bash
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml up -d

# O build + up en un solo comando:
docker compose -f docker-compose.dev.yml up -d --build

# Para bajar:
docker compose -f docker-compose.dev.yml down
```

### Producción (con Vault)

El `docker-compose.yml` lee los secretos directamente de Vault al arrancar. **No se necesita `.env`.**

**Requisito:** Vault corriendo (ver [HCE-vault-config](../HCE-vault-config/README.md)).

#### Paso 1 — Obtener el token

El archivo `HCE-vault-config/.env` tiene la línea:
```
TOKEN_API_GATEWAY=hvs.CAESIDsn...
```
Copia ese valor.

#### Paso 2 — Crear `.env.docker` con el token

Este archivo tiene **una sola línea** con el token de bootstrap. No contiene secretos de la app — esos vienen del vault.

**PowerShell (Windows):**
```powershell
"VAULT_TOKEN=hvs.CAESIDsn..." | Out-File -Encoding utf8 .env.docker
```

**Bash / Linux / Mac:**
```bash
echo "VAULT_TOKEN=hvs.CAESIDsn..." > .env.docker
```

> `.env.docker` está en `.gitignore` — nunca se commitea.
> Si el init regenera los tokens, actualizar este archivo con el nuevo valor de `TOKEN_API_GATEWAY`.

#### Paso 3 — Levantar

```bash
docker compose down
docker compose build
docker compose up -d
```

Funciona igual en PowerShell, CMD y bash — sin exportar nada.

Al arrancar, `entrypoint.sh` se conecta al Vault (`hce/nestjs/apigw-cnl-cross`) con ese token, descarga
`JWT_SECRET`, `AUTH_URL`, `KAFKA_BROKER` y el resto de los secretos, y los inyecta como variables de
entorno en el contenedor. La aplicación no sabe que existe Vault.

Con GitHub Actions el token se pasa automáticamente desde GitHub Secrets (`VAULT_TOKEN`).

---

## Scripts disponibles

```bash
npm run start:dev   # desarrollo con hot-reload
npm run build       # compilar TypeScript
npm run start:prod  # ejecutar build
npm run test        # tests unitarios
npm run test:cov    # cobertura
```
