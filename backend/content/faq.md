---
title: Preguntas frecuentes
---

## ¿Qué es Muse Team?

Muse Team es una plataforma para construir aplicaciones con un **equipo de inteligencias artificiales con roles**: CEO, CTO, Head of Engineering, Product, Diseño y QA. Describís tu idea, el equipo la debate, estudia apps de referencia, diseña las pantallas, escribe el código y lo revisa. Vos aprobás cada paso y la app queda lista para correr, descargar o publicar.

## ¿Qué IA usa?

Muse, de Meta. Todo el equipo razona con Muse Spark y Muse Wonder por la Meta Model API, y Muse Code escribe el código. Cargás tu key de Meta en «Modelos y API keys» y listo.

## ¿Qué es el constructor directo?

La vía rápida: tu pedido pasa por prompt engineering, se convierte en un brief completo y el constructor arranca de inmediato, sin debate del equipo. Es lo más rápido y lo más barato. El equipo queda a un clic para auditar el resultado después.

## ¿Qué es el constructor con equipo de desarrollo?

La vía completa: el equipo investiga las referencias, debate tu idea en turnos, deja decisiones justificadas, produce el brief, diseña las pantallas que aprobás y recién entonces construye. Cada versión se revisa y podés pedir cambios.

## ¿Puedo construir apps móviles?

Sí. Elegís web, móvil (iOS y Android con Expo) o ambas con un solo código. Las apps móviles se corren desde Muse Team en el simulador de iOS o el emulador de Android, con la pantalla del dispositivo en vivo, si esas herramientas están instaladas donde corre Muse Team.

## ¿Qué son las apps de referencia?

URLs de apps que te gustan. Muse Team las visita con un navegador real, saca capturas, las describe con un modelo con visión y arma un documento de investigación que leen el diseñador y el constructor. Con «análisis profundo e ingeniería inversa», además analiza sus bundles, rutas y APIs para replicarlas con fidelidad (requiere REA instalado y un constructor de escritorio). No tiene costo adicional: corre con tu suscripción o tu API key.

## ¿Dónde queda mi código?

En tu cuenta, en un repositorio git propio por proyecto. Lo podés descargar como zip, clonar, subir a tu GitHub con un clic y comparar versiones. Es tuyo y es portable.

## ¿Cómo publico la app?

Desde el panel Cloud del constructor: en la propia instancia de Muse Team con un clic, o en Cloudflare o Fly con tus cuentas. Muse Cloud también aprovisiona base de datos y autenticación con Neon o Supabase y genera kits de migración cuando cambia el modelo de datos.

## ¿Qué pasa con mis API keys?

Quedan cifradas en tu cuenta, se usan solo para tus pedidos y las podés ver (últimos caracteres), reemplazar y borrar cuando quieras. Nunca se escriben en el código de tus proyectos. Recomendamos crear claves específicas para Muse Team con límite de gasto.

## ¿Puedo correr Muse Team en mi propia máquina o servidor?

Sí. Hay una imagen Docker y una guía para desplegarlo en Railway o en cualquier servidor. Cada usuario conecta sus propias claves y suscripciones.

## ¿Qué pasa si una construcción falla o se corta?

El estado queda guardado. Podés reanudarla desde donde quedó, cambiar el constructor o el modelo y volver a intentar. Los agentes de escritorio corrigen por sí mismos los errores de compilación durante la construcción.

## ¿Puedo pedir cambios después?

Sí. Pedís cambios en el diseño o en el código, el constructor los aplica y el consejo revisa la nueva versión. También podés convocar al equipo para auditar una construcción directa.

## ¿Puedo guardar mi configuración de equipo?

Sí. Un experimento guarda tema, modo, equipo (proveedor, modelo, prompt y skills de cada rol) y ajustes del debate, para reutilizarlo con otras ideas y comparar resultados.

## ¿Qué son las skills?

Paquetes de conocimiento específico (pitch, alcance de MVP, revisión de stack, costos, arquitectura, CI/CD, entre otros) que se agregan al contexto de un rol para que trabaje con un criterio más preciso. Se eligen por rol desde el editor del equipo.

## ¿En qué idiomas funciona?

La interfaz está en español e inglés. El equipo puede trabajar en español rioplatense, español neutro, inglés u otros idiomas que elijas para el proyecto; los modelos lo manejan sin problema.

## ¿Muse Team es para personas sin perfil técnico?

Sí. Describís el problema en tus palabras, el equipo decide la parte técnica y te la explica, y aprobás el diseño antes de que exista código. Si sos técnico, podés fijar el stack, editar el brief y revisar cada archivo.
