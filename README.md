# GroupsApp - Sistema de Mensajeria Distribuida

Proyecto academico de mensajeria orientado a grupos y canales, con arquitectura de microservicios.

## Equipo

- Miguel Angel Arcila
- David Restrepo

## Descripcion General

GroupsApp implementa:

- Registro y autenticacion de usuarios.
- Grupos, membresias y canales (subgrupos).
- Mensajeria por canal y mensajeria directa (DM).
- Contactos y bloqueos entre usuarios.
- Estados de mensajes (`delivered` / `read`).
- Presencia (`online` / `offline`) con TTL en Redis.
- Adjuntos con S3 mediante URLs prefirmadas.
- Integracion asincrona con RabbitMQ para eventos.

## Arquitectura

Servicios principales:

- `api-gateway`: expone API REST publica (`/api/v1`) y orquesta gRPC.
- `auth-service`: registro, login y validacion de token.
- `group-service`: grupos, miembros, admins y canales.
- `user-service`: contactos, bloqueos y presencia.
- `message-service`: mensajes, receipts, adjuntos y outbox.
- `notification-service`: consumidor de eventos de mensajeria.

Infra de soporte:

- PostgreSQL (persistencia por servicio).
- Redis (presencia efimera).
- RabbitMQ (MOM para eventos y desacople).
- Nginx (frontend estatico + proxy al gateway).

## Estructura del Repositorio

```text
.
├── apps/
│   ├── api-gateway/
│   ├── auth-service/
│   ├── group-service/
│   ├── user-service/
│   ├── message-service/
│   └── notification-service/
├── packages/
│   └── contracts/
│       ├── proto/
│       └── postgres.js
├── infra/
│   ├── nginx/
│   ├── postgres/
│   └── k8s/
├── scripts/
│   ├── smoke-test.sh
│   ├── integration-test.sh
│   ├── file-attachment-test.sh
│   ├── dlq-demo.sh
│   └── metrics-snapshot.sh
├── docker-compose.yml
└── README.md
```

## Tecnologias

- Node.js 22+
- NestJS
- gRPC (`@grpc/grpc-js`)
- PostgreSQL
- Redis
- RabbitMQ
- Docker / Docker Compose
- Kubernetes (manifiestos en `infra/k8s`)
- AWS (EKS, RDS, S3, ALB)

## Requisitos

- Docker Desktop activo.
- Node.js 22+ y npm 11+ (si vas a correr fuera de Docker).
- Variables de entorno configuradas en `.env` (partiendo de `.env.example`).

## Variables de Entorno

1. Copia plantilla:

```bash
cp .env.example .env
```

2. Ajusta al menos:

- DB: `POSTGRES_*`
- Auth: `JWT_SECRET`
- Rabbit: `RABBITMQ_URL`
- S3: `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`

## Ejecucion Local (Docker)

Levantar todo el sistema:

```bash
docker compose up -d --build
```

Entradas locales:

- Frontend: `http://localhost:8080`
- API (via Nginx): `http://localhost:8080/api/v1`
- API directa gateway (debug): `http://localhost:3000/api/v1`
- RabbitMQ UI: `http://localhost:15672` (guest / guest)

Bajar y limpiar volumenes (si necesitas reset):

```bash
docker compose down -v
```

## Ejecucion Local (sin Docker)

```bash
npm install
npm run dev
```

## API REST Principal

Base URL:

- `http://localhost:8080/api/v1` (local)
- `<tu-alb>/api/v1` (despliegue)

Principales rutas:

- Auth:
  - `POST /auth/register`
  - `POST /auth/login`
- Grupos y canales:
  - `GET /groups`
  - `POST /groups`
  - `GET /groups/:groupId/members`
  - `POST /groups/:groupId/members`
  - `DELETE /groups/:groupId/members/:memberUserId`
  - `GET /groups/:groupId/channels`
  - `POST /groups/:groupId/channels`
- Usuarios:
  - `GET /users/contacts`
  - `POST /users/contacts`
  - `POST /users/blocks`
- Presencia:
  - `POST /presence/heartbeat`
  - `GET /presence/:userId`
  - `PUT /presence/me` (compatibilidad/manual)
- Mensajeria:
  - `POST /messages/channels/:channelId`
  - `GET /messages/channels/:channelId`
  - `POST /messages/direct/:userId`
  - `GET /messages/direct/:userId`
  - `POST /messages/:messageId/delivered`
  - `POST /messages/:messageId/read`
- Archivos:
  - `POST /files/upload-url`
  - `POST /files/:attachmentId/complete`
  - `GET /files/:attachmentId`

## Pruebas

Smoke test:

```bash
bash scripts/smoke-test.sh
```

Integracion:

```bash
npm run test:integration
# o
bash scripts/integration-test.sh
```

Adjuntos S3:

```bash
bash scripts/file-attachment-test.sh
```

DLQ / resiliencia RabbitMQ:

```bash
bash scripts/dlq-demo.sh
```

Snapshot operativo:

```bash
bash scripts/metrics-snapshot.sh
```

## Despliegue en Kubernetes (AWS)

Manifiestos:

- Base: `infra/k8s/base`
- Overlay AWS: `infra/k8s/overlays/aws`

Aplicar:

```bash
kubectl apply -k infra/k8s/overlays/aws
```

Verificar:

```bash
kubectl -n groupsapp get pods
kubectl -n groupsapp get svc
kubectl -n groupsapp get ingress
```

## Notas Tecnicas Relevantes

- Base de datos por servicio (aislamiento por contexto de negocio).
- `message-service` usa particionamiento HASH (via `shard_id` derivado de `channel_id`) para `msg.messages`.
- Outbox persistente para publicar eventos de forma confiable hacia RabbitMQ.
- Consumidor de notificaciones con idempotencia y soporte de retry + DLQ.
- Presencia en Redis con TTL y heartbeat automatico desde frontend.

## Estado del Proyecto

El repositorio se encuentra funcional con flujo E2E en local y con manifiestos listos para despliegue en AWS/EKS.

