---
title: Cómo escribir el pedido de una app para que la IA la construya bien (prompt engineering aplicado)
description: Qué poner y qué no poner en el pedido de tu app, cómo funciona el prompt engineering automático de Muse Team, ejemplos de pedidos buenos y malos, y una plantilla que podés copiar.
category: Prompt engineering y referencias
date: 2026-10-22
tags: [prompt engineering, cómo funciona, guía práctica]
keywords: [prompt engineering, cómo pedirle una app a la IA, escribir prompt para generar app, brief para desarrollar app, plantilla de prompt]
---

Todo empieza con el pedido. Un pedido vago produce una app genérica; un pedido claro produce una app que se parece a lo que tenías en la cabeza. Esta guía explica qué hace Muse Team con tu texto y cómo escribirlo para sacarle el máximo.

## Qué hace Muse Team con lo que escribís

Cuando tocás «Generar prompt engineering a mi texto», un modelo transforma tu pedido en un **brief estructurado** con estas secciones:

- **Objetivo**: qué problema resuelve la app y para quién.
- **Usuarios y roles**: quién la usa y qué puede hacer cada uno.
- **Alcance de la primera versión**: qué entra y, tan importante como eso, qué no entra.
- **Pantallas y flujos**: la lista de pantallas y cómo se navega entre ellas.
- **Datos**: las entidades principales y sus relaciones.
- **Reglas de negocio**: lo que la app tiene que hacer cumplir.
- **Integraciones**: pagos, correo, WhatsApp, mapas, lo que haga falta.
- **Criterios de aceptación**: cómo sabemos que está lista.
- **Restricciones**: stack, idioma, plataforma, accesibilidad.

Ese brief es lo que lee el equipo (en la vía con consejo) o directamente el constructor (en la vía directa). Lo ves y lo editás antes de que arranque nada.

## Lo que un buen pedido tiene

### El problema, no la solución

«Mis clientes me escriben por WhatsApp para pedir turno y se me pisan» es mejor que «una app de turnos». Lo primero le da al equipo el contexto para decidir; lo segundo lo obliga a adivinar.

### Quién la usa

«Yo (la dueña), dos empleadas y los clientes» define tres roles con permisos distintos. Sin eso, la IA asume un solo tipo de usuario.

### Los tres o cuatro flujos principales

«Reservar un turno, cancelarlo, recibir un recordatorio el día anterior, ver la agenda del día». Si los nombrás, aparecen en la primera versión; si no, pueden quedar afuera.

### Lo que NO querés

«Sin pagos online por ahora», «sin registro con contraseña, con un link mágico». Decir qué no entra evita que la app se llene de funciones que no pediste.

### Referencias

«Que se vea como Calendly pero en español y más simple». Con apps de referencia, Muse Team las visita, las analiza y las usa de vara (o de plano, si activás la ingeniería inversa).

### Plataforma e idioma

Web, móvil o ambas; español rioplatense, neutro o inglés. Son dos clics en el formulario, pero conviene tenerlos claros.

## Lo que un buen pedido no necesita

- **Stack técnico**, salvo que tengas una restricción real. El CTO lo elige mejor que vos si no sos técnico, y si sos técnico, podés fijarlo en una línea («Next.js y Postgres»).
- **Detalles de diseño** al nivel de colores y tipografías. Para eso está el diseñador, y las referencias dicen más que las palabras.
- **Texto de marketing**. El brief es un documento de trabajo, no una landing.

## Ejemplos

### Pedido flojo

> Una app para mi negocio de comida.

Resultado probable: un catálogo genérico con carrito, sin saber si vendés por delivery, si cobrás online, si tenés mesas.

### Pedido bueno

> Tengo una rotisería. Quiero que mis clientes vean el menú del día, armen un pedido y elijan retiro o envío. Cobro en efectivo o transferencia al recibir, sin pagos online por ahora. Yo necesito ver los pedidos del día en una pantalla simple desde el celular y marcarlos como listos. Que se vea como Rappi pero sin tanta cosa. Español rioplatense, web.

Resultado probable: exactamente eso, con un brief que además te pregunta por horarios de entrega y zonas de envío.

## Plantilla para copiar

```
Qué problema resuelve:
Quién la usa (roles):
Los 3 o 4 flujos principales:
Qué NO entra en la primera versión:
Integraciones necesarias:
Apps de referencia:
Plataforma (web / móvil / ambas) e idioma:
Restricciones (stack, hosting, accesibilidad), si las hay:
```

Cinco minutos llenando esto valen más que una hora de cambios después.

## Qué modelo hace el prompt engineering

## Después del brief

- En el **constructor directo**, el brief va derecho al constructor.
- En el **constructor con equipo**, el brief es el punto de partida del debate: el consejo lo discute, lo acota y lo mejora antes de diseñar.

## En resumen

Describí el problema, los usuarios, los flujos y lo que no entra. Dejá el stack y el diseño al equipo salvo que tengas una restricción real. Y leé el brief antes de arrancar: es el momento más barato para corregir.
