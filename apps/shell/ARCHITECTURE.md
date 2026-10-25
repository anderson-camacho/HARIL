# ADR-0001: HARIL de tres paneles con un único dueño de la terminal

**Estado:** propuesta técnica y prueba de viabilidad. No habilitar como consola predeterminada hasta completar las comprobaciones de Pi.

**Actualización 0.22.3:** se incorpora una **ruta experimental distinta del host RPC/SDK**: un adaptador de extensión sobre el `layoutRoot` privado de `@earendil-works/pi-tui`, inspirado en el patrón usado por dc-pi. La TUI sigue siendo propiedad de Pi; el adaptador compone un `hstack` a toda altura que incorpora el layout original del chat como nodo central y lo restaura al cerrar. Se activa únicamente cuando se detecta el contrato de layout conocido y no hay ya una barra Gentle Shell; falla hacia la cabecera antigua y evita un fork de Pi. Esta ruta requiere validación manual en Windows y no elimina el estudio de RPC/SDK si Pi cambia su internals o las extensiones interactúan mal. El estado descrito más abajo corresponde al estudio original de 0.22.1.

**Actualización 0.22.4:** el dock activa fichas read-only para Explorador, Git y Memoria, y diagnósticos honestos de YouTube y Temas; el selector `Alt+Z` + número es una superposición de Pi que captura la segunda tecla sin escribirla en el editor. En WSL se conserva el `Alt+Z` asignado por Pi a deshacer: el comando `/haril-plugin` es la alternativa segura. Los plugins son ranuras de HARIL, no una API de carga arbitraria de extensiones Pi.

## Objetivo

Una columna izquierda de plugins/explorador, la conversación de Pi en el centro y una columna derecha con Agents, Orchestration, Automation, Tools, Everywhere, avisos y logs. Las zonas deben ocupar toda la altura del área de trabajo, con foco y scroll independientes. Las pestañas, visibilidad, ancho y orden serán configurables. `Alt+Z`, luego `1`–`9`, es la combinación acordada para seleccionar pestañas; se validarán posibles conflictos antes de habilitarla.

## Estado real de HARIL 0.22.0

| Pieza | Qué hace hoy | Limitación |
| --- | --- | --- |
| `apps/haril/src/commands/console.ts` | Arranca Pi con `--tui-mode fullscreen` y la extensión `-e` | Pi controla la terminal y su historial. |
| `integrations/pi-console/src/console.ts` | Personaliza encabezado, pie, widgets y vistas `ctx.ui.custom()` | La API de extensiones no ofrece paneles permanentes a ambos lados del chat. |
| `integrations/pi-console/src/dashboard.ts` | Dibuja un lateral derecho dentro del **encabezado** | Es limitado en altura, recorta información y no tiene scroll lateral real. |
| `apps/shell/src/app.ts` | Ya controla un TUI propio basado en `@earendil-works/pi-tui` | Es una consola de gestión, todavía no muestra la conversación de Pi. |
| `apps/shell/src/frame-layout.ts` | Compone líneas y dos columnas con estilos independientes | Falta componer tres paneles y conectar el chat. |

Ya existen los temas `haril-dark`, `haril-light`, `haril-blossom` y `haril-crimson` en `apps/shell/themes`. Hay que reutilizarlos.

## Decisión propuesta

**Evolucionar `apps/shell` como único dueño de la terminal.** El host compone tres columnas de altura completa. Pi conserva el motor de conversación y sus sesiones, pero las interacciones visuales y el foco los administra HARIL. No dibujaremos otra TUI dentro de la extensión ni mantendremos un fork de la interfaz interna de Pi.

Un subprocess Pi en [modo RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) es el primer candidato a evaluar. Si su protocolo no permite los requisitos de paridad, evaluar el SDK embebido. **No se cambia el comando `haril` ni `haril console` hasta comprobarlo; la interfaz Pi actual permanece como alternativa.**

### Riesgo de compatibilidad crítico

En [RPC Extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md) se documenta que `ctx.ui.custom()` retorna `undefined`; `setHeader()`, `setFooter()`, el editor personalizado y el cambio de temas no operan como en el TUI nativo. Por tanto, **la extensión HARIL existente no puede trasladarse intacta a RPC**: sus vistas interactivas requieren adaptadores en el host o una alternativa de integración. Lo mismo aplica a los componentes TUI invasivos de `pi-cinlodev-cute`.

Hay que verificar el comportamiento con la **versión de Pi realmente instalada por HARIL**: la documentación de `main` no prueba que la versión fijada soporte exactamente las mismas operaciones.

## Alternativas

| Ruta | Evaluación |
| --- | --- |
| Seguir ampliando `ctx.ui.setHeader()` | No resuelve paneles a toda altura. Queda solo como fallback. |
| Crear otra TUI dentro de la extensión Pi | Genera dos controladores de cursor, foco y redimensionamiento. Descartada. |
| Mantener un fork de Pi | Alto coste de mantenimiento y riesgo al actualizar. No recomendado. |
| Ampliar `apps/shell` y adaptar Pi por RPC/SDK | Reutiliza compositor, temas y pruebas existentes. **Recomendado, condicionado a paridad.** |

## Qué valida este PR

`joinThreeColumns()` es una primitiva **pura** del compositor del shell. Pinta tres paneles completos, alineados fila a fila, y corta cada uno dentro de su ancho. Las pruebas comprueban altura/anchura exactas, caracteres Unicode, estilos y geometría inválida.

Esto **solo demuestra viabilidad de renderizado de tres columnas**. Todavía no demuestra integración Pi, streaming, autenticación, controles de seguridad, extensiones ni navegación; no cambia el comportamiento de producción.

## Puertas de aceptación antes de activar el nuevo host

- [ ] Con Pi fijado por HARIL: prompt, streaming, herramientas, cancelación, login/modelo y recuperación de sesiones.
- [ ] Paridad para las aprobaciones y los modos ACTION/CONSULT/PLAN/DELEGATION, `/delegate`, STOP ALL, superposición de vistas y orquestación.
- [ ] Chat con scroll propio, focos independientes, teclado, ratón, selección, pegado y redimensionamiento durante streaming.
- [ ] En ventanas estrechas, contraer docks a iconos sin interrumpir la entrada central.
- [ ] Extensiones incompatibles aisladas o adaptadas sin romper la TUI ni ejecutar código no autorizado.
- [ ] Terminal sanitizada ante salida de herramientas no confiable; errores de Pi no destruyen la pantalla.
- [ ] Pruebas en Windows Terminal, PowerShell y WSL, y CI Windows/Ubuntu en verde.
- [ ] Fallback funcional a la consola actual; actualizaciones de Pi/Gentle Shell independientes.

## Siguientes PR

1. Registro y configuración persistente de plugins, menús, temas, visibilidad y orden.
2. Adaptador Pi RPC/SDK probado con una sesión real; no cambiar el modo predeterminado hasta pasar las puertas de aceptación.
3. Viewport central y docks laterales conectados a datos reales; administrador visual de plugins.
4. Pestañas y atajos (`Alt+Z` + número, `Alt+K`, `Alt+P`, `Alt+R`) y acciones completas.

La decisión definitiva entre RPC y SDK queda expresamente pendiente de la prueba de paridad. La estética no debe romper las funciones existentes de HARIL.
