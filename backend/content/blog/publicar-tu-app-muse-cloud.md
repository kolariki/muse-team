---
title: Publicar tu app con Muse Cloud: git propio, un clic para salir a internet, base de datos y autenticación
description: Cómo Muse Team publica lo que construye: repositorio git por proyecto, publicación con un clic (en Muse Team, Cloudflare o Fly), base de datos y autenticación con Neon o Supabase, migraciones y cómo llevarte todo a tu propia infraestructura.
category: Publicar y móvil
date: 2026-10-22
tags: [Muse Cloud, publicar, hosting, base de datos]
keywords: [publicar app hecha con IA, hosting para app generada, deploy con un clic, Supabase Neon con IA, alternativa a Vercel Railway para apps con IA]
---

Construir la app es la mitad del camino. La otra mitad es que alguien la use: una URL pública, una base de datos que persista, usuarios que puedan iniciar sesión. **Muse Cloud** cubre ese tramo sin que tengas que aprender a desplegar.

## Lo que cada proyecto tiene de entrada

### Un repositorio git propio

Cada construcción vive en su repositorio. Cada versión que aprueba el consejo es un commit; podés comparar versiones, volver a una anterior y ver qué cambió archivo por archivo. El repositorio se puede:

- **Descargar como zip** desde la card del proyecto.
- **Clonar** con git desde la URL privada de tu proyecto.
- **Subir a GitHub** con un clic, a un repositorio de tu cuenta.

Es tu código. No hay bloqueo.

### Correr la app sin publicar

Desde la card del proyecto, «Correr app» abre la aplicación en una pestaña de Muse Team, sobre el inicio, con su loader. Para apps móviles, abre el simulador de iOS o el emulador de Android con vista en vivo del dispositivo. Sirve para probar antes de publicar.

## Publicar con un clic

En el panel «Cloud» del constructor elegís el destino:

- **Muse Team (local)**: la app se sirve desde la misma instancia de Muse Team, en una URL del tipo `/apps/tu-app`. Es inmediato y sirve para demos, pruebas internas y apps de uso personal.
- **Cloudflare**: la app se despliega en la red de Cloudflare (Pages y Workers), con dominio propio si lo configurás. Ideal para apps web con tráfico público.
- **Fly**: para apps con backend que necesitan un proceso corriendo (APIs, colas, websockets).

El panel muestra el registro de publicación línea por línea, el estado y la URL final. Despublicar es otro clic.

## Base de datos y autenticación

Una app real necesita guardar datos y saber quién es cada usuario. Muse Cloud aprovisiona eso con los proveedores que ya usa la industria:

- **Neon**: Postgres serverless. Muse Team crea el proyecto, la base y la cadena de conexión, y la inyecta en tu app como variable de entorno.
- **Supabase**: Postgres más autenticación, almacenamiento y APIs automáticas. Muse Team crea el proyecto y configura las claves públicas y privadas.

Cargás las credenciales de tu cuenta de Neon o Supabase una vez, en la configuración de Muse Cloud, y desde ahí cada proyecto se aprovisiona solo.

### Migraciones

Cuando el constructor cambia el modelo de datos entre versiones, Muse Team genera un **kit de migración**: los scripts SQL, el orden de aplicación y las instrucciones. Lo revisás y lo aplicás desde el panel. No hay magia que toque tu base sin que lo veas.

## Llevarte todo

Muse Cloud está pensado para que puedas irte cuando quieras:

- El código está en tu git.
- La base está en tu cuenta de Neon o Supabase.
- Las variables de entorno están documentadas en el proyecto.
- El plan de despliegue (qué se construye, qué se sirve, qué puerto) está escrito en el repositorio.

Podés desplegar en Vercel, Railway, un servidor propio o donde prefieras siguiendo ese plan. Muse Team no retiene nada que te impida hacerlo.

## Qué cuesta

Muse Team no cobra por publicar en Muse Team (local). Cloudflare, Fly, Neon y Supabase tienen planes gratuitos generosos y cobran por uso cuando los superás, directamente a tu cuenta con ellos. Muse Team no intermedia esos cobros.

## Seguridad básica

- Las credenciales de los proveedores quedan cifradas en tu cuenta de Muse Team.
- Cada app publicada tiene sus propias variables de entorno; ninguna ve las de otra.
- Las claves de tu app (API de pagos, correo, etc.) se cargan como **secretos del proyecto**, nunca se escriben en el código.

## En resumen

Construís, probás, publicás, conectás base y usuarios, y todo queda en tu git y en tus cuentas. Muse Cloud elimina la parte aburrida sin encerrarte.
