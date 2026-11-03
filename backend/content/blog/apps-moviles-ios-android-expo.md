---
title: Apps móviles para iOS y Android con IA: cómo Muse Team construye con Expo y las corre en el simulador
description: Cómo Muse Team construye apps móviles con React Native y Expo, cómo elegir entre web, móvil o ambas con un solo código, qué necesitás instalado para correrlas en el simulador de iOS y el emulador de Android, y cómo se publican en las tiendas.
category: Publicar y móvil
date: 2026-10-22
tags: [apps móviles, iOS, Android, Expo, cómo funciona]
keywords: [crear app móvil con IA, app iOS Android con inteligencia artificial, Expo React Native con IA, generar app para celular, simulador iOS emulador Android]
---

Una app para el celular tiene reglas propias: navegación con gestos, pantallas chicas, tiendas con revisión, dos sistemas operativos. Muse Team construye apps móviles con un stack probado y las corre en un dispositivo virtual para que las veas antes de publicarlas.

## Elegir la plataforma

En el formulario del proyecto hay tres opciones:

- **Web app**: navegador, escritorio y móvil. Lo más simple y lo más rápido de publicar.
- **App móvil**: iOS y Android con **Expo** (React Native). Una sola base de código, dos tiendas.
- **Ambas**: un solo código que corre como web y como app nativa. Expo lo permite y Muse Team lo configura para que las pantallas compartan lógica y estilos.

La elección afecta a todo lo que sigue: el brief, el diseño (el diseñador trabaja con patrones móviles cuando corresponde), el constructor y la forma de correr la app.

## Por qué Expo

**Expo** es la forma más usada de construir apps con React Native. Resuelve lo que más duele en móvil: el entorno de compilación, los módulos nativos, las actualizaciones por aire y la publicación en las tiendas. Para un constructor de IA es ideal porque el proyecto tiene una estructura estándar, abundante documentación y pocas sorpresas.

El constructor recibe instrucciones específicas de plataforma: navegación nativa, áreas seguras, teclado, listas eficientes, permisos, y la diferencia entre lo que funciona en web y lo que no.

## Correr la app en un dispositivo virtual

Desde la card del proyecto, «Correr app» hace lo siguiente para una app móvil:

1. Levanta los servicios de Expo del proyecto.
2. Abre el **simulador de iOS** (en Mac con Xcode) o el **emulador de Android** (con Android Studio o el SDK), según lo que esté disponible.
3. Muestra la pantalla del dispositivo **en vivo dentro de Muse Team**, con la posibilidad de tocar y navegar desde ahí.

Si no hay ningún dispositivo virtual disponible, Muse Team lo dice en pantalla y te indica qué instalar.

### Requisitos

| Plataforma | Qué necesitás en la máquina donde corre Muse Team |
|---|---|
| iOS | Una Mac con Xcode y al menos un runtime de simulador instalado |
| Android | Android Studio o el SDK de Android con un dispositivo virtual creado |
| Ambas | Lo anterior; Muse Team elige el que esté listo |

Si usás Muse Team en la nube, los simuladores corren en el servidor y necesitan esas herramientas instaladas ahí. En un servidor Linux, el emulador de Android es viable; el simulador de iOS requiere macOS.

## Probar en tu propio teléfono

Como el proyecto es Expo, podés abrirlo en tu celular con la app Expo Go escaneando el código QR que muestra el servidor de desarrollo, o generar una compilación de desarrollo. Esto está fuera de Muse Team, pero el proyecto viene listo para hacerlo.

## Publicar en las tiendas

Publicar en App Store y Google Play tiene pasos que ninguna IA puede saltear: cuentas de desarrollador, certificados, revisión humana. Lo que Muse Team hace es dejarte el proyecto listo para **EAS Build**, el servicio de compilación de Expo, con la configuración de identificadores, íconos y pantallas de carga. Desde ahí, seguís la documentación de Expo para enviar a cada tienda.

## Qué construye bien y qué conviene evitar

Funciona muy bien para:

- Apps de gestión personal o de negocio (turnos, pedidos, inventario, agenda).
- Apps con listas, formularios, detalle, búsqueda y filtros.
- Apps que consumen una API (propia o de terceros).
- Apps con notificaciones, cámara, ubicación y los permisos habituales.

Conviene pensarlo dos veces para:

- Juegos con gráficos intensivos.
- Apps que dependen de módulos nativos muy específicos sin soporte en Expo.
- Apps con requisitos de rendimiento extremo (video en tiempo real, procesamiento pesado).

## Un consejo

Si no estás seguro de necesitar una app nativa, **empezá por web**. Una web app bien hecha se instala en el teléfono, funciona sin conexión en lo básico y no pasa por tiendas. Cuando necesites notificaciones push nativas, acceso profundo al dispositivo o presencia en las tiendas, pasá a «Ambas» y aprovechá el código que ya tenés.

## En resumen

Elegí móvil o ambas, dejá que el equipo diseñe con patrones móviles, corré la app en el simulador o el emulador desde Muse Team, y publicá con EAS cuando esté lista. Una base de código, dos tiendas, y la web de regalo.
