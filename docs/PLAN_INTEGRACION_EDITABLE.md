# Plan editable de integración y reorganización de HARIL

> **Tipo:** propuesta de trabajo, NO implementación.
> **Base revisada:** rama main, HARIL 0.23.12 (30 de octubre de 2026).
> **Propósito:** que el propietario cambie prioridades y decisiones ANTES de autorizar cambios de código.
> **Estado:** borrador editable. No fusionar este documento como autorización para instalar o activar herramientas.

## 1. Punto de partida comprobado

- HARIL abre una consola basada en Pi y dispone de CLI, runtime, tareas, planes, modos, delegación y seguimiento de workflows.
- El panel lateral derecho está reorganizado en **MAIN**, **MEM** y **DOCS**. MAIN contiene estado y áreas; MEM muestra memoria; DOCS consulta una carpeta local de Markdown configurable con docs.path.
- TREE/Explorador, la pestaña Git, YouTube y el selector THEME fueron retirados intencionalmente del panel en versiones recientes. La rama y algunas herramientas Git subsisten fuera de esas pestañas.
- El código conserva ajustes y componentes de temas y de Matrix de versiones anteriores, pero **no debe asumirse que Matrix esté habilitado en el flujo actual**. Respetar la decisión de desactivarlo mientras se reorganiza el producto.
- Existen configuraciones antiguas de usuarios: cualquier cambio debe migrarlas de manera compatible, sin restablecer paneles eliminados ni preferencias por sorpresa.
- El runtime y Pi se administran en el entorno privado de HARIL; los servicios o extensiones de terceros no necesariamente están instalados ni funcionando.

## 2. Objetivo de esta futura implementación

Consolidar en una sola experiencia coherente los componentes **existentes y aprobados** de HARIL: interfaz, configuración, dependencias, CLI, instalación y actualización. Evitar funcionalidades decorativas que parezcan operativas sin serlo.

**Fuera del alcance de este PR de planificación:** cambios de interfaz, reactivación de Matrix, instalación de programas, descargas, cambios de dependencias o alteraciones del runtime. Todo eso se realizará en PR(s) de implementación posteriores y revisables.

## 3. Decisiones que debes editar primero

Marca una opción por cada tema y rellena lo pendiente:

- **Matrix al iniciar:**
  - [x] Mantener desactivado por ahora, sin reactivarlo durante la reorganización.
  - [ ] Ofrecerlo opcionalmente desde una preferencia explícita.
  - [ ] Activarlo por defecto solo después de una revisión visual y tu aprobación.
- **Tema global:**
  - [ ] Verde/negro Matrix en todos los componentes.
  - [ ] Conservar el tema actual hasta decidir una paleta.
  - [ ] Otro: __________________________
- **Interfaz:** conservar MAIN / MEM / DOCS, salvo decisión explícita: __________________________
- **Integraciones externas prioritarias:** __________________________
- **Sistemas operativos objetivo:** Windows 11 / PowerShell; validar Linux y WSL cuando corresponda.
- **Primer caso de uso a demostrar:** __________________________
- **Funcionalidades que NO deben recuperarse:** __________________________
- **Condiciones para permitir instalaciones automáticas:** __________________________

## 4. Inventario de herramientas y repositorios (antes de instalar)

| Herramienta / origen | Situación a comprobar | Acción propuesta |
| --- | --- | --- |
| **HARIL** — https://github.com/anderson-camacho/HARIL | Código y configuración de main; versión 0.23.12 al redactar | Conservar como fuente única, revisar el estado actual antes de empezar |
| **Pi** — runtime y paquete fijados por HARIL | Instalación privada, compatibilidad de TUI y comandos | Reutilizar; no modificar el Pi global ni Gentle Shell |
| **TerminalTextEffects** — https://github.com/ChrisBuilds/terminaltexteffects | Herramienta del efecto Matrix previamente integrada; actualmente no asumir activación | **Opcional:** solo preparar uv/Python/TTE si se decide activar Matrix |
| **pi-claude-bridge** — paquete npm pi-claude-bridge | Integración Claude existente en el código; estado real depende de instalación y credenciales | Verificar sin instalar ni iniciar sesión por sorpresa |
| **CLIProxyAPI** — gateway externo configurable | HARIL puede consumirlo, pero no lo instala | Comprobar conectividad/configuración solo cuando se use |
| **Obsidian / Markdown** — carpeta elegida por docs.path | DOCS consulta notas locales; Obsidian las administra por fuera | No instalar Obsidian ni escribir notas automáticamente |
| **Engram, Herdr y otras extensiones Pi** | Partes previstas o integraciones incompletas; no asumir que funcionen | Inventariar y priorizar aparte; instalar únicamente con aprobación |

**Reglas para dependencias:** detectar antes de instalar; fijar versiones compatibles; validar ejecutables y funcionamiento, no solo la existencia de archivos; evitar descargas redundantes; aislar todo en la carpeta HARIL; preservar configuraciones y cuentas; informar claramente los fallos. No instalar herramientas opcionales desactivadas.

