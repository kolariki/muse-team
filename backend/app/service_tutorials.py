"""Hand-written, step-by-step tutorials for the services apps ask for most (Mercado Pago, Stripe, Resend…).

They come before the model-written guides (service_guide.py): written once, checked, with the exact menus, what each value
looks like and how to try it without risk. `{app_url}` and `{webhook_url}` are filled with the app's real addresses when
it has them, so the user copies the right thing.
"""
from __future__ import annotations

import re

# (pattern over the group's variables, tutorial). Each step: title, detail, url (optional). `looks`: var pattern → how its value looks.
TUTORIALS: list[tuple[str, dict]] = [
    (r"^(MP_|MERCADOPAGO)", {
        "intro": "Mercado Pago es con lo que tu app cobra (señas, reservas, suscripciones). La plata entra a tu cuenta de Mercado Pago.",
        "cost": "Sin costo fijo. Mercado Pago cobra una comisión por cada cobro, que depende de en cuántos días querés tener la plata.",
        "time": "15 minutos",
        "steps": [
            {"title": "Entrá con tu cuenta de Mercado Pago", "url": "https://www.mercadopago.com.ar/developers/panel/app",
             "detail": "Abrí el panel de desarrolladores e iniciá sesión con la cuenta de Mercado Pago donde querés recibir la plata. Si es la primera vez, Mercado Pago te pide aceptar los términos de desarrollador. Si todavía no tenés cuenta, creala con tu email y validá tu identidad: sin eso no te deja cobrar."},
            {"title": "Creá una aplicación",
             "detail": "Tocá «Crear aplicación». Ponele el nombre de tu negocio. Cuando te pregunte qué tipo de solución vas a integrar, elegí «Pagos online»; si te pregunta si usás una plataforma de e-commerce, respondé que no; y como producto elegí «Checkout Pro». Aceptá y tocá «Crear aplicación»."},
            {"title": "Activá las credenciales de producción",
             "detail": "Dentro de la aplicación, en el menú de la izquierda, entrá a «Credenciales de producción». Completá el rubro de tu negocio y, en sitio web, poné {app_url}. Tocá «Activar credenciales»."},
            {"title": "Copiá la Public Key y el Access Token",
             "detail": "En esa misma pantalla aparecen dos valores. La «Public Key» va en MP_PUBLIC_KEY: empieza con APP_USR- y tiene unos 45 caracteres. El «Access Token» va en MP_ACCESS_TOKEN: también empieza con APP_USR- pero es mucho más largo. El Access Token es secreto: no lo compartas con nadie."},
            {"title": "Activá los avisos de pago (webhook)",
             "detail": "En el menú de la aplicación entrá a «Webhooks» → «Configurar notificaciones». En «URL modo productivo» pegá {webhook_url}. En «Eventos» marcá «Pagos». Guardá. Ahí aparece una «Clave secreta»: tocá para mostrarla y copiala en MP_WEBHOOK_SECRET. Esto es lo que le avisa a la app que un pago se aprobó: sin esto la seña queda «pendiente» aunque el cliente haya pagado."},
            {"title": "Tu número de usuario (Collector ID)",
             "detail": "MP_COLLECTOR_ID es el número de tu cuenta. Lo ves en «Credenciales de producción» como «User ID» (solo números, por ejemplo 123456789). La app lo usa para confirmar que el pago llegó a tu cuenta y no a otra."},
        ],
        "test": "Para probar sin cobrar de verdad: en «Credenciales de prueba» de la misma aplicación hay otra Public Key y otro Access Token. Cargá esos primero y pagá con una tarjeta de prueba (en la documentación de Mercado Pago están las tarjetas de prueba). Cuando funcione, reemplazalos por los de producción.",
        "looks": {r"ACCESS_TOKEN": "APP_USR-1234…-…  (largo)", r"PUBLIC_KEY": "APP_USR-xxxxxxxx-xxxx-…", r"WEBHOOK_SECRET": "letras y números, unos 64", r"COLLECTOR|USER_ID": "solo números"},
    }),
    (r"^STRIPE_", {
        "intro": "Stripe es con lo que tu app cobra con tarjeta en todo el mundo. La plata se deposita en tu cuenta bancaria.",
        "cost": "Sin costo fijo. Stripe cobra una comisión por cada cobro (alrededor de 2,9 % + USD 0,30 con tarjeta).",
        "time": "15 minutos (más la verificación del negocio)",
        "steps": [
            {"title": "Creá tu cuenta de Stripe", "url": "https://dashboard.stripe.com/register",
             "detail": "Registrate con tu email. Para cobrar de verdad, Stripe te pide completar los datos de tu negocio y una cuenta bancaria (en «Activar pagos»). Mientras tanto podés probar en modo de prueba."},
            {"title": "Copiá las claves de la API", "url": "https://dashboard.stripe.com/apikeys",
             "detail": "Entrá a «Desarrolladores» → «Claves de API». La «Clave publicable» empieza con pk_live_ (o pk_test_ en modo prueba) y va en la variable que termina en PUBLISHABLE_KEY. La «Clave secreta» empieza con sk_live_ (o sk_test_): tocá «Revelar», copiala en STRIPE_SECRET_KEY y no la compartas."},
            {"title": "Activá los avisos de pago (webhook)", "url": "https://dashboard.stripe.com/webhooks",
             "detail": "En «Desarrolladores» → «Webhooks» tocá «Agregar destino» (o «Agregar endpoint»). En la URL pegá {webhook_url}. Elegí los eventos `checkout.session.completed` y `payment_intent.succeeded` (y los de suscripción si tu app cobra suscripciones). Guardá."},
            {"title": "Copiá el secreto del webhook",
             "detail": "Dentro del webhook que creaste, en «Secreto de firma», tocá «Revelar». Empieza con whsec_ y va en STRIPE_WEBHOOK_SECRET. Sin esto la app no se entera de que el pago se aprobó."},
        ],
        "test": "Con el interruptor «Modo de prueba» arriba a la derecha usás claves pk_test_ / sk_test_ y la tarjeta `4242 4242 4242 4242` (cualquier fecha futura y cualquier código). Cuando todo funcione, repetí los pasos con el modo de prueba apagado.",
        "looks": {r"SECRET_KEY": "sk_live_… o sk_test_…", r"PUBLISHABLE|PUBLIC": "pk_live_… o pk_test_…", r"WEBHOOK": "whsec_…"},
    }),
    (r"^RESEND_", {
        "intro": "Resend es lo que usa tu app para mandar emails: confirmaciones de turno, recordatorios, recuperar la contraseña.",
        "cost": "Gratis hasta 3.000 emails por mes (100 por día). Después, desde USD 20 por mes.",
        "time": "10 minutos, más lo que tarde en verificarse tu dominio",
        "steps": [
            {"title": "Creá tu cuenta en Resend", "url": "https://resend.com/signup",
             "detail": "Registrate con tu email o con tu cuenta de Google."},
            {"title": "Agregá tu dominio", "url": "https://resend.com/domains",
             "detail": "Entrá a «Domains» → «Add Domain» y escribí el dominio desde el que querés mandar (por ejemplo tunegocio.com). Te recomendamos un subdominio como mail.tunegocio.com. Si todavía no tenés dominio, salteá este paso: vas a poder probar, pero solo te llegan a vos."},
            {"title": "Cargá los registros DNS en tu proveedor de dominio",
             "detail": "Resend te muestra unos registros (MX y TXT). Entrá al panel donde compraste el dominio (Hostinger, GoDaddy, Nic.ar, Cloudflare…), buscá «DNS» o «Zona DNS» y agregá cada registro copiando tipo, nombre y valor tal como aparecen. Volvé a Resend y tocá «Verify DNS records». Puede tardar de unos minutos a unas horas."},
            {"title": "Creá la clave de la API", "url": "https://resend.com/api-keys",
             "detail": "En «API Keys» tocá «Create API Key», ponele un nombre (por ejemplo el de tu app) y permiso «Sending access». Copiá la clave apenas aparece, porque no se vuelve a mostrar. Empieza con re_ y va en RESEND_API_KEY."},
            {"title": "Elegí el remitente",
             "detail": "En EMAIL_FROM poné el nombre y la dirección desde la que salen los emails, con tu dominio verificado. Por ejemplo: `Turnos Luna <turnos@tunegocio.com>`. Tiene que ser del dominio que verificaste en el paso 3."},
        ],
        "test": "Sin dominio podés usar como remitente `onboarding@resend.dev`: funciona, pero los emails solo le llegan al email con el que creaste la cuenta de Resend.",
        "looks": {r"API_KEY": "re_…", r"FROM": "Nombre <turnos@tudominio.com>"},
    }),
    (r"^SENDGRID_", {
        "intro": "SendGrid es lo que usa tu app para mandar emails.",
        "cost": "Plan gratuito con un límite diario chico; los planes pagos empiezan en unos USD 20 por mes.",
        "time": "15 minutos",
        "steps": [
            {"title": "Creá tu cuenta", "url": "https://signup.sendgrid.com/", "detail": "Registrate y completá el formulario de alta que pide SendGrid."},
            {"title": "Verificá el remitente", "url": "https://app.sendgrid.com/settings/sender_auth",
             "detail": "En «Settings» → «Sender Authentication» verificá tu dominio («Authenticate Your Domain», cargando los registros DNS que te muestra en el panel de tu dominio) o, para empezar, un solo email («Verify a Single Sender»)."},
            {"title": "Creá la clave de la API", "url": "https://app.sendgrid.com/settings/api_keys",
             "detail": "En «Settings» → «API Keys» tocá «Create API Key», elegí «Restricted Access» con permiso de «Mail Send». Copiala apenas aparece: empieza con SG. y va en SENDGRID_API_KEY."},
        ],
        "looks": {r"API_KEY": "SG.xxxx.yyyy"},
    }),
    (r"^SMTP_", {
        "intro": "Un servidor SMTP es la forma más simple de mandar emails desde la app, por ejemplo con tu cuenta de Gmail.",
        "cost": "Con Gmail es gratis (hasta unos 500 emails por día).",
        "time": "5 minutos",
        "steps": [
            {"title": "Activá la verificación en dos pasos", "url": "https://myaccount.google.com/signinoptions/twosv",
             "detail": "Con Gmail, primero tenés que tener activada la verificación en dos pasos en tu cuenta de Google."},
            {"title": "Creá una contraseña de aplicación", "url": "https://myaccount.google.com/apppasswords",
             "detail": "Escribí un nombre (por ejemplo el de tu app) y tocá «Crear». Google te muestra una contraseña de 16 letras: esa va en SMTP_PASSWORD (o SMTP_PASS). No es tu contraseña de Gmail."},
            {"title": "Completá el resto",
             "detail": "SMTP_HOST: `smtp.gmail.com` · SMTP_PORT: `465` · SMTP_USER: tu dirección de Gmail completa. Si usás otro proveedor (Hostinger, Zoho, tu hosting), estos datos están en su panel, en la sección de correo."},
        ],
        "looks": {r"PASS": "16 letras, sin espacios", r"HOST": "smtp.gmail.com", r"PORT": "465 o 587"},
    }),
    (r"^TWILIO_", {
        "intro": "Twilio es lo que usa tu app para mandar SMS o mensajes de WhatsApp.",
        "cost": "Cuenta de prueba gratis con saldo de regalo; después pagás por mensaje y un número mensual (alrededor de USD 1 a 15 según el país).",
        "time": "15 minutos",
        "steps": [
            {"title": "Creá tu cuenta", "url": "https://www.twilio.com/try-twilio", "detail": "Registrate y verificá tu email y tu número de celular."},
            {"title": "Copiá el Account SID y el Auth Token", "url": "https://console.twilio.com/",
             "detail": "En la página principal de la consola, en «Account Info», están el «Account SID» (empieza con AC) → TWILIO_ACCOUNT_SID y el «Auth Token» (tocá «Show») → TWILIO_AUTH_TOKEN."},
            {"title": "Conseguí un número que mande los mensajes", "url": "https://console.twilio.com/us1/develop/phone-numbers/manage/search",
             "detail": "Para SMS: «Phone Numbers» → «Buy a number», elegí uno con SMS y copialo con el formato +5491112345678 en la variable del número (TWILIO_FROM o TWILIO_PHONE_NUMBER). Para WhatsApp, para probar usá el sandbox en «Messaging» → «Try it out» → «Send a WhatsApp message»; para producción hay que dar de alta tu número de WhatsApp Business."},
        ],
        "looks": {r"SID": "AC + 32 caracteres", r"TOKEN": "32 caracteres", r"FROM|PHONE|NUMBER": "+5491112345678"},
    }),
    (r"^OPENAI_", {
        "intro": "OpenAI es la inteligencia artificial que usa tu app (respuestas, resúmenes, sugerencias).",
        "cost": "Pagás por uso: cargás saldo desde USD 5.",
        "time": "5 minutos",
        "steps": [
            {"title": "Creá tu cuenta", "url": "https://platform.openai.com/signup", "detail": "Registrate en la plataforma para desarrolladores (es distinta de ChatGPT)."},
            {"title": "Cargá saldo", "url": "https://platform.openai.com/settings/organization/billing/overview",
             "detail": "En «Billing» agregá una tarjeta y cargá saldo. Sin saldo, la clave no funciona."},
            {"title": "Creá la clave", "url": "https://platform.openai.com/api-keys",
             "detail": "Tocá «Create new secret key», ponele el nombre de tu app y copiala apenas aparece (no se vuelve a mostrar). Empieza con sk- y va en OPENAI_API_KEY."},
        ],
        "looks": {r"KEY": "sk-…"},
    }),
    (r"^ANTHROPIC_", {
        "intro": "Anthropic (Claude) es la inteligencia artificial que usa tu app.",
        "cost": "Pagás por uso: cargás saldo desde USD 5.",
        "time": "5 minutos",
        "steps": [
            {"title": "Creá tu cuenta", "url": "https://console.anthropic.com/", "detail": "Registrate en la consola de Anthropic con tu email."},
            {"title": "Cargá saldo", "url": "https://console.anthropic.com/settings/billing", "detail": "En «Billing» agregá una tarjeta y comprá créditos."},
            {"title": "Creá la clave", "url": "https://console.anthropic.com/settings/keys",
             "detail": "En «API Keys» tocá «Create Key», ponele el nombre de tu app y copiala apenas aparece. Empieza con sk-ant- y va en ANTHROPIC_API_KEY."},
        ],
        "looks": {r"KEY": "sk-ant-…"},
    }),
    (r"^GEMINI_|^GOOGLE_(GENERATIVE|AI)", {
        "intro": "Gemini es la inteligencia artificial de Google que usa tu app.",
        "cost": "Tiene un nivel gratuito con límites; después pagás por uso.",
        "time": "3 minutos",
        "steps": [
            {"title": "Entrá a Google AI Studio", "url": "https://aistudio.google.com/apikey", "detail": "Iniciá sesión con tu cuenta de Google."},
            {"title": "Creá la clave", "detail": "Tocá «Create API key» (o «Crear clave de API»), elegí un proyecto de Google Cloud o dejá que cree uno. Copiá la clave: empieza con AIza y va en la variable de Gemini (GEMINI_API_KEY o GOOGLE_GENERATIVE_AI_API_KEY)."},
        ],
        "looks": {r"KEY": "AIza…"},
    }),
    (r"^GOOGLE_(CLIENT|OAUTH)", {
        "intro": "Esto permite que tus usuarios entren a la app con su cuenta de Google.",
        "cost": "Gratis.",
        "time": "15 minutos",
        "steps": [
            {"title": "Creá un proyecto en Google Cloud", "url": "https://console.cloud.google.com/projectcreate",
             "detail": "Iniciá sesión, ponele al proyecto el nombre de tu app y tocá «Crear»."},
            {"title": "Configurá la pantalla de consentimiento", "url": "https://console.cloud.google.com/auth/branding",
             "detail": "En «Google Auth Platform» (o «APIs y servicios» → «Pantalla de consentimiento de OAuth») completá el nombre de la app, el email de soporte, y elegí público «Externo». Guardá."},
            {"title": "Creá las credenciales", "url": "https://console.cloud.google.com/apis/credentials",
             "detail": "En «Credenciales» → «Crear credenciales» → «ID de cliente de OAuth», tipo «Aplicación web». En «Orígenes autorizados de JavaScript» poné {app_url}. En «URI de redireccionamiento autorizados» poné la dirección de vuelta de tu app (suele ser {app_url}/api/auth/callback/google ; si no estás seguro, pediselo al constructor)."},
            {"title": "Copiá los dos valores",
             "detail": "El «ID de cliente» termina en .apps.googleusercontent.com y va en GOOGLE_CLIENT_ID. El «Secreto del cliente» empieza con GOCSPX- y va en GOOGLE_CLIENT_SECRET."},
            {"title": "Publicá la pantalla de consentimiento",
             "detail": "Mientras esté «En prueba», solo pueden entrar los emails que agregues como usuarios de prueba. En «Público» tocá «Publicar app» para que pueda entrar cualquiera."},
        ],
        "looks": {r"CLIENT_ID": "…apps.googleusercontent.com", r"SECRET": "GOCSPX-…"},
    }),
    (r"^GOOGLE_MAPS|^MAPS_API", {
        "intro": "Google Maps muestra mapas y direcciones en tu app.",
        "cost": "Google da un crédito mensual gratis que alcanza para la mayoría de las apps chicas; pide una tarjeta igual.",
        "time": "10 minutos",
        "steps": [
            {"title": "Activá la facturación en Google Cloud", "url": "https://console.cloud.google.com/billing",
             "detail": "Creá un proyecto (o usá uno) y asociale una cuenta de facturación con tu tarjeta. Sin esto los mapas no cargan."},
            {"title": "Activá la API de mapas", "url": "https://console.cloud.google.com/google/maps-apis/api-list",
             "detail": "Activá «Maps JavaScript API» (y «Places API» o «Geocoding API» si tu app busca direcciones)."},
            {"title": "Creá la clave y limitala a tu app", "url": "https://console.cloud.google.com/google/maps-apis/credentials",
             "detail": "«Crear credenciales» → «Clave de API». Después, en la clave, en «Restricciones de aplicaciones» elegí «Sitios web» y agregá {app_url}/* . Copiala (empieza con AIza) en la variable de Maps."},
        ],
        "looks": {r"KEY": "AIza…"},
    }),
    (r"^CLOUDINARY_", {
        "intro": "Cloudinary guarda las imágenes que suben tus usuarios y las sirve optimizadas.",
        "cost": "Gratis hasta un uso generoso; después desde unos USD 90 por mes.",
        "time": "5 minutos",
        "steps": [
            {"title": "Creá tu cuenta", "url": "https://cloudinary.com/users/register_free", "detail": "Registrate con tu email o Google."},
            {"title": "Copiá las credenciales", "url": "https://console.cloudinary.com/settings/api-keys",
             "detail": "En «Settings» → «API Keys» están el «Cloud name» (CLOUDINARY_CLOUD_NAME), la «API Key» (solo números, CLOUDINARY_API_KEY) y el «API Secret» (tocá el ojo para verlo, CLOUDINARY_API_SECRET). Si tu app pide CLOUDINARY_URL, en el panel principal aparece completa, empezando con cloudinary://."},
        ],
        "looks": {r"URL": "cloudinary://key:secret@nombre", r"API_KEY": "solo números"},
    }),
    (r"^PAYPAL_", {
        "intro": "PayPal es con lo que tu app cobra a clientes de otros países.",
        "cost": "Sin costo fijo; comisión por cobro.",
        "time": "10 minutos",
        "steps": [
            {"title": "Entrá al panel de desarrolladores", "url": "https://developer.paypal.com/dashboard/applications/live",
             "detail": "Iniciá sesión con tu cuenta PayPal Business (si tenés una personal, PayPal te ofrece convertirla)."},
            {"title": "Creá la app", "detail": "En «Apps & Credentials», con el interruptor en «Live», tocá «Create App», ponele el nombre de tu negocio y creala."},
            {"title": "Copiá las credenciales", "detail": "El «Client ID» va en PAYPAL_CLIENT_ID y el «Secret» (tocá «Show») en PAYPAL_CLIENT_SECRET. Para probar, hacé lo mismo con el interruptor en «Sandbox»."},
        ],
    }),
    (r"SUPABASE_", {
        "intro": "Supabase da base de datos, cuentas de usuario y archivos a tu app.",
        "cost": "Gratis para empezar; el plan Pro cuesta USD 25 por mes.",
        "time": "5 minutos",
        "steps": [
            {"title": "Creá el proyecto", "url": "https://supabase.com/dashboard/new/_",
             "detail": "Registrate, tocá «New project», ponele nombre, generá una contraseña de base de datos (guardala) y elegí la región más cercana a tus usuarios (por ejemplo São Paulo)."},
            {"title": "Copiá la URL y las claves", "url": "https://supabase.com/dashboard/project/_/settings/api",
             "detail": "En «Project Settings» → «API»: la «Project URL» va en SUPABASE_URL; la clave «anon public» en SUPABASE_ANON_KEY (o la variable con ANON); la «service_role» es secreta y va solo en la variable con SERVICE_ROLE, nunca en el navegador."},
        ],
        "looks": {r"URL": "https://xxxx.supabase.co", r"KEY": "eyJ… (largo)"},
    }),
    (r"^(AWS_|S3_)", {
        "intro": "AWS S3 guarda los archivos que suben tus usuarios.",
        "cost": "Pagás por lo que guardás (centavos por GB); hay un nivel gratis el primer año.",
        "time": "15 minutos",
        "steps": [
            {"title": "Creá el bucket", "url": "https://s3.console.aws.amazon.com/s3/bucket/create",
             "detail": "Con tu cuenta de AWS, creá un bucket con un nombre único (por ejemplo tu-app-archivos) y anotá la región (por ejemplo us-east-1 o sa-east-1): van en S3_BUCKET y AWS_REGION."},
            {"title": "Creá un usuario solo para la app", "url": "https://console.aws.amazon.com/iam/home#/users/create",
             "detail": "En IAM → «Usuarios» → «Crear usuario», sin acceso a la consola. En permisos, «Adjuntar políticas directamente» → AmazonS3FullAccess (o una política solo para tu bucket si sabés hacerla)."},
            {"title": "Creá la clave de acceso",
             "detail": "Entrá al usuario → «Credenciales de seguridad» → «Crear clave de acceso» → «Aplicación que se ejecuta fuera de AWS». Copiá el «ID de clave de acceso» (empieza con AKIA) en AWS_ACCESS_KEY_ID y la «Clave de acceso secreta» en AWS_SECRET_ACCESS_KEY: se muestra una sola vez."},
        ],
        "looks": {r"ACCESS_KEY_ID": "AKIA…", r"REGION": "us-east-1"},
    }),
    (r"TURNSTILE_", {
        "intro": "Turnstile es un captcha invisible de Cloudflare: frena a los bots en los formularios (crear cuenta, reservar) sin molestar a las personas. La app funciona sin esto, pero con menos protección.",
        "cost": "Gratis.",
        "time": "5 minutos",
        "steps": [
            {"title": "Entrá a Cloudflare", "url": "https://dash.cloudflare.com/?to=/:account/turnstile", "detail": "Creá una cuenta gratis o iniciá sesión. En el menú buscá «Turnstile»."},
            {"title": "Agregá un widget", "detail": "Tocá «Add widget», ponele el nombre de tu app y en «Hostname» agregá el dominio de tu app sin https:// (el de {app_url}). Modo «Managed». Tocá «Create»."},
            {"title": "Copiá las dos claves", "detail": "La «Site Key» empieza con 0x4 y va en TURNSTILE_SITE_KEY (es pública). La «Secret Key» va en TURNSTILE_SECRET_KEY (es secreta)."},
        ],
        "looks": {r"SITE": "0x4AAAA…", r"SECRET": "0x4AAAA…"},
    }),
    (r"UPSTASH_|^REDIS_|^KV_", {
        "intro": "Upstash Redis es una memoria compartida rápida: la app la usa para limitar intentos (por ejemplo de login) aunque tenga varias copias corriendo. Funciona sin esto, con un límite más simple.",
        "cost": "Gratis hasta 10.000 pedidos por día.",
        "time": "3 minutos",
        "steps": [
            {"title": "Creá la base", "url": "https://console.upstash.com/redis",
             "detail": "Registrate, tocá «Create Database», ponele nombre, elegí la región más cercana a tu app y el plan gratis."},
            {"title": "Copiá la URL y el token", "detail": "En la página de la base, en la sección «REST API», copiá UPSTASH_REDIS_REST_URL (empieza con https:// y termina en upstash.io) y UPSTASH_REDIS_REST_TOKEN."},
        ],
        "looks": {r"URL": "https://xxx.upstash.io", r"TOKEN": "letras y números, largo"},
    }),
    (r"^SENTRY_", {
        "intro": "Sentry te avisa de los errores que les aparecen a tus usuarios. Muse Team ya vigila los errores de tu app y los arregla; esto es un extra.",
        "cost": "Gratis hasta 5.000 errores por mes.",
        "time": "5 minutos",
        "steps": [
            {"title": "Creá tu cuenta y un proyecto", "url": "https://sentry.io/signup/", "detail": "Registrate y creá un proyecto eligiendo la plataforma de tu app (Node.js o React)."},
            {"title": "Copiá el DSN", "detail": "Sentry te lo muestra al crear el proyecto; después está en «Settings» → «Projects» → tu proyecto → «Client Keys (DSN)». Empieza con https:// y termina en ingest.sentry.io/…; va en SENTRY_DSN."},
        ],
        "looks": {r"DSN": "https://…@o….ingest.sentry.io/…"},
    }),
    (r"^SLACK_", {
        "intro": "Un canal de Slack donde la app avisa cosas (errores, nuevas reservas). Es opcional.",
        "cost": "Gratis.",
        "time": "5 minutos",
        "steps": [
            {"title": "Creá una app de Slack", "url": "https://api.slack.com/apps?new_app=1", "detail": "Elegí «From scratch», ponele un nombre y elegí tu espacio de trabajo."},
            {"title": "Activá los webhooks", "detail": "En «Incoming Webhooks» activá el interruptor, tocá «Add New Webhook to Workspace» y elegí el canal. Copiá la URL (empieza con https://hooks.slack.com/services/) en la variable de Slack."},
        ],
    }),
    (r"^TRIGGER_", {
        "intro": "Trigger.dev corre tareas programadas fuera de la app. Es opcional: Muse Team ya corre las tareas de tu app con su propio reloj.",
        "cost": "Gratis para empezar.",
        "time": "5 minutos",
        "steps": [
            {"title": "Creá el proyecto", "url": "https://cloud.trigger.dev/", "detail": "Registrate y creá una organización y un proyecto."},
            {"title": "Copiá la clave secreta", "detail": "En «API keys», elegí el entorno «Prod» y copiá la «Secret key» (empieza con tr_prod_) en TRIGGER_SECRET_KEY."},
        ],
    }),
]


