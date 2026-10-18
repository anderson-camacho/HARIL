# Versiones de HARIL

## Estado actual

- **Versión actual:** 0.14.0.
- **Estado:** **agentes reales de solo lectura en la delegación en tres capas (0.14.0)**, sobre el runtime de la delegación con agentes simulados (0.13.0), los datos de la delegación, el registro de consumo y la demostración simulada (0.12.0), el núcleo puro de la delegación (0.11.0), el modelo y nivel de razonamiento en la consola (0.10.0), la vista de orquestación con datos de ejemplo (0.9.0), la consola de HARIL sobre Pi (0.8.0), la demo en vivo de M4 (0.7.0) y el MVP cerrado en 0.6.0.
  - `haril workflow start <objetivo> --agent orchestrator` corre un workflow con agentes reales de Pi a través del Broker: el orquestador, los delegadores, los ejecutores, sus auditores y el auditor final, con el modelo del orquestador hasta que llegue el catálogo. Solo leen: cada uno recibe `read` y las herramientas de su rol, y el adaptador de Pi se niega a lanzar un turno con otra cosa. El auditor final recibe el resumen del orquestador. `haril run` cuenta los turnos de workflow y sale con 1 si un workflow falla. Probado con `cliproxy/gemini-3-flash` en `npm run e2e:workflow-real`.
  - `haril workflow start` encola un workflow de tres capas y el runtime lo corre con varios agentes a la vez, sin pasar los límites: el orquestador delega, cada delegador asigna pasos, cada ejecutor tiene su auditor, los rechazos se relanzan y escalan como mucho una vez, las continuaciones corren aunque un hijo falle y un auditor final cierra el workflow. Tras una caída sigue sin repetir trabajo y con los mismos conteos de reproceso. `haril workflow list|show|continue` lo leen y liberan sus paradas. Sin `--agent`, los agentes son los simulados (`fake:*`).
  - `haril workflow demo` corre un árbol simulado de orquestador, delegadores, ejecutores y auditores con las reglas del Core y el almacén real, sobre un almacén temporal, y muestra el árbol, los totales y los picos de agentes vivos frente a cada límite. Las migraciones `0007` y `0008` guardan workflows, propuestas, veredictos y dependencias `settled`.
  - Cada orden y cada intento quedan en un registro de solo añadir con cadena de hashes: `haril usage log|summary|verify|export` lo lee, filtra por tiempo y tipo, y detecta una fila alterada a mano.
  - El Core valida las propuestas de los agentes (límites por hilo y por workflow, profundidad, modelos, paradas), decide qué tareas arrancan sin pasar ningún límite ni solapar superficies de escritura, elige el modelo de cada agente (el fijado por el usuario nunca se sustituye; reglas de cuota 80/80/20 y «sin dato»), acota los reprocesos a 1 relanzamiento y 1 escalada y da el veredicto del vigilante de 15 minutos. Son funciones puras con sus contratos de herramientas, y el runtime de 0.13.0 las usa (el vigilante, desde F3).
  - Cada cambio entregado sube la versión: `scripts/bump-version.mjs` la sube en todos los archivos y `npm run check` (también en la CI) falla si falta la subida o la entrada del CHANGELOG.
  - La barra y las cabeceras muestran siempre el modelo y su nivel; un clic los cambia. Cada modelo de CLIProxyAPI ofrece solo los niveles que publica en su lista `?client_version=`, y el nivel llega al proveedor como `reasoning_effort`. El nivel se recuerda por modelo durante la sesión.
  - El módulo `ORCHESTRATION` muestra la maqueta aprobada de la delegación en tres capas, con clic y con teclado; sin motor de orquestación todavía, solo tiene datos con `/orchestration demo`, rotulados como de ejemplo.
  - El almacén SQLite es durable y concurrente, con copia de seguridad y recuperación tras caída probadas matando procesos reales.
  - Incluye proyectos, tareas y planes, un Broker local con tope de tokens y el adaptador de Pi 1.2.0 con su puente.
  - El guardián de rutas detecta enlaces.
  - Hay criterios de aceptación verificables, metodologías como bloques y un instalador que no toca el PATH.
  - El runtime es residente: sale tras 120 s sin trabajo y despierta por un pipe de control, sin sondeo.
  - A partir de un objetivo, el agente `planner` propone un plan que una persona revisa entero y aprueba o rechaza; las tareas del plan heredan el modelo del planner y reciben los resultados de las tareas de las que dependen. Un reintento por verificación recibe el motivo del rechazo.
  - Memoria: el puerto `MemoryProvider`, el outbox, `haril memory status` y el adaptador de Engram con su supervisión existen; el runtime todavía usa el proveedor nulo.
  - Las claves de los proveedores se leen por referencia a través del puerto `SecretStore`.
- **Verificación:**
  - la suite hermética pasa, con la demo `npm run e2e:demo`;
  - la CI pública corre en Windows y Linux en cada PR;
  - el carril real (Pi 1.2.0 con un modelo real a través de CLIProxyAPI) pasa en el equipo de referencia, y la demo en vivo de la 0.7.0 se ejecutó cuatro veces con `cliproxy/gemini-3-flash`;
  - el carril real de la delegación (`npm run e2e:workflow-real`) completó dos veces un workflow de lectura y análisis con agentes reales y `cliproxy/gemini-3-flash`, sin intervención;
  - la consola tiene pruebas automáticas (la vista de orquestación, el modelo y el nivel), pero todavía no se ha probado en una terminal real;
  - la demostración de la delegación tiene pruebas automáticas con varias semillas y tamaños (límites, reprocesos, determinismo y cadena de hashes); no llama a ningún modelo;
  - el nivel elegido llega como `reasoning_effort` por el camino real de Pi 1.2.0, comprobado contra un servidor falso y contra el CLIProxyAPI local.
- **Interfaz:** `haril` sin subcomando (o `haril console`) abre Pi, el fijado por HARIL, en la carpeta actual con la extensión de HARIL: todos los comandos de Pi (`/login`, `/model`, el nivel de razonamiento), una barra amarilla con proyecto, modelo y nivel (con clic para cambiarlos), contexto, coste, planes por aprobar y runtime, áreas navegables con clic, la vista de orquestación (`/orchestration demo`, `/orchestration view` o `Alt+O`) y `/goal`, `/plans`, `/plan`, `/approve`, `/deny`, `/tasks` y los demás comandos de HARIL. Los modelos de `haril.json` aparecen en `/model`. `haril shell` abre la interfaz anterior, sin la caja Taxis.
- **Pendiente (M4):**
  - memoria con Engram conectada al runtime;
  - worktrees por intento;
  - integración con Herdr;
  - keyring para las claves;
  - los runtimes de Claude Code y Codex.

Las versiones 0.x son preliminares: pueden cambiar sin compatibilidad hacia atrás.

## Carpetas por versión mayor

Más reciente primero. Cada carpeta contiene el archivo de cambios de su versión mayor, con las versiones menores y de parche, la más nueva arriba.

- [v0](v0/CHANGELOG.md): versiones 0.1.0 a 0.14.0.
