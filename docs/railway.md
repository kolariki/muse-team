# Desplegar Tably Team en Railway

Un solo servicio: la API de FastAPI sirve el frontend compilado, corre Claude Code / Codex para cada usuario y guarda todo
en un volumen montado en `/data`.

## Pasos

1. **Nuevo proyecto en Railway → Deploy from GitHub repo** (`kolarikivan/tablyteam`). Railway detecta `railway.toml` y usa el `Dockerfile` de la raíz.
2. **Volumen**: en el servicio, *Settings → Volumes → Add volume*, mount path `/data`. Sin esto, cada deploy borra cuentas, sesiones y construcciones.
3. **Variables** (*Settings → Variables*):

| Variable | Para qué |
|---|---|
| `ARENA_SECRET_KEY` | Clave Fernet para cifrar las API keys y tokens de los usuarios. Generala con `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Si falta, se crea una en `/data` (sirve mientras el volumen exista). |
| `CORS_ORIGINS` | El dominio público de la app, p. ej. `https://app.tably.team`. |
| `TABLY_CLOUD_URL` | El mismo dominio público: base de las apps publicadas en modo local (`/apps/<slug>/`) y de los repos git (`/git/...`). |
| `RESEND_API_KEY` / SMTP | Para los mails de verificación de cuenta (sin esto los códigos salen como `dev_code`, solo para pruebas). Salen de `Tably Team <hola@tablyteam.com>`; `MAIL_FROM` lo cambia y el dominio tiene que estar verificado en Resend. |
| `SIGNUP_NOTIFY_EMAIL` | A quién le llega el aviso de cada cuenta nueva. Sin esto va a `TABLY_ADMIN_EMAILS` o a la primera cuenta creada. |
| `STRIPE_*` | Cobros (developer a pedido, REA). Opcional. |
| `LANGFUSE_*` | Trazas. Opcional. |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `FLY_API_TOKEN`, `NEON_API_KEY`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_ORG_ID` | Tably Cloud (hosting, base de datos, auth). Opcionales; ver `docs/tably-cloud.md`. |

4. **Dominio**: *Settings → Networking → Generate domain* o un dominio propio. Ponelo en `CORS_ORIGINS` y `TABLY_CLOUD_URL`.
5. Deploy. El healthcheck es `/api/health`.

## Cómo usa cada persona su suscripción de Claude, con la PC apagada

Claude Code genera un token de larga duración con `claude setup-token` (en la computadora donde está logueado). El usuario
lo pega en *Configuración → Tu suscripción → Conectar*. Tably lo guarda cifrado y, cuando esa persona construye o chatea
con sus sesiones, corre `claude` en el servidor con `CLAUDE_CODE_OAUTH_TOKEN` y un `CLAUDE_CONFIG_DIR` propio en
`/data/claude-home/<usuario>`. Así cada cuenta tiene sus propias sesiones en el servidor y nadie comparte credenciales.

Las conversaciones que ya existían en la computadora del usuario no viajan solas: en el servidor empiezan con las que se
crean ahí (construcciones, chats desde «Mis sesiones»).

## Tamaños y costos

- La imagen pesa unos 1,5 GB (Node, Chromium y los CLIs). El plan Hobby de Railway alcanza para empezar; las construcciones
  largas con Claude Code consumen CPU y RAM del servicio, así que conviene 2 vCPU / 4 GB.
- `/data` crece con cada construcción (node_modules incluidos). Un volumen de 10 GB es un buen inicio.
