# Versiones de HARIL

## Estado actual

- **Versión actual:** 0.4.1.
- **Estado:** MVP de la fase 4 completo. Incluye el almacén SQLite con recuperación tras caída, proyectos, tareas y planes, un Broker local con tope de tokens, el adaptador de Pi 1.2.0 con su puente, proveedores configurables, metodologías como bloques y un instalador propio que no toca el PATH.
- **Verificación:** la suite hermética (sin red ni Pi real) pasa, y el carril real (Pi 1.2.0 con un modelo real a través de CLIProxyAPI) pasa en el equipo de referencia. El CI remoto todavía no se ha ejecutado.
- **Pendiente:** interfaz de terminal (M4), integración con Herdr y memoria con Engram.

Las versiones 0.x son preliminares: pueden cambiar sin compatibilidad hacia atrás.

## Carpetas por versión mayor

Más reciente primero. Cada carpeta contiene el archivo de cambios de su versión mayor, con las versiones menores y de parche, la más nueva arriba.

- [v0](v0/CHANGELOG.md): versiones 0.1.0 a 0.4.1.
