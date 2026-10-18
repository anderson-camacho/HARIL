# Versiones de HARIL

## Estado actual

- **Versión actual:** 0.9.0.
- **Estado:** **vista de orquestación en la consola, con datos de ejemplo (0.9.0)**, sobre la consola de HARIL sobre Pi (0.8.0), la demo en vivo de M4 (0.7.0) y el MVP cerrado en 0.6.0.
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
  - la consola tiene sus primeras pruebas automáticas (la vista de orquestación), pero todavía no se ha probado en una terminal real.
- **Interfaz:** `haril` sin subcomando (o `haril console`) abre Pi, el fijado por HARIL, en la carpeta actual con la extensión de HARIL: todos los comandos de Pi (`/login`, `/model`, el nivel de razonamiento), una barra amarilla con proyecto, modelo, contexto, coste, planes por aprobar y runtime, áreas navegables con clic, la vista de orquestación (`/orchestration demo`, `/orchestration view` o `Alt+O`) y `/goal`, `/plans`, `/plan`, `/approve`, `/deny`, `/tasks` y los demás comandos de HARIL. Los modelos de `haril.json` aparecen en `/model`. `haril shell` abre la interfaz anterior, sin la caja Taxis.
- **Pendiente (M4):**
  - memoria con Engram conectada al runtime;
  - worktrees por intento;
  - integración con Herdr;
  - keyring para las claves;
  - los runtimes de Claude Code y Codex.

Las versiones 0.x son preliminares: pueden cambiar sin compatibilidad hacia atrás.

## Carpetas por versión mayor

Más reciente primero. Cada carpeta contiene el archivo de cambios de su versión mayor, con las versiones menores y de parche, la más nueva arriba.

- [v0](v0/CHANGELOG.md): versiones 0.1.0 a 0.9.0.