## 5. Trabajo propuesto por etapas

### Etapa A — Auditoría de main (obligatoria)
- [ ] Leer los cambios recientes y confirmar la versión/estructura real antes de modificar código.
- [ ] Identificar módulos activos, código heredado, extensiones efectivas, rutas de configuración y pruebas.
- [ ] Elaborar matriz «existe / funciona / requiere instalación / desactivado / retirado».
- [ ] Detectar conflictos entre paleta HARIL, tema Pi, barra inferior y panel lateral.

### Etapa B — Integración de interfaz
- [ ] Mantener el panel derecho MAIN/MEM/DOCS y su navegación por mouse/teclado.
- [ ] Unificar colores, contraste, foco, alertas, bordes y estados según la paleta que apruebes.
- [ ] Verificar cada acción, contador y etiqueta; eliminar duplicados y corregir controles inertes.
- [ ] Si se aprueba Matrix, probar lluvia a pantalla completa, transición fluida a «HARIL» y pausa de 3 segundos, **sin introducirla en el arranque actual hasta autorizarlo**.
- [ ] Adaptar la interfaz al tamaño de Windows Terminal; conservar un modo compacto útil.

### Etapa C — Instalación, update y reparación
- [ ] Determinar qué componentes son esenciales, opcionales o de terceros administrados por el usuario.
- [ ] Hacer que instalación y haril update verifiquen versiones, integridad básica y ejecución real de componentes administrados.
- [ ] Si faltan o están dañados, ofrecer reparación idempotente únicamente de los componentes permitidos.
- [ ] No reinstalar herramientas sanas ni cambiar preferencias sin consentimiento; reportar fallos.
- [ ] Asegurar que haril update --check inspeccione sin instalar ni modificar archivos.

### Etapa D — Integración funcional
- [ ] Comprobar modelos, niveles, sesión, modos y delegación sin mezclar estados visuales con estados reales.
- [ ] Verificar los datos reales de MAIN, MEM y DOCS, sus comandos y sus límites.
- [ ] Distinguir los estados de extensiones observadas del inventario de paquetes instalados.
- [ ] Conectar solamente integraciones aprobadas; documentar claramente funciones todavía no disponibles.

### Etapa E — Pruebas y entrega
- [ ] Compilar; ejecutar comprobaciones de estilo, tipado, versión y pruebas de regresión.
- [ ] Pasar CI en Windows y Linux, y probar manualmente interfaz, colores, mouse, teclado y arranque en Windows Terminal.
- [ ] Probar instalación limpia, actualización con versión nueva, misma versión, dependencia rota, sin red y reparación.
- [ ] Revisar que no se modifiquen credenciales, configuraciones de Pi/Gentle Shell globales ni proyectos existentes.
- [ ] Entregar PR de implementación independiente, con evidencia, capturas reales y lista explícita de pendientes.

## 6. Criterios de aceptación

- [ ] Se conserva MAIN/MEM/DOCS y no reaparecen pestañas eliminadas sin aprobación.
- [ ] Los colores son consistentes en panel, chat, menús y barra según el tema elegido.
- [ ] Cada botón/atajo relevante ejecuta la acción anunciada o explica por qué no está disponible.
- [ ] haril update instala y repara **solo** dependencias administradas y habilitadas, y valida el resultado.
- [ ] El proceso puede repetirse sin instalaciones redundantes ni pérdida de ajustes.
- [ ] Las pruebas automáticas de Windows y Linux pasan; el aspecto real en Windows Terminal se comprueba.
- [ ] Matrix sigue desactivado hasta que se marque una decisión distinta en este plan.

## 7. Prompt breve para el agente implementador (editar después de tomar decisiones)

«Trabaja desde la última main de https://github.com/anderson-camacho/HARIL. Lee este plan y aplica solo las decisiones aprobadas. Respeta la reorganización MAIN/MEM/DOCS y los componentes eliminados; no reactives Matrix ni instales extras sin autorización. Inspecciona el estado real de Pi, dependencias, interfaces, modelos y CLI. Integra los módulos aprobados, unifica los colores, corrige controles defectuosos y mejora instalación/update con verificación y reparación idempotente de componentes habilitados. Valida en Windows y Linux, realiza una prueba visual real de Windows Terminal y entrega código probado en un PR separado contra main. No sustituyas resultados de pruebas por supuestos.»

## 8. Registro de cambios del plan (editable)

| Fecha | Decisión o corrección | Aprobación |
| --- | --- | --- |
| 2026-10-30 | Primer borrador basado en HARIL 0.23.12, sin implementar cambios | Pendiente |
| AAAA-MM-DD | __________________________ | __________________ |

**Cómo editarlo:** abre este archivo en GitHub y usa el lápiz (Edit file), o descarga el .md, ábrelo en VS Code/Obsidian y modifica las casillas y campos. Primero cierra las decisiones del apartado 3; después utiliza el apartado 7 como instrucción de implementación.
