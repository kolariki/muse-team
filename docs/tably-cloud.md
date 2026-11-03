# Muse Cloud · plan

Objetivo: que una app construida por el equipo salga **funcionando y publicada de inmediato**, sin que el usuario abra
cuentas en ningún lado, y que después pueda **llevársela** (código, base de datos y hosting) a donde quiera.

Principio: git propio sí; plataforma de deploy propia **como marca y experiencia**, no como infraestructura. Abajo va
infraestructura comoditizada (Cloudflare, Fly, Neon, Supabase) operada desde las cuentas de Muse Team y accedida por API.
Todo lo que se provisiona es estándar (git, Postgres, Dockerfile, build estático), así la migración es trivial.

## Fases

| # | Entregable | Estado |
|---|---|---|
| 1 | **Git propio.** Un repo bare por construcción en `data/git/<usuario>/<build>.git`. Commit por versión (ya existía en el workdir) y sincronización a pedido. Clone por HTTPS con el token de la cuenta (`/git/<usuario>/<build>.git`). «Mover a GitHub»: crea el repo con el token del usuario y hace push del historial completo. | hecho |
| 2 | **Publicar.** Panel «Publicar» en el constructor: build del proyecto, publicación con URL, logs, republicar, dar de baja. Proveedores: `local` (siempre disponible: el backend sirve el build estático en `/apps/<slug>/`), `cloudflare` (Pages, bajo tu dominio) para estáticos, `fly` (Fly Machines, Dockerfile generado) para apps con servidor. | hecho (cloudflare y fly sin verificar: faltan cuentas) |
| 3 | **Base de datos y auth.** Provisionar por API desde el panel: Postgres en Neon (una rama por proyecto) y proyecto Supabase (auth, storage). Las variables quedan en los secretos de la construcción y en el `.env`. | hecho (sin verificar: faltan cuentas) |
| 4 | **Stack por defecto publicable.** El brief y el constructor asumen, salvo pedido contrario: Vite + React + TypeScript con `npm run build` → `dist/`, backend solo si hace falta (FastAPI o Node con Dockerfile), Postgres por `DATABASE_URL`, auth y storage por Supabase, todo por variables de entorno. | hecho |
| 5 | **Migrar.** Desde el mismo panel: llevar el código a GitHub, el hosting a Vercel o Railway (deploy existente) y la base de datos con `pg_dump` (comando listo con la URL de conexión). | hecho |
| 6 | **Capa de cobro.** Apps publicadas por mes con el Stripe ya integrado. | pendiente (decisión de precio) |

## Variables de entorno del operador (`.env` del backend)

| Variable | Para qué |
|---|---|
| `TABLY_CLOUD_URL` | URL pública del backend, base de las apps publicadas en modo `local` (por defecto `http://localhost:8000`). |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | Cloudflare Pages (token con permiso *Pages: Edit*). Opcional: `CF_PAGES_DOMAIN` para mostrar la URL bajo tu dominio. |
| `FLY_API_TOKEN`, `FLY_ORG` | Fly Machines para apps con servidor. Requiere `flyctl` instalado. |
| `NEON_API_KEY` | Postgres por proyecto en Neon. |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_ORG_ID` | Proyectos Supabase (auth, storage, Postgres). Opcional: `SUPABASE_REGION`. |

Sin ninguna de estas variables, «Publicar» funciona en modo `local` (estáticos servidos por el backend) y el panel explica
qué falta para el resto.

## Riesgos y decisiones

- **Costo por app dormida ≈ 0**: Pages es gratis, Fly apaga máquinas sin tráfico, Neon duerme ramas.
- **Abuso**: solo cuentas verificadas publican; cada app tiene botón de baja; los slugs son únicos por cuenta.
- **Secretos**: las variables viven en `build_secrets`, cifradas con la clave del keystore; nunca vuelven al navegador.
- **No construir un Railway propio**: la experiencia es nuestra, la infraestructura no.
