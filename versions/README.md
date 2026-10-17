# Versiones de HARIL

## Estado actual

- **Versión actual:** 0.7.0.
- **Estado:** **demo en vivo de M4 (0.7.0)**, sobre el MVP cerrado en 0.6.0.
  - El almacén SQLite es durable y concurrente, con copia de seguridad y recuperación tras caída probadas matando procesos reales.
  - Incluye proyectos, tareas y planes, un Broker local con tope de tokens y el adaptador de Pi 1.2.0 con su puente.
  - El guardián de rutas detecta enlaces.
  - Hay criterios de aceptación verificables, metodologías como bloques, un instalador que no toca el PATH y la interfaz `haril shell`.
  - El runtime es residente: sale tras 120 s sin trabajo y despierta por un pipe de control, sin sondeo.
  - A partir de un objetivo, el agente `planner` propone un plan que una persona revisa entero y aprueba o rechaza; las tareas del plan heredan el modelo del planner.
- **Verificación:**
  - la suite hermética pasa, con la demo `npm run e2e:demo`;
  - la CI pública corre en Windows y Linux en cada PR;
  - el carril real (Pi 1.2.0 con un modelo real a través de CLIProxyAPI) pasa en el equipo de referencia, y la demo en vivo se ejecutó cuatro veces con `cliproxy/gemini-3-flash`.
- **Interfaz:** `haril` sin subcomando abre la interfaz en una sola ventana y arranca el runtime cuando hay trabajo. Tiene una caja de entrada siempre visible para el objetivo, modos de teclado, comandos `/`, la revisión del plan con cada tarea completa y la vista en vivo con estado, intentos, tokens y resultado.
- **Pendiente (M4):**
  - memoria con Engram;
  - worktrees por intento;
  - integración con Herdr;
  - keyring para las claves;
  - los runtimes de Claude Code y Codex;
  - pasar los resultados de una tarea a las que dependen de ella;
  - guardar la salida que no pasa la verificación y reintentar con el motivo del fallo.

Las versiones 0.x son preliminares: pueden cambiar sin compatibilidad hacia atrás.

## Carpetas por versión mayor

Más reciente primero. Cada carpeta contiene el archivo de cambios de su versión mayor, con las versiones menores y de parche, la más nueva arriba.

- [v0](v0/CHANGELOG.md): versiones 0.1.0 a 0.7.0.