def find(group: dict) -> dict | None:
    """The hand-written tutorial for this group of variables, if there is one."""
    names = [v["var"] for v in group.get("vars", [])]
    for rx, t in TUTORIALS:
        if any(re.search(rx, n, re.I) for n in names):
            return t
    return None


def render(t: dict, group: dict, app_url: str | None, webhook_url: str | None) -> dict:
    """The tutorial with the app's real addresses, and what each of this app's variables looks like."""
    app = app_url or "la dirección de tu app (la ves en «Publicar» cuando está en línea)"
    hook = webhook_url or (f"{app_url}/… (la ruta de avisos de pago de tu app: pedile al constructor que te la diga)" if app_url else
                           "la dirección de avisos de pago de tu app (aparece acá cuando la publiques)")

    def fill(text: str) -> str:
        return text.replace("{app_url}", app).replace("{webhook_url}", hook)

    looks = {}
    for v in group.get("vars", []):
        hit = next((how for rx, how in (t.get("looks") or {}).items() if re.search(rx, v["var"], re.I)), None)
        if hit:
            looks[v["var"]] = hit
    return {"intro": t["intro"], "cost": t.get("cost"), "time": t.get("time"), "test": fill(t["test"]) if t.get("test") else None,
            "steps": [{"title": s["title"], "detail": fill(s["detail"]), "url": s.get("url")} for s in t["steps"]],
            "looks": looks, "generated": True, "curated": True, "model": "Guía de Muse Team"}


def webhook_path(files: dict[str, str], group: dict) -> str | None:
    """Where the app receives payment notices (for Mercado Pago / Stripe), read from its code."""
    names = " ".join(v["var"] for v in group.get("vars", []))
    hint = r"mercado|mp\b|mp[-_/]|mercadopago" if re.search(r"MP_|MERCADO", names) else r"stripe" if "STRIPE" in names else None
    if not hint:
        return None
    rx = re.compile(r"""["'`](/(?:api/)?[\w/{}:.-]*(?:webhook|webhooks|notifications?|ipn)[\w/{}:.-]*)["'`]""", re.I)
    best = None
    for rel, text in files.items():
        if not isinstance(text, str) or not rel.endswith((".ts", ".js", ".mjs", ".py", ".tsx")) or "node_modules" in rel or "test" in rel.lower():
            continue
        for m in rx.finditer(text):
            path = m.group(1)
            if ":" in path or "{" in path:
                continue
            score = 2 if re.search(hint, path, re.I) else 1 if re.search(hint, rel + text[max(0, m.start() - 300):m.start()], re.I) else 0
            if score and (not best or score > best[0]):
                best = (score, path)
    return best[1] if best else None
