# Changelog de HARIL, versión mayor 0

Las versiones van de la más reciente a la más antigua. Cada entrada indica la versión, la fecha, el estado y los cambios agrupados en Añadido, Cambiado y Corregido, y cómo se verificó.

---

## 0.7.0

- **Fecha:** 2026-10-17
- **Estado:** **demo en vivo de M4.** Desde `haril`, en una sola ventana: se escribe un objetivo, el agente `planner` propone un plan con un modelo real, la persona lo revisa entero y lo aprueba o lo rechaza, y la vista en vivo sigue sus tareas hasta el resultado. El runtime es residente, despierta por un pipe de control sin sondeo y lo arranca la propia interfaz cuando hay trabajo. La demo se ejecutó cuatro veces con `cliproxy/gemini-3-flash` a través de CLIProxyAPI, y su versión hermética corre en la CI.

### Añadido

- **Runtime residente (PR #13):**
  - `haril start` se queda en marcha y sale tras 120 s sin trabajo (`--idle-exit-sec <n>`);
  - `haril run` procesa la cola y sale;
  - `haril stop` lo detiene en orden: el run en curso queda `cancelled`, la tarea vuelve a `ready` sin cobrar intento, las claves virtuales se revocan y las reservas se liquidan;
  - `Ctrl+C` y `SIGTERM` paran igual; una segunda señal sale con 130.
- **Pipe de control y suscripciones (PR #14):** paquete `@haril/control` (pipe con nombre en Windows, socket en POSIX, con token y líneas JSON). El runtime publica eventos ya redactados, se mantiene vivo mientras haya suscriptores y despierta con un `nudge`, que la CLI envía tras encolar. La interfaz se suscribe y vuelve a leer el almacén con un debounce de 250 ms, sin sondeo.
- **Aprobación de planes (PR #16):**
  - tabla `approvals` (migración 0004, aditiva);
  - `haril plan propose`, `haril approvals [--all]`, `haril approve <id>` y `haril deny <id>`;
  - el runtime aplica cada decisión en su siguiente turno, antes de la cola, con la misma clave de idempotencia que `plan import`, y registra `approval.applied`;
  - en N0 la decisión es una declaración, no una autenticación.
- **Planificador (PR #18):**
  - tareas `--kind plan`: el agente `planner` (Pi real) propone el plan con la herramienta del puente `haril_propose_plan`, Core lo valida y queda como aprobación pendiente;
  - `fake:plan` para el carril hermético, sin tokens;
  - una tarea de plan que acaba sin propuesta falla (`plan.not_proposed`), y una que acaba `failed` deniega el plan que dejó pendiente;
  - un plan no puede contener una tarea que nombre al agente `planner`;
  - el evento `approval.requested` despierta a los suscriptores.
- **`haril` sin subcomando (PR #17):** en una terminal abre la interfaz; fuera de una terminal imprime la ayuda y sale con 2.
- **Objetivo, revisión del plan y vista en vivo en la interfaz (PR #20):** el formulario `g` del objetivo; el panel Planes, con el detalle del plan y `y`/`n`; el panel En vivo, con las tareas más recientes (estado, agente, intento, tokens y primera línea del resultado). La interfaz pasa de 11 a 13 paneles.
- **Una sola ventana (PR #21, ADR-0022):** sin un runtime con lease vivo y con trabajo pendiente, la interfaz arranca `haril start --started-by shell` como hijo desacoplado y sin ventana. Su salida va a `logs\runtime-<fecha>.log`, el runtime registra `runtime.started_by_shell` y `--no-runtime` lo impide. No hay demonio: el hijo sale por inactividad como cualquier `haril start`.
- **Consola rediseñada (PR #23 y #24):**
  - barra superior (proyecto, modelo, contexto de la tarea en curso, tokens y runtime), columna derecha con cajas de estado a partir de 100 columnas (git, runtime, aprobaciones, taxis y tokens), banner HARIL en reposo y línea de estado; funciona desde 80x24;
  - lectura de git para la caja de estado (`integrations/git`), sin shell y con tiempo límite;
  - temas `haril-crimson` (el nuevo predeterminado) y `haril-blossom`, con los tokens opcionales `border`, `ok` y `danger`;
  - caja de entrada siempre visible: modo entrada (Enter envía el objetivo) y modo navegación (`Esc` e `i`), con `Ctrl+C` para salir en los dos;
  - comandos `/` con autocompletado: `/projects`, `/tasks`, `/plans`, `/live` y los demás paneles principales, `/approve [id]`, `/deny [id]`, `/add`, `/reload`, `/help` y `/quit`.
- **`haril approvals show <id> [--json]` (PR #28):** el plan completo antes de decidir, con cada tarea y su modelo. Un plan pendiente que las reglas actuales rechazarían muestra `refused by the current rules: <motivo>`, y una decisión aplicada, `applied <fecha>`.
- **`npm run e2e:demo` (PR #27):** demo hermética de punta a punta (`scripts/e2e-demo.mjs`), también como paso de la CI:
  - carril simulado: objetivo, plan de `fake:plan`, aprobación, tareas completadas y parada limpia;
  - carril real con el Pi falso y un servidor OpenAI falso en loopback: las tareas `analyst` corren con el modelo heredado del planner;
  - un plan denegado no crea tareas, y ninguno las crea antes de aprobarse.

### Cambiado

- **Las tareas de un plan heredan el modelo del planner (PR #26, migración 0005):**
  - la aprobación guarda el modelo de la tarea que propuso el plan (`approvals.model`, nulo para un plan de `plan propose` o de `plan import`); el modelo sale de la tarea reclamada en el almacén, nunca del agente;
  - al aplicarla, `plan.submit` lleva `args.defaultModel` y cada tarea del plan lo recibe; el plan nunca nombra un modelo, y la clave de idempotencia y el hash se siguen calculando solo con el plan;
  - `haril approvals` y el detalle del plan muestran `model <id|none>` antes de decidir;
  - el esquema del almacén pasa de 3 a 5 con dos migraciones aditivas (0004 y 0005); una versión anterior no abre una base ya migrada, que nunca se degrada.
- **Planes que encajan con lo que pueden hacer los agentes (PR #28 y commit `6ba88a5`):**
  - el prompt del planner dice que `analyst` solo lee y responde en su resultado, que las tareas no ven los resultados de las demás y que basta una tarea por resultado (de 1 a 5 tareas), que una comprobación de aceptación prueba el resultado de su propia tarea y que la descripción añade detalle sin copiar el objetivo;
  - la regla de Core `read_only_agent_writes` rechaza una tarea `analyst` con archivos que escribir, en todas las entradas de planes (`plan validate`, `plan propose`, `plan import` y el planner, que recibe el motivo);
  - el prompt del agente incluye `Files to read: …` con la superficie de lectura de la tarea;
  - si el objetivo pide un archivo, la última tarea pide «Return the full content of <archivo> as the result» y el `analyst` devuelve solo ese contenido, sin preámbulo ni bloque de código.
- **Intentos (PR #28):** el intento que acaba bien también se cuenta; una tarea completada al primer intento muestra `1/N` en vez de `0/N`.
- `agent.invalid_spec` nombra exactamente lo que falta (modelo, proyecto o tope de tokens) (PR #26).
- El guion `test` da 15 s a cada prueba (`--testTimeout=15000`) para que las pausas de E/S del runner no hagan fallar la CI (PR #16).

### Corregido

- **Lo que se ve es lo que se aprueba:**
  - las secuencias de escape del texto de agentes y del almacén ya no llegan a la terminal: todo carácter de control C0/C1 y DEL se muestra como `?` (PR #20);
  - los caracteres invisibles (los de formato, `\p{Cf}`, los demás `Default_Ignorable_Code_Point` como los selectores de variación y los rellenos de Hangul, y los sustitutos sueltos) también se muestran como `?`; solo se conservan el selector de presentación tras un emoji y la unión de ancho cero (ZWJ) en posiciones válidas (PR #25);
  - el detalle del plan muestra todos los campos que llegan al agente o cambian lo que puede hacer (descripción, escrituras y lecturas, tipo, prioridad, intentos, tiempo, presupuesto, requisitos, contexto y aceptación); antes la descripción no se mostraba aunque entraba en el prompt (PR #25);
  - la caja de entrada y los formularios envían el texto tal como se ve (PR #24 y #25);
  - `visibleText` pasa a Core y la salida de texto de la CLI con texto de agentes (`approvals`, `approvals show`, `task show`, `status`, `project list`, `events`, `run` y `start`) lo aplica; `--json` conserva el texto tal cual (PR #28).
- El evento `tool.plan.propose` de un plan rechazado guarda el motivo que recibió el agente (como mucho 500 caracteres), nunca el plan; antes el motivo solo quedaba en el registro de la sesión de Pi (PR #28).
- `database is locked` bajo carga: la espera del lock de escritura se reinicia cada vez que otro proceso confirma, hasta 10 s (PR #19, INV-01).
- INV-18 en el runner Windows de la CI: hasta 3 mediciones, y una cota de 400 ms solo en ese runner (100 ms en local y en Linux) (PR #13 y #16).
- Un runtime hijo que muere antes de tomar el lease ya no deja la interfaz en "starting": la línea de estado da su código de salida y el log que hay que leer (PR #21).
- Un carácter ancho (CJK) ya no deja una línea una celda más ancha que la terminal, y git se lee como mucho una vez cada 5 s cuando el runtime avisa (PR #23).
- El formato de `scripts/tests/foreign-snapshot.test.mjs`, que dejó `main` en rojo (PR #15).
- E2E:
  - el control de instalaciones ajenas ignora la caché de modelos de Codex, el estado por sesión de Claude Code y las bases SQLite de primer nivel de `~/.codex` (PR #14, #20 y #27);
  - `e2e.mjs` ya no copia `process.env` a sus procesos hijos, así que las variables `HARIL_*` del usuario, con su clave, no les llegan (PR #27).

### Desvíos y aplazamientos

- **Las tareas no ven los resultados de las otras.** Pasar resultados entre tareas es orquestación de M4; por eso un plan útil suele ser de una sola tarea.
- **`analyst` solo lee.** Un archivo pedido vuelve como resultado de la última tarea y la persona lo aplica; no hay todavía un agente que escriba (`developer`).
- **La salida que no pasa la verificación no se guarda** (`result: none`) y el reintento no recibe el motivo del fallo.
- **La primera propuesta del planner real suele omitir la `description`** de alguna tarea; Core la rechaza con el motivo y el planner la corrige en el mismo run.
- **El coste no se registra:** la barra superior muestra `n/a`.
- **Windows Terminal real sin verificar:** el aspecto (caracteres de ancho ambiguo, cursor, protocolo Kitty y pegado real) solo se probó con una terminal virtual.
- **Pipe de control:** no tiene el acuse de 3 s del diseño; el canal se cierra después de liberar el lease.
- **Menores conocidos:** una decisión del runtime se registra con `actorKind: "user"`; tras denegar un plan, el resultado guardado del planner sigue diciendo que espera aprobación (su estado `completed` sí es correcto); INV-01 aún falla de forma intermitente en el runner Windows cargado.

### Verificación

- Las tareas de aprobaciones, planificador, interfaz, arranque del runtime, consola y demo (PR #16, #18, #20, #21 y #23 a #28) tuvieron un verificador independiente de solo lectura y, con sus hallazgos, una corrección acotada. El de la caja de entrada (PR #24) recorrió todos los tamaños de 1 a 200 columnas, 6000 teclas aleatorias con semilla y pegados hostiles sin romper ningún invariante.
- La CI pública corre en Windows y ubuntu en cada PR, con `e2e:demo` como paso propio desde el #27.
- Local: `pnpm run check` 0; `pnpm test` con 1169 pruebas de Vitest (1 omitida, solo POSIX) y 56 de `node:test`; `npm run e2e` 38 pasos; `npm run e2e:demo` 21 pasos.
- **Demo real** con `cliproxy/gemini-3-flash` a través de CLIProxyAPI, con datos temporales y sin imprimir la clave:
  1. el flujo funcionó de punta a punta (plan de 2 tareas `analyst`, las dos completadas con el modelo heredado) y sacó a la luz lo que corrigió el PR #28;
  2. dos demos completas, todas las tareas al primer intento, en unos 31 s y con 14 643 tokens de entrada y 1 488 de salida; en una de ellas, la primera propuesta del planner se rechazó por esquema y él mismo la corrigió;
  3. el plan ya tenía la forma buscada, pero una comprobación de aceptación de una tarea que solo leía no podía cumplirse; de ahí el commit `6ba88a5`;
  4. las dos demos completaron todas sus tareas al primer intento, en unos 22 s y con unos 15 800 tokens.

---

## 0.6.0

- **Fecha:** 2026-10-17
- **Estado:** **MVP cerrado.** Los 15 criterios de aceptación se cumplen o tienen un desvío explícito y justificado. La CI remota pasa en Windows y Linux.

### Añadido

- **Guardián de rutas con enlaces:**
  - rechaza symlinks y junctions;
  - aplica una lista de rutas denegadas para lectura (`.git`, `.env`, `.haril`, `.pi`);
  - rechaza los nombres reservados de Windows y los segmentos que terminan en punto o espacio;
  - compara el `realpath` con la raíz;
  - lee con verificación de identidad (`dev`/`ino`) para evitar el cambio de archivo entre la comprobación y la lectura.
- **Recuperación tras caída:** el reconciliador revoca las claves virtuales de los runs huérfanos y liquida sus reservas abiertas. Pruebas que matan el proceso de verdad en los puntos de caída CP1, CP3, CP4 y CP8.
- **Durabilidad del almacén:**
  - copia de seguridad con `VACUUM INTO` verificada antes de colocarla;
  - WAL acotado (`wal_autocheckpoint` de 1000 páginas);
  - prueba de `kill -9` en bucle;
  - rechazo de raíces de datos en UNC, WSL u OneDrive.
- **Invariantes con procesos reales:**
  - un solo ganador por tarea entre 9 procesos;
  - presupuesto sin sobregiro bajo concurrencia;
  - relojes desfasados sin doble lease;
  - p99 del event loop bajo 100 ms.

  `tests/INVARIANTS.md` asocia cada invariante con su prueba, su desvío o su aplazamiento.

### Cambiado

- El evento de denegación se llama `security.pathguard.denied`, como indica el contrato.
- Node 25.x y 26.0–26.7 se rechazan al abrir el almacén y en `haril doctor`. Un 24.x por debajo del rango solo avisa (desvío documentado).

### Corregido

- **CI:** `setup-node` v5 intentaba cachear pnpm antes de que corepack lo instalara.
- **Instalador:** el lanzador POSIX `bin/haril` no tenía permiso de ejecución.
- **`database is locked` al abrir el almacén mientras el runtime escribe:**
  - `busy_timeout` se aplica antes que los demás pragmas;
  - la apertura no toma un lock de escritura si no hay migraciones pendientes;
  - si aún encuentra un lock, reintenta con backoff.

### Desvíos y aplazamientos

- **CP2, CP5 y CP6** (recuperar efectos de escritura) se aplazan al hito que introduzca un agente que escriba; el único agente real es de solo lectura.
- **INV-02** (tareas en paralelo): el runtime del MVP es secuencial; la concurrencia es de M4.
- **El PDP no existe todavía:** la decisión de permisos del MVP es el guardián de rutas, en N0.

### Verificación

- CI pública en verde en Windows y ubuntu en cada PR (#6 a #11).
- Local: `pnpm run check` 0; `pnpm test` con 791 pruebas de Vitest y 48 de `node:test`; `npm run e2e` 38 pasos.

---

## 0.5.0

- **Fecha:** 2026-10-16
- **Estado:** primera pieza de M4. La interfaz de terminal `haril shell`, construida sobre pi-tui, lee el almacén sin modificarlo; las acciones pasan por la CLI.

### Añadido

- `haril shell`: interfaz interactiva (paquete `apps/shell`) con 11 paneles:
  - proyectos;
  - tareas, con sus dependencias y su detalle;
  - agentes y runtime;
  - tokens y métricas;
  - eventos;
  - modelos configurados;
  - configuración;
  - temas;
  - memoria, servicios y terminales, que aún aparecen como no disponibles.

  Teclas: `1`-`9`, `Tab`, flechas, `Enter`, `Esc`, `a`, `t`, `r`, `?` y `q`.
- Alta de tareas desde la interfaz (`a`): ejecuta `haril task add` como un proceso corto, de modo que la CLI sigue siendo el único camino de escritura.
- Temas en el formato JSON de Pi, con un cargador propio:
  - incluye `haril-dark` y `haril-light`;
  - los temas del usuario van en `config/themes/`;
  - el tema elegido se guarda en `ui.theme` de `haril.json` con una escritura atómica.
- La lectura de tareas incluye los ids de sus dependencias.

### Cambiado

- `haril.json` admite la sección `ui`; un archivo sin `providers` mantiene los proveedores por defecto.
- El instalador copia también `shell.mjs`.
- La regla de capas R1 solo permite `@earendil-works/pi-tui` en `apps/shell`.
- Sin una terminal interactiva, `haril shell` sale con el código 2 y un mensaje claro.

### Corregido

- El control de instalaciones ajenas del E2E ignora el estado que escriben las herramientas abiertas (las transcripciones de Claude Code y las bases internas y registros de Codex). La configuración y los binarios siguen contando.
- `e2e:real` mantiene los proveedores por defecto cuando `haril.json` no tiene `providers`.

### Verificación

- `pnpm run check` termina sin fallos.
- `pnpm test` pasa con 702 pruebas de Vitest y 48 de `node:test`.
- `npm run e2e` pasa sus 37 pasos, con Codex abierto.
- `shell.mjs` es un solo archivo y solo importa módulos de Node. El helper nativo opcional de pi-tui no se distribuye.
- En una terminal real (PowerShell), la interfaz muestra los datos de un proyecto de demostración y `Ctrl+C` la cierra limpiamente. Las teclas se probaron con una terminal virtual; falta la prueba manual en Windows Terminal.

---

## 0.4.1

- **Fecha:** 2026-10-16
- **Estado:** primer carril real verificado. Una tarea del agente `analyst` se ejecuta con Pi 1.2.0 real y un modelo real a través de CLIProxyAPI, pasa por el Broker y el resultado se verifica en el host.

### Añadido

- Carril real `npm run e2e:real`: una tarea `analyst` lee `README.md` con la herramienta `read` del puente, responde el código pedido, HARIL lo verifica con `output_contains` y el libro de tokens registra el consumo real.
- Broker transparente: reenvía sin alterar las herramientas (`tools`, `tool_choice`, `parallel_tool_calls`), las llamadas `tool_calls` y los resultados `tool` de la conversación. Conserva la reserva de tokens, el corte a mitad de flujo y el libro.
- Puente: la herramienta `read` incluye `label` y `details`, y los diálogos de Pi se limitan a `select`, `confirm`, `input` y `editor`.

### Cambiado

- El adaptador de Pi y el puente se alinean con el protocolo real de Pi 1.2.0: banderas de lanzamiento, comandos RPC (`get_state`, `prompt`, `abort`, `extension_ui_response`) y eventos (`message_update`, `message_end`, `agent_settled`).
- Un `prompt` que Pi no ejecuta (`handled` o `queued`) se reporta como `agent.prompt_not_run`, como indica el contrato del agente.
- Ollama deja de ser proveedor por defecto. La inferencia local es demasiado pesada para el equipo de referencia; el carril real usa CLIProxyAPI.

### Corregido

- El Broker y el adaptador solo transportaban texto. Perdían `tools` y `tool_choice` de la petición, y los `tool_calls` del modelo. Sin esta corrección el agente no podía usar herramientas a través del Broker. Se detectó con la prueba en vivo contra Pi 1.2.0.
- Los supuestos del adaptador de Pi y del puente marcados como no verificados se contrastaron con el paquete Pi 1.2.0 instalado, y se corrigieron los que no coincidían.

### Verificación

- `pnpm run check` sin fallos.
- `pnpm test`: 610 pruebas de Vitest y 44 de `node:test`, sin fallos (tras la corrección del Broker).
- `npm run e2e:real` pasó en el equipo de referencia en el primer intento completo: la tarea quedó `completed` con `verified: true`, el libro registró 1 300 tokens de entrada y 25 de salida, y hubo una lectura por el puente.
- Tras la última corrección de `agent.prompt_not_run`, las pruebas de `agent-pi` (51) pasan.

---

## 0.4.0

- **Fecha:** 2026-10-16
- **Estado:** MVP de la fase 4 cubierto en el carril hermético (sin red ni Pi real). Los criterios 9 y 10 quedan parciales. El carril real estaba pendiente y se verificó en 0.4.1.

### Añadido

- Metodologías como Methodology Blocks nativos (`odd`, `tdd` y `custom`), con frontmatter JSON validado y registro que falla cerrado. Comandos `haril methodology list` y `haril project init --methodology`.
- Instalador propio del HARIL: `haril-bootstrap install` y `uninstall`. Copia la versión a su propia carpeta, crea los lanzadores y no edita el PATH ni el registro. `uninstall` borra solo lo que creó.
- Proveedores configurables en `config/haril.json`. Las claves no se guardan en el archivo: `keyEnv` nombra la variable de entorno y una clave literal se rechaza. `haril models` consulta todos los proveedores a la vez.
- Comprobaciones de aceptación ejecutadas por el host tras el agente: `file_exists`, `file_contains` y `output_contains`. Un fallo convierte el intento en fallido.
- Registro de las denegaciones de PathGuard como eventos `tool.denied` y en las métricas, con el hash de la ruta y nunca su contenido.
- Generación de la tabla de versiones fijadas con `generate:compat`; `check:compat` forma parte de `check`.
- Instantánea de instalaciones ajenas en el E2E: comprueba que no se modifican archivos fuera de la raíz de HARIL.

### Cambiado

- `uninstall` se niega mientras haya un runtime activo.
- Una tarea sin criterios de aceptación se completa con `verified: false`. Es un desvío documentado: los checks de tipo `command` requieren un aprobador que todavía no existe.

### Corregido

- Una clave de proveedor ausente hacía fallar la tarea y gastaba un intento. Ahora la tarea queda `ready`, se reporta como pendiente de configuración y no gasta intento. Se detectó en la revisión antes de cerrar la versión.
- Pi recibía el modelo con el prefijo del proveedor. Ahora recibe solo el identificador del modelo.

### Verificación

- `pnpm run check` sin fallos.
- `pnpm test`: 591 pruebas de Vitest y 44 de `node:test`, sin fallos.
- `npm run e2e`: 37 pasos en PASS, incluidos los criterios 1, 3, 6, 8, 12 y 15 del MVP.
- Una ejecución de pruebas registró un fallo intermitente que no se reprodujo en nueve ejecuciones posteriores.

---

## 0.3.0

- **Fecha:** 2026-10-16
- **Estado:** Broker, adaptador de Pi y puente en el carril hermético. Pi 1.2.0 y el modelo real no estaban verificados en este hito.

### Añadido

- Adaptador OpenAI-compatible con parser SSE robusto, errores tipados (auth, quota, rate_limited, upstream, unreachable, upstream_stream_error) y sin la clave en los mensajes.
- Comando `haril models` y sonda del gateway en `doctor`, que no imprime la clave.
- Broker local en loopback con claves virtuales de 256 bits por run (solo su hash se guarda), revocadas al cerrar el run.
- Presupuestos de tokens por proyecto y por tarea, con reserva antes de conectar, corte duro con `insufficient_quota` y libro de solo anexado. Migraciones 0002 y 0003.
- Instalador de desarrollo del runtime (`npm run runtime:install`): Node 24.22.0 aislado con verificación SHA-256 y Pi 1.2.0 instalado con `--ignore-scripts`.
- Adaptador de Pi por RPC: lanzamiento con banderas fail-closed, lector JSONL por LF, `get_state`, `prompt`, `agent_settled`, `abort` y terminación del árbol de procesos.
- Puente como extensión autocontenida: `hello` con token por tubería, registro del proveedor `haril` y herramienta `read` que pasa por el PathGuard del Runtime.
- Agente `analyst`: `task add --agent analyst --model <id> --max-tokens <n>` y `haril task show <id>`, con texto y tokens. `metrics` muestra el consumo por agente y modelo.

### Cambiado

- `start` comprueba los requisitos antes de reclamar la tarea. Si falta el runtime o la clave, la tarea sale como `skipped` sin gastar intento.
- `npm run e2e:real` se salta con un motivo explícito cuando falta el runtime.

### Corregido

- El Broker no devolvía el iterador del upstream y un temporizador de 120 s mantenía vivo el proceso.
- El plazo del prompt se calculaba después de que el agente se asentara.
- La sonda del gateway en `doctor` fallaba bajo carga en el arranque en frío. El plazo de la sonda ahora es inyectable en las pruebas.

### Verificación

- 441 pruebas de Vitest y 29 de `node:test`, sin fallos.
- E2E hermético de M1 y M2: el Pi simulado detrás del Broker y un servidor OpenAI falso.
- `npm run e2e:real` se saltó con el motivo esperado, porque el runtime no estaba instalado en el momento del cierre.

---

## 0.2.0

- **Fecha:** 2026-10-16
- **Estado:** runtime, proyectos, tareas y planes sin Pi ni proveedores, con un agente simulado. El estado persiste en SQLite y sobrevive a un `kill -9`.

### Añadido

- Almacén SQLite con `node:sqlite`, migración inicial en modo STRICT, eventos inmutables y suite de contrato del Store.
- Puertos `Store` y `AgentRuntime`, agente simulado `FakeAgentRuntime` con comportamiento elegido por la referencia de la tarea (`fake:succeed`, `fake:fail`, `fake:slow:<ms>`).
- `haril project init` (con vista previa y `--yes`) y `haril project list`.
- `haril task add`, `haril plan import` y `haril status`, que encolan comandos. `haril start` los aplica.
- `haril start` en primer plano con lease singleton y épocas, desbloqueo de dependencias, claim atómico, reintentos hasta `max-attempts` y salida por ocio.
- Reconciliador al arrancar: una tarea que quedó `running` tras una caída vuelve a `ready` como `orphaned` y no cobra intento.
- `haril metrics` y `haril events`, derivados de `events` y `runs`.
- Lanzadores `bin/haril.cmd`, `bin/haril.ps1` y `bin/haril`, que no editan el PATH.
- E2E del flujo completo en directorios temporales, con una caída real a mitad de run.

### Cambiado

- `haril doctor` sale con 0 (correcto), 1 (advertencias) o 2 (errores). Un Node fuera del rango `^24.21.0` se registra como advertencia en M1.
- Un `agentRef` que no es `fake:*` (por ejemplo `developer-block`) se ejecuta como simulado con éxito y la salida lo indica.
- Reimportar un plan idéntico responde "already queued" y no duplica el plan.
- Las dependencias bloqueadas por una tarea fallida se propagan de forma transitiva, para que ninguna tarea quede pendiente para siempre.

### Corregido

- Tras una recuperación, la línea de claim mostraba `attempt 2/1`. Ahora muestra los intentos usados más uno.

### Verificación

- 267 pruebas de Vitest y 29 de `node:test`, sin fallos.
- `npm run e2e`: 21 pasos en PASS, incluido "crash: start recovers and completes the task", con `taskkill` a mitad de run.
- `bin\haril.cmd --version` imprime la versión.

---

## 0.1.0

- **Fecha:** 2026-10-15 a 2026-10-16
- **Estado:** monorepo ejecutable con herramientas, esqueleto de diez workspaces, contratos del dominio y controles de capas. La lógica del Core (DAG, scheduler, Router) queda fuera de esta versión.

### Añadido

- Monorepo pnpm con TypeScript (`tsc --noEmit`), Vitest, Biome y knip, y scripts `check` y `test`.
- Esqueleto de diez workspaces, cada uno con su `package.json`, `tsconfig.json` y punto de entrada.
- Contratos TypeBox de `Task`, `Plan` y `Session`, y la máquina de estados de la tarea con sus transiciones.
- Controles `check-layers`, `check-purity` y `check-forbidden`, con un corpus de violaciones sembradas y pruebas con `node:test`.
- CLI mínima `haril` con `--version`, `help`, `doctor [--json]`, `states` y `plan validate <archivo> [--json]`, y ejemplos de plan válido y con ciclo.
- Pipeline de CI en Windows y Ubuntu.
- Documentación de fundamentos y de diseño inicial, que se publicará al final del proyecto.

### Verificación

- `pnpm install --frozen-lockfile`, `pnpm run check` y `pnpm test` sin fallos: 90 pruebas de Vitest y 29 de `node:test`.
- `npm run smoke` sin fallos. Un plan con ciclo sale con 1 y un comando desconocido con 2.
- El CI remoto no se ejecutó: en ese momento el repositorio no tenía remoto.
