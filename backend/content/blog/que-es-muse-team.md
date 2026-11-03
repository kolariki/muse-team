---
title: Qué es Muse Team y cómo construye una app con un equipo de inteligencias artificiales
description: Muse Team arma un equipo de IA con roles reales (CEO, CTO, ingeniería, producto, diseño y QA), lo pone a debatir tu idea, a diseñarla y a construirla. Así funciona por dentro, paso a paso.
category: Cómo funciona Muse Team
date: 2026-10-22
tags: [Muse Team, cómo funciona, equipo de IA]
keywords: [construir app con IA, equipo de agentes de IA, generador de apps con inteligencia artificial, Muse Team]
---

La mayoría de las herramientas que «hacen apps con IA» funcionan igual: escribís un pedido, un único modelo lo interpreta y escupe código. Cuando el resultado no es lo que querías, volvés a escribir. Muse Team parte de otra idea: **una app buena no sale de un modelo que adivina, sale de un equipo que discute, decide y recién después construye**.

Esta guía explica qué es Muse Team, qué hace cada parte del sistema y qué podés esperar de cada etapa.

## La idea en una frase

Vos elegís quién ocupa cada silla, mirás el debate en vivo, aprobás el diseño y pedís cambios. El equipo itera.

## Las dos formas de entrar

Desde el inicio hay dos puertas, pensadas para dos momentos distintos.

### Constructor directo

Es la vía rápida. Escribís el pedido, el sistema lo pasa por **prompt engineering** (lo convierte en un brief completo: objetivo, usuarios, alcance, pantallas, datos, criterios de aceptación) y el constructor arranca de inmediato. No hay debate previo. Es lo más rápido y lo más barato, y el equipo queda a un clic para revisar el resultado después.

Sirve cuando sabés exactamente qué querés, cuando la app es chica o cuando estás probando una idea.

### Constructor con equipo de desarrollo

Es la vía completa. El pedido entra al **consejo**: CEO, CTO, Head of Engineering, Product, Diseño y QA lo debaten en turnos, se contradicen, acotan el alcance, eligen el stack y dejan por escrito decisiones justificadas. Del debate sale el brief, del brief el diseño, y del diseño aprobado el código.

Sirve cuando la decisión importa: un producto que va a crecer, un cliente que va a pedir explicaciones, una arquitectura que no querés rehacer en tres meses.

## Qué hace cada rol del equipo

Los roles no son decorativos. Cada uno tiene un prompt de sistema con responsabilidades concretas y un criterio distinto para juzgar la misma idea.

- **CEO**: fija el objetivo de negocio, decide qué entra y qué no entra en la primera versión, corta las discusiones que no llevan a ningún lado.
- **CTO**: elige el stack y la arquitectura, evalúa riesgos técnicos, costos de infraestructura y mantenimiento.
- **Head of Engineering**: baja la arquitectura a un plan de construcción por etapas, piensa en pruebas, despliegue e integración continua.
- **Product**: define usuarios, flujos y criterios de aceptación; es quien pregunta «¿y esto para qué sirve?».
- **Diseño**: entrega el sistema de diseño (paleta, tipografía, componentes), las pantallas y el mockup que vas a aprobar antes de que exista una línea de código.
- **QA**: busca lo que falta, los casos borde, los errores de consistencia; revisa cada versión antes de darla por lista.

Podés cambiar el modelo de cada rol, reescribir su prompt y sumarle **skills**: paquetes de conocimiento específico (pitch, alcance de MVP, revisión de stack, costos, arquitectura, CI/CD, etc.) que se inyectan en su contexto.

## El flujo completo, etapa por etapa

1. **Pedido y contexto**. Escribís qué querés construir. Podés adjuntar documentos, una carpeta o un proyecto local, y elegir la plataforma: web, móvil (iOS y Android con Expo) o ambas.
2. **Prompt engineering**. Un modelo convierte tu texto en un brief estructurado. Lo ves y lo editás.
3. **Apps de referencia**. Si pasás URLs de apps que te gustan, el equipo las visita con un navegador real, saca capturas y las describe con un modelo con visión. Con el análisis profundo activado, además hace ingeniería inversa de sus bundles, rutas y APIs para entender cómo están hechas.
4. **Debate del consejo** (en la vía con equipo). Turnos, desacuerdos, decisiones. Todo queda registrado y se puede exportar.
5. **Diseño**. El diseñador escribe el sistema de diseño y arma las pantallas. Vos aprobás o pedís cambios.

7. **Revisión**. El consejo audita cada versión. Pedís cambios en el diseño o en el código y el equipo vuelve a iterar.
8. **Correr, descargar o publicar**. La app se corre desde Muse Team (web en una pestaña, móvil en el simulador o el emulador), se descarga como zip con su repositorio git, o se publica en Muse Cloud con base de datos y autenticación.

## Quién construye el código

Acá está una de las decisiones más importantes, porque define costo y calidad.

- **Por API**: cualquier modelo configurado con tu clave. Se cobran los tokens al proveedor, no a Muse Team.

## Qué no es Muse Team

No es un chat con un modelo. No es un generador de plantillas. No es una caja negra: cada decisión del equipo queda escrita, cada archivo se ve, cada versión se puede comparar. Y no reemplaza tu criterio: el equipo propone, vos aprobás.

## Para quién es

- **Fundadores y equipos chicos** que necesitan un producto funcionando sin armar un equipo de seis personas.
- **Agencias y consultoras** que entregan prototipos y MVPs y quieren decisiones justificadas por escrito.
- **Desarrolladores** que prefieren revisar un diseño y un plan antes de leer 40 archivos generados.
- **Personas sin perfil técnico** que quieren una app propia y entender por qué se construyó así.

## Cómo empezar

Creá una cuenta, elegí «Constructor directo» para tu primera prueba, escribí tu idea en dos o tres líneas y mirá qué pasa. Cuando quieras ir en serio, pasate al constructor con equipo: ahí es donde Muse Team se diferencia de todo lo demás.
