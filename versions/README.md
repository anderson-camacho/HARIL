# Versiones de HARIL

## Estado actual

- **Versión actual:** 0.6.0.
- **Estado:** **MVP cerrado (0.6.0).**
  - El almacén SQLite es durable y concurrente, con copia de seguridad y recuperación tras caída probadas matando procesos reales.
  - Incluye proyectos, tareas y planes, un Broker local con tope de tokens y el adaptador de Pi 1.2.0 con su puente.
  - El guardián de rutas detecta enlaces.
  - Hay criterios de aceptación verificables, metodologías como bloques, un instalador que no toca el PATH y la interfaz `haril shell`.
- **Verificación:**
  - la suite hermética pasa;
  - la CI pública pasa en Windows y Linux;
  - el carril real (Pi 1.2.0 con un modelo real a través de CLIProxyAPI) pasa en el equipo de referencia.
- **Interfaz:** `haril shell` (0.5.0) muestra proyectos, tareas, agentes, tokens, eventos, modelos, configuración y temas, y permite añadir tareas y elegir tema.
- **Pendiente:**
  - vista en vivo con suscripción al runtime;
  - planificación a partir de un objetivo, con aprobaciones;
  - integración con Herdr;
  - memoria con Engram.

Las versiones 0.x son preliminares: pueden cambiar sin compatibilidad hacia atrás.

## Carpetas por versión mayor

Más reciente primero. Cada carpeta contiene el archivo de cambios de su versión mayor, con las versiones menores y de parche, la más nueva arriba.

- [v0](v0/CHANGELOG.md): versiones 0.1.0 a 0.6.0.
