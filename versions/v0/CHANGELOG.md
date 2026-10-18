# Changelog de HARIL, versión mayor 0

Las versiones van de la más reciente a la más antigua. Cada entrada indica la versión, la fecha, el estado y los cambios agrupados en Añadido, Cambiado y Corregido, y cómo se verificó.

---

## 0.16.0

- **Fecha:** 2026-10-18
- **Estado:** **Los cuatro modos de la consola, el botón `■ STOP ALL`, la tarjeta `/delegate` y el registro del chat.** La consola tiene acción, consulta de solo lectura, plan y delegación, siempre a la vista en la barra; consulta no puede cambiar nada, muestra qué hizo y cómo y guarda una investigación en Markdown si se la pides; delegación arranca un workflow con agentes reales desde una tarjeta que confirmas; `■ STOP ALL` corta el turno del chat y para a todos los agentes sin pedir confirmación; cada orden y cada respuesta del modelo en la consola quedan en el registro de consumo (fase F4 de la delegación, ADR-0021). Probado con pruebas automáticas y con la extensión compilada en una sesión real de Pi 1.2.0; todavía no en una terminal real.

### Añadido

- **Cuatro modos en la consola:** `ACTION` (Pi como siempre), `CONSULT`, `PLAN` y `DELEGATION`. La barra muestra `MODE: <modo>` y un clic abre el selector; `/mode <modo>` (también los nombres en español y una letra) y `Alt+M`, que pasa al siguiente. El modo queda en la sesión (`appendEntry` de tipo `haril-mode`) y vuelve al reanudarla; al salir de un modo de solo lectura vuelven las herramientas que había antes.
- **Consulta con defensa en profundidad:** `setActiveTools` deja `read`, `grep`, `find`, `ls` y `haril_save_research` (ni `bash`, ni `powershell`, ni `edit`, ni `write`); una guardia `tool_call` con denegación por defecto bloquea cualquier otra herramienta, de Pi, de otra extensión o de MCP, aunque alguien la reactive (si la guardia falla, Pi bloquea); `before_agent_start` declara el modo al modelo en cada turno; los comandos `!` del usuario no se ejecutan; `/init`, `/goal`, `/approve`, `/deny`, `/delegate` y `/continue` se rechazan antes de llamar a la CLI, y las acciones de la consola que cambian estado (registrar la carpeta, revisar aprobaciones, encolar un objetivo, ejecutar o iniciar el runtime, alternar herramientas) se rechazan y desaparecen del menú `/haril`. Las paradas siguen disponibles. `PLAN` usa la misma guardia, y `DELEGATION` también, sin la herramienta de investigación.
- **`haril_save_research`:** la única escritura de consulta y plan, inactiva en los demás modos y rechazada fuera de ellos. El modelo da un título y el contenido en Markdown, nunca una ruta: el archivo va a `docs/investigacion/<fecha>-<título>.md` del proyecto (o de la carpeta), solo `.md`, nunca sobrescribe (añade `-2`, `-3`… y escribe con `wx`), admite hasta 200 KB y rechaza un título con `/`, `\`, `..`, una unidad o caracteres de control, y una carpeta que por un enlace salga del proyecto.
- **Traza de la consulta:** tras cada turno en consulta queda en el chat (una entrada de sesión que el modelo no ve) cada herramienta, sobre qué actuó y su resultado en corto (`ok · 120 lines`, `blocked · …`, el error), las bloqueadas, las herramientas usadas y cuántas veces, los archivos leídos, las búsquedas, los tokens, el tiempo y la ruta de la investigación guardada. Nunca copia lo que se leyó o se quiso escribir.
- **Plan:** el modelo arma un plan con la conversación; el plan queda como entrada de sesión (`haril-plan`) y `/goal` sin texto se lo pasa al `planner` con la aprobación de siempre.
- **Tarjeta `/delegate`:** objetivo, modelo del orquestador (el de HARIL elegido; `M` elige otro), autonomía y paradas de esta ejecución, límites y cuota tal como están («not available yet»). Las paradas salen de las palabras del usuario con el vocabulario cerrado y unas frases en inglés y en español, sin pasar por un modelo; sin nada dicho, `after_plan`. Se marcan con `Espacio` o con un clic, `A` alterna autónomo, `Enter` arranca y `Esc` cancela. Al confirmar ejecuta `haril workflow start --goal … --model … --agent orchestrator` con `--stop-at` o `--autonomous`, arranca el runtime si no hay uno y abre `ORCHESTRATION`. Sin objetivo, `/delegate` toma el último mensaje de la conversación. En `DELEGATION`, lo que se escribe abre la tarjeta en vez de ir al modelo, y mientras un workflow del proyecto corre o espera se rechaza con una pista (P5).
- **`/continue [id] [parada…]`:** libera la parada en que espera un workflow (`haril workflow continue`) y quita las paradas que se nombren; sin id, el único que espera o un selector.
- **Botón `■ STOP ALL`** al final de la barra, en todos los modos, que nunca cede su sitio, y `Alt+X`. Sin confirmación: corta el turno del chat (`ctx.abort()`) y después ejecuta `haril stop --now --json`, y dice lo que informa la CLI: tareas canceladas y workflows detenidos, un runtime que no contestó a tiempo, procesos que siguen vivos o una orden que falló. La consola no mata procesos: lo hace la CLI.
- **Registro del chat:** cada mensaje y cada comando de HARIL escritos en la consola son una orden (con el modo en que estaba), y cada respuesta del modelo una fila de consumo con proveedor, modelo pedido y servido, tokens (nulos si no se reportan), duración y resultado, unida a su orden. Van de una en una por `haril usage record --stdin`; si una falla se reintenta una vez y después cuenta en la barra (`log ✗ n`) y en los detalles de `EVERYWHERE`, sin frenar el chat.
- **`haril usage record --stdin [--project <slug>] [--json]`:** añade una orden o una fila de consumo del chat leída como JSON de la entrada estándar, nunca de la línea de comandos. Comprueba cada campo (campos cerrados, vocabularios del registro, tokens enteros o nulos, identificadores ASCII sin espacios que la censura deja intactos) y la orden guarda su hash, su longitud y una vista previa censurada de 200 caracteres. Escribe sin arrendamiento del runtime (P14).
- `pi-types.ts` declara lo que usa la consola de Pi 1.2.0: `tool_call` con bloqueo, `before_agent_start`, `input`, `user_bash`, `registerTool`, `registerEntryRenderer`, `appendEntry`, `abort`, `isIdle`, la rama y el id de la sesión.

### Cambiado

- El «■ Stop all» de `ORCHESTRATION` fuera de la demostración es ahora la parada de emergencia, sin confirmar, en lugar de la parada ordenada y confirmada del runtime compartido; la demostración sigue simulándola. «Stop shared runtime» de `AUTOMATION` no cambia.
- La barra muestra el modo a la izquierda y el botón a la derecha; la nota del registro es lo primero que cede en una terminal estrecha.
- La consola puede pasar texto por la entrada estándar de la CLI (`runHaril` con `input`).

### Corregido

- Nada respecto a 0.15.0.

### Valores provisionales

Tomados de la propuesta de la especificación (sección 10.3) o decididos para esta fase:

- P1: sin paradas dichas, la tarjeta sale con `after_plan`.
- P5: el texto escrito en delegación mientras un workflow corre o espera se rechaza con una pista.
- P14: `haril usage record` escribe sin runtime vivo, la única escritura fuera del runtime.
- P15: la orden guarda una vista previa de 200 caracteres con censura básica, nunca el texto.
- P18: las investigaciones van a `docs/investigacion/`, todavía sin opción para cambiarla (llega con la configuración de F7).
- P20: «Parar todo» sin confirmación, con `Alt+X`; `Alt+M` cambia de modo. Los dos están libres en las teclas de Pi 1.2.0, también en Windows.
- P22: los textos de la interfaz en inglés (`ACTION`, `CONSULT`, `PLAN`, `DELEGATION`).
- La tarjeta lee las paradas con un analizador determinista del vocabulario cerrado y unas frases, en lugar del modelo del chat que propone la sección 3.13: la decisión de autonomía no queda en manos de algo que interpreta una frase, y la tarjeta sigue siendo la única confirmación.
- En delegación el chat también es de solo lectura (sin la herramienta de investigación): el trabajo lo hacen los agentes del workflow.
- Plan no rechaza comandos: `/goal` es la forma de pasar su plan al `planner`.
- Una respuesta sin ningún token reportado se registra con tokens nulos; el coste solo si Pi lo da mayor que cero.

### Aplazado

- F5b: datos reales en la vista `ORCHESTRATION`. F6: cuota (la tarjeta dice «not available yet»). F7: la sección de delegación en `TOOLS`, la carpeta de investigaciones configurable y los modelos por capa. F8: herramientas de escritura.
- Los comandos propios de Pi (`/model`, `/login`…) no pasan por las extensiones y no dejan orden; los de HARIL sí.
- La traza vive en la sesión; el registro de consumo guarda los tokens, la duración y el resultado de cada respuesta, no la traza.
- `/delegate` y `DELEGATION` dejan su orden de chat y `haril workflow start` la suya (`source cli`): son dos filas, lo que se escribió y lo que se ejecutó.

### Verificación

- `corepack pnpm run check`: salida 0 (Biome, tipos, capas, pureza, knip, compatibilidad y `check-version`).
- `corepack pnpm test`: salida 0; Vitest 2201 pasan y 1 omitida, las 3 pruebas de parada con procesos reales en su paso propio, `node:test` 122 de 122. Una primera pasada falló en `memory-engram/tests/serve.test.ts` (`engram serve` no estuvo listo en 5 s con toda la suite en paralelo); sola pasó 15 de 15 y la segunda pasada completa salió 0.
- `npm run build`: salida 0; `haril --version` muestra 0.16.0.
- Prueba funcional con la extensión compilada dentro de una sesión real de Pi 1.2.0 (su SDK), la CLI real compilada sobre una raíz de datos temporal y un gateway falso compatible con OpenAI que responde con llamadas a herramientas: 19 de 19. En consulta, `write` no existe para el modelo y, reactivado, la guardia lo bloquea («CONSULT mode is read-only…»); `bash` tampoco corre; `read` funciona; la investigación queda en `docs/investigacion/2026-10-18-claims-study.md`; la traza marca la escritura como bloqueada y nombra el archivo; 8 órdenes y 10 filas de consumo con modelo, tokens y duración, unidas a sus órdenes, y `usage verify` pasa; con un runtime corriendo una tarea lenta, `Alt+X` cortó el turno del chat en 29 ms y la CLI informó «runtime stopped: 1 task cancelled… no agent process left alive», el runtime salió con 0 y la tarea quedó cancelada; `/delegate … stop at the end` encoló `workflow.start` con `agent: orchestrator`, el modelo y la parada `at_end`.
- Un turno real por CLIProxyAPI (`Gemini1/gemini-3-flash`, en acción): respondió; la orden quedó con 30 caracteres y su vista previa, y la fila de consumo con el modelo pedido y el servido, 1416 tokens de entrada y 23 de salida, 1909 ms, resultado `stop` y unida a la orden; `usage verify` pasó. La comprobación de la longitud de la orden en el arnés esperaba 31 por un error del arnés, no de la fila.
- Pruebas nuevas, con ROJO observado y después VERDE: `haril usage record` (validación, censura, idempotencia, proyecto, cadena verificable), las reglas de los modos y la guardia, `haril_save_research`, la traza, `■ STOP ALL`, la tarjeta `/delegate` y el registro del chat. Escritas junto al código, sin ROJO previo: el controlador de modos sobre un `ConsolePi` falso, los comandos y las acciones en consulta, la consola con el botón y `Alt+X`, la tarjeta en la consola y `/continue`, y el registro del chat en la consola (con una CLI falsa). La prueba funcional encontró dos fallos que pasaban las pruebas automáticas y quedaron corregidos con sus pruebas: Pi rechaza una herramienta inactiva antes de cualquier guardia, así que la traza no veía esa llamada, y algunos gateways repiten el id de respuesta, así que las filas de consumo chocaban en su clave de idempotencia.

---

## 0.15.0

- **Fecha:** 2026-10-18
- **Estado:** **Parada de emergencia, barrido de procesos huérfanos y vigilante de 15 minutos.** `haril stop --now` para todos los agentes de todos los modos y no deja ningún proceso vivo: en una parada real con tres agentes de Pi en marcha, todos murieron 0,4 s después de la orden. `haril resume` saca al runtime del estado detenido, `haril workflow stop <id>` para un solo workflow, el arranque mata los procesos que dejó un runtime caído y un vigilante de código revisa cada 15 minutos cada agente vivo (fase F3 de la delegación, ADR-0021).

### Añadido

- **Parada de emergencia `haril stop --now`** (`--json` da el informe): encola `runtime.stop {mode: "now"}`. El almacén la aplica en una transacción: deja el runtime detenido (clave `runtime.halted` en `meta`), detiene cada workflow en marcha o en espera con motivo `user_stop`, cancela todos sus turnos sin terminar y las tareas sueltas en curso, y de cada run cancelado revoca las llaves virtuales y liquida las reservas abiertas a su cota superior. Las tareas sueltas que esperaban siguen esperando. El runtime mata entonces el árbol de procesos de cada intento sin el plazo de gracia, cierra los turnos cancelados (cada uno deja su fila de consumo `cancelled_user_stop`) y sale. La orden espera a que salga, comprueba por su cuenta que ningún proceso que registró un intento siga vivo y mata los que queden, solo si siguen siendo el proceso registrado. Sin runtime vivo, la parada queda en la cola y el siguiente runtime la aplica antes de reclamar nada. Repetirla no hace daño.
- **Estado `halted` y `haril resume`:** mientras está detenido, el almacén no deja reclamar ninguna tarea y el runtime lo dice (`halted by an emergency stop`); `haril status` muestra `halted yes since ...` y `--json` trae `halted`. `haril resume` encola `runtime.resume`, que lo levanta; lo cancelado sigue cancelado y los workflows detenidos siguen detenidos.
- **`haril workflow stop <id>`:** encola `workflow.stop`; el workflow queda `stopped` (`user_stop`), sus turnos se cancelan y solo mueren sus agentes; el runtime y los demás workflows siguen.
- **Pid y hora de inicio de cada intento:** el adaptador de Pi informa el proceso que sirve el run (pid y la hora tomada justo después de crearlo) y el runtime los guarda en `runs.pid` y `runs.pid_started_at` (columnas que existen desde `0001`). `kill()` del adaptador mata el árbol al instante, sin pedir `abort` ni esperar los 5 s de gracia.
- **Barrido de arranque:** antes de recuperar las tareas huérfanas, el runtime mata los procesos que registraron los runs abiertos de un runtime caído, solo si el pid sigue vivo y su hora de inicio, según el sistema, coincide con la registrada (±2 s); un pid reutilizado se deja en paz. Cada caso queda como evento `run.process_killed` o `run.process_kept`, y la salida dice `startup sweep: killed N agent processes`.
- **Control de procesos sin dependencias** (`@haril/os`, puerto `ProcessControl`): la hora de inicio de varios pids en una sola llamada a `Get-Process` en Windows, `/proc` en Linux y `ps` en macOS, y la muerte de un árbol con `taskkill /F /T` en Windows o del grupo de procesos en POSIX. La regla de qué se puede matar es una función pura del Core (`planProcessKills`).
- **Vigilante de 15 minutos en el runtime:** el delegador pregunta por sus ejecutores y auditores, el orquestador por sus delegadores y el workflow por su orquestador, con datos objetivos: tokens de las llamadas del run asentadas en la ventana, una llamada al modelo abierta y su última herramienta (`runs.activity`). Inactivo: se mata su proceso y cuenta como intento fallido (`watchdog.idle`, fila `closed_idle`), así que las reglas de reproceso deciden qué sigue. Activo: sigue y se revisa 15 minutos después (`tasks.next_check_at`, programado desde que se reclama y conservado tras un reinicio). Un turno que espera a sus hijos o capacidad sigue siempre. Residual: los turnos que deja un workflow terminado se cancelan en cada vuelta del bucle, y los de un hilo cuyo consumidor ya no tiene turnos vivos, en su revisión. Cada veredicto es un evento `watchdog.checked` o `watchdog.closed` cuyo texto empieza por el id del nodo, y la salida de `haril start` lo muestra (`watchdog: e1 active, continues: tool_call`).
- **Comprobación real `npm run e2e:stop-real`** (`scripts/e2e-stop-real.mjs`): un workflow real de lectura en segundo plano con `cliproxy/gemini-3-flash`, `haril stop --now` mientras sus agentes trabajan y la prueba con los pids del almacén y con la lista de procesos del sistema de que no queda ninguno. Sale con `SKIP` sin el runtime o la clave y con `PARTIAL` si el gateway no responde.
- La línea `done:` de `haril run` y `haril start` cuenta las tareas canceladas (`, N cancelled`) y los workflows detenidos (`, N stopped`), que no son fallos; `--json` los trae en `cancelled` y `workflows.stopped`.

### Cambiado

- Un workflow que falla por su tiempo máximo (`wall_time`) ya no deja sus intentos en curso hasta que terminen: son residuales y se matan y cancelan al instante. Es el respaldo de una espera de capacidad que nunca se libera.
- `WorkflowSnapshot v1` muestra como texto de un evento la línea que trae (`text`), así que la vista del workflow lee los veredictos del vigilante por el id del nodo; los demás eventos siguen listando sus campos. El contrato no cambia.
- `npm test` corre las pruebas de parada con procesos reales en un paso propio (`npm run test:stop`): solos, los agentes mueren unos 0,6 s después de la orden, pero con todos los demás archivos de prueba en paralelo la carga de CPU estira el `taskkill` del sistema más allá de los 2 s que mide la prueba.

### Corregido

- **Segunda señal:** el segundo Ctrl+C o SIGTERM ya no sale dejando a los agentes huérfanos: mata primero el árbol de procesos de cada intento en curso y sale con 130 cuando murieron (o tras 3 s); sin agentes en curso sale al instante, y una tercera señal también.

### Valores provisionales

Tomados de la propuesta de la especificación (sección 10.3) o decididos para esta fase:

- P16: vigilante cada 15 minutos y una sola revisión sin progreso para cerrar; sin consultar a un modelo. La cadencia es una opción del runtime (`watchdog.intervalMs`); el ajuste por `haril.json` llega en F7.
- P20: «Parar todo» sin ventana de confirmación; el atajo y el botón llegan con la consola (F4).
- Los workflows detenidos quedan `stopped` con motivo `user_stop`, como dice la especificación (3.14.2); `halted` es el estado del runtime, no un estado nuevo de workflow, que exigiría un ADR y cambiaría `WorkflowSnapshot v1`.
- `haril stop --now` sale del runtime tras la parada (sin la opción `--exit` de la sección 6) y `haril workflow stop` para siempre al instante (sin `--now`).
- Hora de inicio con ±2 s de tolerancia frente a la que tomó el runtime al crear el proceso.
- La orden espera hasta 5 s a que el runtime aplique la parada y salga antes de matar ella misma los procesos registrados.
- Un intento de un workflow en espera del humano se juzga por su propio progreso; solo los turnos que esperan reciben el veredicto `waiting_human`.

### Aplazado

- F4: botón `■ PARAR TODO` y su atajo en la consola, y matar el árbol desde la consola si el runtime no responde.
- F6: enfriamiento por cuota (`cooling_down`) y reintentos por 402 y 429.
- F8: archivos modificados en el worktree como señal de progreso.
- Un nieto cuyo padre (Pi) ya murió no se encuentra desde el pid registrado en el barrido de arranque: `taskkill /T` necesita la raíz viva. Los agentes de solo lectura no arrancan procesos propios.

### Verificación

- `corepack pnpm run check`: salida 0 (Biome, tipos, capas, pureza, knip, compatibilidad y `check-version`).
- `corepack pnpm test`: salida 0; Vitest 2087 pasan y 1 omitida, las 3 pruebas de parada con procesos reales en su paso propio, `node:test` 122 de 122.
- `npm run build`: salida 0; `haril --version` muestra 0.15.0.
- `node scripts/e2e-stop-real.mjs` (una ejecución, `cliproxy/gemini-3-flash`): PASS. Tres agentes de Pi en marcha (un delegador y dos ejecutores); `haril stop --now` volvió en 890 ms y los tres procesos murieron 394 ms después de la orden; ninguno de los cinco pids que registraron los runs sigue vivo y ningún proceso del sistema nombra la carpeta temporal; el workflow quedó `stopped` (`user_stop`) con 7 turnos cancelados y 2 completados, el runtime detenido, sin reservas abiertas; la segunda parada no hizo nada y `usage verify` pasó.
- Pruebas nuevas, con ROJO observado y después VERDE: la parada de emergencia, `workflow.stop`, `runtime.resume`, `tasks.cancel`, `runs.cancel` con `user_stop`, el registro de procesos y la actividad de un run en el almacén; la regla de qué proceso se puede matar; el pid y el `kill()` inmediato del adaptador de Pi; la parada con procesos reales (el Pi falso y su comando en un nieto: ninguno vivo en menos de 2 s, tareas canceladas, workflows detenidos, presupuesto liquidado, segunda parada inocua, `resume`), `workflow stop` de un solo workflow, la segunda señal que mata a los hijos antes de salir, el barrido de arranque tras una salida brusca con un pid reutilizado que no se mata, y el vigilante con tiempo virtual (cierre de lo inactivo, revisión a los 15 minutos de lo activo, esperas de capacidad que no se cierran, respaldo por tiempo máximo y residuales). Escritas junto al código, sin ROJO previo: el adaptador de `@haril/os` (con procesos reales), el interruptor de la segunda señal y una pasada del vigilante sobre el almacén.

---

## 0.14.0

- **Fecha:** 2026-10-18
- **Estado:** **Agentes reales en la delegación en tres capas, de solo lectura.** `haril workflow start <objetivo> --agent orchestrator --autonomous` corre un workflow con agentes reales de Pi (orquestador, delegadores, ejecutores, sus auditores y el auditor final) a través del Broker y un modelo de CLIProxyAPI, de principio a fin y sin intervención. Ningún agente escribe ni ejecuta comandos todavía. Probado con `cliproxy/gemini-3-flash` en el carril real nuevo (fase F2b de la delegación, ADR-0021).

### Añadido

- **Herramientas del puente para los agentes reales** (`integrations/agent-pi-bridge`): el puente registra `haril_delegate`, `haril_assign`, `haril_report`, `haril_verdict`, `haril_request_audit` y `haril_abort` cuando el run los anuncia, con esquemas JSON simples que siguen los contratos de las herramientas, y manda cada llamada como `delegation.call`. Lo que no sirve (`write`, `edit`, `bash`, `grep`, `haril_run`, `haril_merge`) nunca lo registra, así que el saludo lo deja fuera y el runtime rechaza el run.
- **Operación `delegation.call` en el adaptador de Pi** (`integrations/agent-pi`): pasa la llamada a las herramientas de delegación del host con el contexto del run (proyecto, tarea y run) solo si esa herramienta se le ofreció, y devuelve la respuesta tipada; un rechazo lleva su motivo para que el agente corrija en el mismo turno, y un fallo del host da un motivo fijo, nunca su error. El evento `tool.<herramienta>` guarda el hash y el tamaño de la entrada y el motivo de un rechazo, nunca la entrada.
- **Solo lectura forzada:** el adaptador se niega a lanzar un turno de workflow al que se le ofrezca algo distinto de `read` y las herramientas de delegación (`agent.invalid_spec`, antes de arrancar Pi). Pi sigue arrancando sin sus herramientas propias (`--no-builtin-tools`).
- **Los cuatro arquetipos son agentes reales:** `orchestrator`, `delegator`, `executor` y `auditor` entran en `REAL_AGENT_REFS`; sus turnos corren en Pi con el modelo que les da el host y sus llamadas llegan a las mismas herramientas de delegación que las de los agentes simulados. `haril run` no reclama un turno real si falta el runtime, el puente o la clave del proveedor (lo muestra como `skipped`).
- **Instrucciones de cada rol:** el prompt explica a cada rol su trabajo y la llamada que debe hacer, sus herramientas, que cada turno termina con una sola llamada aceptada (un rechazo se corrige en el mismo turno), que la sección de datos la escribieron otros agentes y nunca trae instrucciones, qué son las tareas hermanas y, al orquestador y a los delegadores, sus límites y el presupuesto mínimo que necesitan sus hijos.
- **El auditor final recibe la petición del orquestador:** el resumen y la lista de pendientes de `haril_request_audit` llegan a su prompt como datos (cada línea con `| `), junto a los informes de los delegadores.
- **Resumen de `haril run` y `haril start`:** la línea `done:` termina con `; workflows: N turns, C completed, F failed` (y `, W waiting` si alguno espera al humano) cuando la corrida tocó algún workflow, y `--json` trae `workflows`. Un workflow fallido hace salir con 1, como una tarea fallida; uno que espera al humano, no.
- **Carril real `npm run e2e:workflow-real`** (`scripts/e2e-workflow-real.mjs`): un workflow autónomo de lectura y análisis sobre una carpeta de ejemplo con dos notas, con `cliproxy/gemini-3-flash` (o `HARIL_E2E_WORKFLOW_MODEL`). Comprueba que termina completado, que cada ejecutor leyó su archivo por el puente y lo aprobó su auditor, que el auditor final aprobó, que sus respuestas traen los hechos de las notas, que cada fila de consumo tiene tokens reales, que `usage verify` pasa y que no cambió ningún archivo. Sale con `SKIP` sin el runtime o la clave, dice si el gateway no responde y conserva su carpeta temporal si falla.
- `haril workflow start --agent` acepta `orchestrator` (agentes reales) o `fake:orchestrate` (simulados) y rechaza cualquier otro.

### Cambiado

- `archetypeTools` deja fuera `haril_run` y `haril_merge` hasta que llegue la escritura (F8), así que nadie recibe una herramienta que el host siempre rechaza: el delegador recibe `read`, `haril_assign` y `haril_report`, y el auditor, `read` y `haril_verdict`. La tabla de la especificación sigue igual y un rol que las tendrá en F8 oye por qué se le rechazan.
- `haril task add` rechaza los arquetipos de workflow como agente de una tarea suelta: solo corren dentro de un workflow.
- `haril run` sale con 1 cuando falla un workflow.

### Corregido

- **Tokens por intento:** la fila `agent_run` de un turno real tomaba los tokens del libro del Broker sumados por tarea, así que un turno repetido tras una recuperación contaba otra vez los del run huérfano. Ahora cuenta solo los de su propio run (`budgets.usageSummary({ runId })`, prueba con una recuperación simulada).
- **Migración `0008`:** se quita la excepción `previousChecksums`, que aceptaba la suma de comprobación del primer texto de `0008`. La 0.12.0 no se publicó ni se instaló en ningún sitio, así que ninguna base guardó esa suma, y `0008` conserva su texto actual (con `ORDER BY rowid`). Una base con otra suma de `0008` se rechaza como cualquier migración cambiada. Regla desde ahora: una migración aplicada no se edita nunca.

### Valores provisionales

Tomados de la propuesta de la especificación (sección 10.3) o decididos para esta fase:

- P1, P2, P3 y L1 como en la 0.13.0 (`after_plan` por defecto, 30 000 tokens para el auditor final, 1 relanzamiento y 1 escalada, los auditores no cuentan como hijos vivos).
- P6, hasta el catálogo de F6: cada hijo corre con el modelo del orquestador, también el auditor aunque sea el modelo de su ejecutor (la regla de auditor distinto lo permite cuando no hay otro).
- `--agent` sigue valiendo `fake:orchestrate` por defecto, como `fake:succeed` en `haril task add`; los agentes reales se piden con `--agent orchestrator`.
- Presupuestos mínimos que el prompt pide: 60 000 tokens por delegador y 45 000 por ejecutor (su auditor recibe un tercio). Son una guía para el modelo, no una regla del Core.
- La única herramienta de lectura es `read` (rutas relativas a la raíz del proyecto); el puente no ofrece `grep`, `find` ni `ls`.
- Los esquemas que ve el modelo dejan fuera los campos opcionales que aún no se usan (el modelo de un hijo y las paradas); el runtime valida cada llamada contra los contratos completos.
- Un workflow que el humano detenga (F3) no contará como fallido en el resumen.

### Aplazado

- F3: parada inmediata, estado `halted`, barrido de pids y el vigilante de 15 minutos.
- F6: catálogo de modelos, cuota y dificultad: hoy todos los agentes de un workflow usan el modelo del orquestador.
- F7: contexto y salida reales del modelo en Pi (siguen 32 768 y 4 096) y modelos por capa.
- F8: escritura, `haril_run`, `haril_merge`, worktrees e integración.
- Herramientas de solo lectura para listar o buscar archivos por el puente.

### Verificación

- `corepack pnpm run check`: salida 0 (Biome, tipos, capas, pureza, knip, compatibilidad y `check-version`).
- `corepack pnpm test`: salida 0; Vitest 2063 pasan y 1 omitida, `node:test` 122 de 122.
- `npm run build`: salida 0; `haril --version` muestra 0.14.0.
- Pruebas nuevas, con ROJO observado y después VERDE: la lista de herramientas por rol del puente, que nunca registra herramientas de escritura, cada herramienta llegando al host con su respuesta tipada, el adaptador sirviendo `delegation.call` y negándose a lanzar un turno con `write`, `edit`, `bash`, `haril_run`, `haril_merge` o `grep`, los tokens por run tras una recuperación simulada, la entrada del auditor final con el resumen, el resumen y el código de salida de `haril run`, y la retirada de `previousChecksums`.
- Prueba hermética del carril real (`apps/haril/tests/workflow-real-agents.test.ts`): `haril workflow start --agent orchestrator` y `haril run` con el Broker real, el adaptador de Pi real y un Pi falso que juega cada rol: 9 turnos completados, lecturas por el puente, el auditor final oyó la petición, 9 filas con los tokens de su propio run y `usage verify` correcto.
- Carril real `npm run e2e:workflow-real` con Pi 1.2.0 y CLIProxyAPI (`cliproxy/gemini-3-flash`), dos ejecuciones, las dos completadas sin intervención: 1 orquestador, 1 delegador, 2 ejecutores aprobados por sus auditores y el auditor final aprobado («3 of 3 criteria met»); 9 filas `agent_run` con tokens reales (primera: 42 496 de entrada y 1 352 de salida, 39 s; segunda: 38 071 y 1 411, 1 min 44 s); en la segunda, 6 lecturas por el puente, 7 llamadas de delegación aceptadas y ninguna rechazada, y las respuestas de los ejecutores citan los hechos de las notas; `usage verify` correcto y ningún archivo de la carpeta cambió.

---

## 0.13.0

- **Fecha:** 2026-10-18
- **Estado:** **El runtime de la delegación en tres capas, con agentes simulados.** `haril workflow start` encola un workflow y el runtime lo corre: varios agentes a la vez sin pasar ningún límite, el orquestador delega, cada delegador asigna pasos, cada ejecutor tiene su auditor, los rechazos se relanzan y escalan como mucho una vez cada uno, quien delegó vuelve con los resultados de sus hijos sin gastar nada mientras espera, y un auditor final cierra el workflow. Tras una caída, el runtime sigue sin repetir trabajo. Los agentes son los simulados (`fake:*`); las herramientas del puente para los agentes reales de Pi llegan en F2b (fase F2a de la delegación, ADR-0021).

### Añadido

- **Bucle concurrente** (`apps/haril/src/runtime/run-loop.ts`): un registro de intentos vivos; el bucle se despierta cuando uno termina, en cada sondeo o con un aviso, y cierra cada intento en la vuelta siguiente. Las tareas sueltas siguen en su carril de una en una, como antes. Los turnos de los workflows en marcha arrancan según `selectClaims` con los límites del workflow (por rol, hijos vivos por hilo, total de agentes, escritores y cerrojos de superficie), cada uno reclamado por separado y de forma atómica bajo la época del arrendamiento. Los límites salen de la instantánea del workflow y, para lo que no trae, de la opción `delegation` del runtime (la sección `delegation` de `haril.json` llega en F7).
- **Canal agente ↔ host** (puerto `DelegationToolHandler` y entrada `DelegationTurnInput` en `@haril/core/ports`): un turno de workflow llama a `haril_delegate`, `haril_assign`, `haril_report`, `haril_verdict`, `haril_request_audit` y `haril_abort`; el host comprueba que la herramienta sea de su arquetipo, la entrada contra los contratos y la propuesta con `checkDelegation`, y responde `{ok: true, ...}` o `{ok: false, reason}` para que el agente corrija en el mismo turno. Un turno decide una sola vez: la misma llamada repetida da la misma respuesta y otra distinta se rechaza. Los agentes simulados usan este puerto ahora; el puente de Pi lo usará en F2b.
- **Cierre de un turno en una transacción** (`Store.transaction`): la llamada aceptada se aplica cuando el turno termina, junto con el cierre de su run y su fila de consumo; una caída en medio no deja nada a medias y el turno se repite.
- **Continuaciones:** al delegar o asignar, el runtime crea la continuación del que propone, con dependencias `settled` de sus hijos; corre aunque un hijo falle y recibe su memo, los resultados, los informes y los veredictos de sus hijos como datos.
- **Auditoría y reproceso:** cada ejecutor tiene su auditor; su veredicto alimenta la máquina de reproceso (1 relanzamiento, 1 escalada). El estado del reproceso se deriva del almacén (`replayRework`), nunca solo de la memoria, así que un reinicio sigue con los mismos conteos. Un paso que depende de otro espera su aprobación, no solo su ejecución; un paso cuya auditoría falla del todo bloquea a sus dependientes. Tras una escalada, el delegador puede reformular el paso una vez y reasignar los pasos que quedaron bloqueados. El orquestador pide el auditor final con `haril_request_audit`; si lo rechaza, recibe los hallazgos en una continuación y puede corregir, dentro de `maxEscalationsPerTask`.
- **Secciones del prompt** de cada turno: una sola sección de datos con lo que escribieron otros agentes (memo, resultados y veredictos de los hijos, el resultado que juzga un auditor, los veredictos de intentos anteriores, las tareas hermanas con su superficie de escritura), cada línea con `| ` y la misma regla de caracteres invisibles; después la capacidad (agentes vivos, límites que quedan, modelos y su cuota) y la herramienta que debe llamar su rol. Las herramientas de cada turno son las de su arquetipo.
- **Consumo:** cada intento escribe su fila `agent_run` (modelo, capa, rol, dificultad, tokens, duración, resultado, veredicto) en la misma transacción que lo cierra, y cada `haril workflow start` escribe su orden; el workflow guarda esa orden y todas sus filas la nombran.
- **CLI:** `haril workflow start <objetivo> --model <ref> [--autonomous | --stop-at <paradas>] [--agent <ref>]`, `haril workflow list`, `haril workflow show <id> [--json]` (árbol, o `WorkflowSnapshot v1`) y `haril workflow continue <id> [--remove-stop <parada>]`.
- **Almacén:** `tasks.claimTask` reclama una tarea concreta; `claimNext` nunca da un turno de un workflow que no está en marcha y puede dejar todos los turnos al planificador de workflows; `workflows.list` filtra por estado. Migración `0010_delegation_runtime`: `delegations.payload` (la propuesta tal como llegó) y `workflows.order_id`.
- **Eventos del runtime** `workflow.turn` (un turno cerrado y lo que hizo) y `workflow.state` (un workflow que espera al humano, terminó o falló), que `haril start` muestra.
- **Agentes simulados dentro de `FakeAgentRuntime`:** `fake:orchestrate`, `fake:delegate`, `fake:execute` y `fake:audit` leen la entrada de su turno y llaman al host. El escenario va como texto visible en el objetivo: `[fake:parts=N]`, `[fake:steps=N]`, `[fake:seed=N]`, `[fake:mistake]` y `[fake:part-i/step-j=reject-once|reject-twice|stall-once]`.

### Cambiado

- Un workflow que espera al humano sigue aceptando turnos: un intento que termina mientras tanto deja lo que le sigue, que corre cuando el humano lo continúa. Un workflow terminado no acepta ninguno.
- El tick que aplicaba la cola durante un intento desaparece: el bucle mismo se despierta en cada sondeo, renueva el arrendamiento y aplica la cola.
- `haril usage log` y `haril usage summary` dejan fuera las filas de corridas simuladas salvo `--include-simulated`.
- La vista del workflow muestra como hecho a un auditor que rechazó, y los turnos listos de un workflow en pausa como «waits until the workflow continues».

### Corregido

Hallazgos del verificador independiente sobre la 0.12.0 y la 0.11.0, cada uno con su prueba (ROJO y después VERDE salvo donde se indica):

- **`usage verify`** leía las filas y la cabeza en lecturas separadas: un añadido de otra conexión en medio daba una falsa alarma. Ahora lee las dos cadenas y sus cabezas en una sola transacción de lectura. Además, el primer añadido deja una marca de «cadena empezada», así que borrar todas las filas junto con la cabeza se detecta.
- **CSV:** una celda de texto que empieza por `=`, `+`, `-`, `@`, tabulador o retorno de carro empieza con un apóstrofo (inyección de fórmulas).
- **Doble conteo:** `usage summary` y la vista `model_stats` contaban dos veces un run cuya tarea tenía dos auditorías; ahora unen un solo veredicto por tarea, el más nuevo (la migración `0009_model_stats_once` rehace la vista). `recordAudit` rechaza un segundo veredicto sobre el mismo turno y un veredicto de un turno auditor ya cerrado.
- **Cuota:** cada ventana se valida por separado; una ventana inválida es «sin dato» solo para ella y la otra sigue aplicando (`{5h: NaN, semanal: 95}` ya no pasa, y `worstQuota` ya no descarta una cuenta al 99 %).
- **Solape de globs:** un patrón con cualquier carácter fuera del ASCII imprimible se solapa con todo (`é` frente a `??`, `İ` frente a `?`); las letras ASCII se comparan sin mayúsculas; un par de superficies cuya comparación pasaría un presupuesto de trabajo responde «se solapan» al instante.
- **Contrato de superficies:** se rechazan los espacios al principio o al final (`" ../x"`, `" /etc/passwd"`).
- **Vista previa de órdenes:** censura las claves entre comillas (`{"password": "x"}`) y la credencial de una cabecera `Authorization: Basic|Bearer`, no solo la palabra del esquema.
- **`bump-version`:** si falla un renombrado a mitad, restaura los archivos ya renombrados desde copias tomadas justo antes, borra temporales y copias, y sale con 1.
- **Demo:** `--data-dir ""` cuenta como no dado (antes escribía `haril.db` en la carpeta actual) y una `--data-dir` que es la raíz de datos predeterminada se rechaza salvo `--allow-real-data-dir`; la ayuda lo dice.
- **Detalles:** el comentario de `0007` ya no dice que la versión anterior sigue abriendo la base; `0008` copia en orden de `rowid` (y acepta la suma de comprobación de su primer texto, que construía el mismo esquema, para no rechazar bases de la 0.12.0); un enlace `settled` movido a un dependiente que ya esperaba al turno nuevo sigue siendo `settled`; una continuación despertada por un hijo fallido, cancelado o bloqueado recibe cuál fue y por qué; `check-version` ignora los encabezados dentro de bloques de código y exige el texto real de la entrada de arriba de la base.
- Sin ROJO observable: el orden de copia de `0008` (SQLite ya copiaba en orden de `rowid` en la prueba; la prueba queda como guarda).

### Valores provisionales

Tomados de la propuesta de la especificación (sección 10.3) o decididos para esta fase:

- P1: `haril workflow start` sin `--autonomous` ni `--stop-at` para en `after_plan`. P2: el auditor final tiene un presupuesto de 30 000 tokens. P3: 1 relanzamiento y 1 escalada. P11: los límites son una instantánea del inicio. L1: los auditores no cuentan como hijos vivos.
- Sin catálogo de modelos (F6 y F7), cada hijo corre con el modelo del orquestador y un modelo propuesto debe ser ese.
- Una llamada aceptada se aplica cuando el turno termina, en la transacción que lo cierra; nada se crea mientras el turno corre.
- El turno de un auditor que rechaza termina fallido (es la compuerta de los dependientes del paso) y el de un delegador que informa `partial` o `failed`, también; el veredicto y el informe se guardan con el run.
- Un auditor que termina sin veredicto cuenta como un intento fallido de su ejecutor; un intento sin progreso termina en su tiempo máximo (`attemptTimeoutMs`) y cuenta igual.
- Una dependencia agregada por el Core al serializar superficies solapadas espera la aprobación, igual que un `dependsOn`.
- Los agentes siguen al del orquestador: `fake:orchestrate` usa `fake:delegate`, `fake:execute` y `fake:audit`; otra referencia usa el nombre del arquetipo (F2b).
- `haril_run` y `haril_merge` se rechazan hasta F8.
- Un workflow sin nada pendiente, listo ni corriendo termina: completado si el auditor final aprobó, fallido (`stalled`) si no. Pasado `maxWorkflowWallMs` falla (`wall_time`).
- Las filas de consumo de los agentes simulados usan los tokens que ellos mismos reportan; las de un agente real usarán el libro del Broker por tarea.

### Aplazado

- `haril workflow demo` sigue con su motor simulado: depende del tiempo virtual y del cierre por el vigilante (F3), así que pasarlo al runtime real ahora le quitaría casos.
- F2b: herramientas del puente para los agentes reales de Pi, el carril real y la solo lectura forzada de esos agentes. F3: parada inmediata, estado `halted`, barrido de pids, el vigilante de 15 minutos y una salvaguarda para una capacidad que nunca se libera.
- La cadena de hashes no detecta las últimas filas borradas junto con una reescritura coherente de la secuencia y el hash de la cabeza: cualquier cosa guardada en la base se puede reescribir también.

### Verificación

- `corepack pnpm run check`: salida 0 (Biome, tipos, capas, pureza, knip, compatibilidad y `check-version`).
- `corepack pnpm test`: salida 0; Vitest 2039 pasan y 1 omitida, `node:test` 122 de 122.
- `npm run build`: salida 0; `haril --version` muestra 0.13.0.
- Pruebas nuevas de la delegación en el runtime (`apps/haril/tests/workflow-runtime.test.ts`), herméticas, con los agentes simulados y SQLite real: el árbol completo, los límites (picos de agentes vivos por rol, por hilo y de escritores, medidos en el runtime de agentes), un workflow de 75 agentes sin bloqueo mutuo, un rechazo con su relanzamiento y un dependiente que espera la aprobación, una escalada con su reformulación y la reasignación del paso que bloqueó, una continuación tras un hijo fallido, `after_plan` y `continue`, una caída a mitad con reinicio (sin turnos, propuestas, veredictos ni filas duplicados y con los conteos de reproceso conservados) y las tareas sueltas en su carril. Dos mutaciones a mano (quitar la compuerta de aprobación, quitar los límites por rol) hacen fallar sus pruebas.
- CLI compilado con `HARIL_HOME` y `--data-dir` en una carpeta temporal: `workflow start` con un rechazo guionizado, `run` (para en `after_plan`), `workflow show` (orquestador esperando, delegadores en cola), `workflow continue`, `run` (completado), `workflow show` (17 agentes, «approved after 1 retry» en `e1`), `workflow show --json` (`WorkflowSnapshot v1` válido), `usage verify` («orders: 1 row, chain ok; usage_log: 17 rows, chain ok») y `usage summary --by role --include-simulated`. La carpeta de `HARIL_HOME` quedó vacía.

---

## 0.12.0

- **Fecha:** 2026-10-18
- **Estado:** **Los datos de la delegación en tres capas, el registro de consumo y de órdenes, y una demostración simulada.** `haril workflow demo` corre un árbol de orquestador, delegadores, ejecutores y auditores con agentes simulados, guiado por las reglas puras de la 0.11.0 y guardado en el almacén SQLite real, y muestra el árbol y los totales. Cada orden y cada intento quedan en un registro de solo añadir con cadena de hashes que `haril usage verify` comprueba. Todavía no hay runtime concurrente ni agentes reales en la delegación (fase F1b de la delegación, ADR-0021).

### Añadido

- **Migraciones:**
  - `0007_delegation`: las tablas `workflows`, `delegations`, `audits`, `model_cooldowns`, `quota_samples`, `orders` y `usage_log`, la vista `model_stats` (por modelo y clase de dificultad, sobre `usage_log` y `audits`, sin las filas simuladas) y las columnas de delegación de `tasks` (`workflow_id`, `layer`, `role`, `thread_id`, `difficulty`, `difficulty_reason`, `model_pinned`, `next_check_at`, `local_id`, `delegation_id`). `delegations`, `audits`, `orders` y `usage_log` son de solo añadir;
  - `0008_settled_deps`: reconstruye `task_dependencies` para admitir el tipo `settled`. Una dependencia `settled` se cumple cuando su tarea terminó bien, falló, se canceló o quedó bloqueada por un fallo anterior, así que una continuación corre aunque un hijo haya fallado.
- **Almacén** (`store.workflows`):
  - los comandos `workflow.start` (el workflow y el primer turno del orquestador, con su modelo fijado) y `workflow.continue` (solo el humano saca un workflow de `awaiting_human` y puede quitar paradas);
  - `applyTurns`, el `delegation.apply` interno bajo la época activa: crea en una transacción los turnos de una propuesta, sus dependencias y la propuesta misma, sin duplicarla si se repite con el mismo hash. Los dependientes de un hilo pasan a esperar su último turno;
  - `recordAudit` con la acción del reproceso, `setState` y la próxima evaluación del vigilante de cada turno;
  - eventos `workflow.created|awaiting_human|continued|completed|failed|stopped`, `delegation.applied`, `audit.verdict|retry|escalated`; la demostración añade `delegation.rejected`, `watchdog.checked`, `watchdog.closed` y `model.substituted`.
- **Registro de consumo y de órdenes** (`store.usageLog`, R-L1):
  - cada orden guarda su hash, su longitud y una vista previa de 200 caracteres con censura básica de claves y tokens (`orderPreview` en el Core), nunca el texto completo;
  - cada intento guarda modelo pedido y servido, dificultad, tokens (nulos si no se reportaron, nunca 0), duración y horas;
  - una cadena de hashes por tabla, con su cabeza en `meta`: `verify()` nombra la primera fila cambiada o borrada a mano, y también detecta las últimas filas borradas;
  - escribir no necesita el arrendamiento del runtime (P14).
- **CLI:**
  - `haril usage log`: una línea por fila, como `haril events`, filtrable por `--since` o `--from`/`--to`, `--kind order|chat|agent_run`, `--model`, `--workflow`, `--layer`, `--mode`, `--difficulty` y `--limit`, con `--json`;
  - `haril usage summary --by day|model|layer|difficulty|workflow|mode|role`: tokens, tokens no reportados, tiempo, reintentos y veredictos;
  - `haril usage verify`: recorre las dos cadenas y sale con 1 si una fila fue alterada;
  - `haril usage export --format jsonl|csv`, con `--table`, filtros de tiempo, `--before` y `--out` (no sobrescribe), hashes incluidos;
  - `haril workflow demo [--seed] [--delegators] [--executors] [--stop-at] [--start] [--data-dir] [--json]`: el árbol de tres capas simulado. Usa un almacén temporal que borra al terminar; `--data-dir` guarda las filas en otra carpeta, nunca en la predeterminada por su cuenta. Con la hora de inicio fija y la misma semilla imprime siempre lo mismo. `--json` da un `WorkflowSnapshot v1`, los picos de agentes vivos frente a cada límite y la verificación de la cadena.
- **Agentes simulados** `fake:orchestrate`, `fake:delegate`, `fake:execute` y `fake:audit` (`packages/core/testing`): funciones deterministas de su turno y una semilla que hacen las llamadas de un agente real (`haril_delegate`, `haril_assign`, `haril_report`, `haril_verdict`, `haril_request_audit`, `haril_abort`), todas válidas según los contratos. Un guion sembrado, escrito como texto visible, hace que un paso se rechace una vez, otro dos veces (escalada y reformulación) y otro se quede sin progreso; el orquestador propone además un modelo retirado en su primera llamada para que se vea el rechazo del Core.

### Cambiado

- `scripts/check-version.mjs`: el diff ignora los renombrados (un archivo público movido a `docs/` u `odd/` cuenta como cambio público), una subida debe dejar la entrada anterior de arriba del CHANGELOG debajo de la nueva (renombrarla no cuenta), en la CI falta de base es un error y `HARIL_VERSION_CHECK=consistency` comprueba solo la coherencia. La CI usa la comprobación completa en los PR y solo la coherencia en los push, para que un push de trabajo en curso no falle antes de la subida.
- `scripts/bump-version.mjs` escribe todo o nada: calcula cada archivo, lo escribe en un temporal junto a su destino y los renombra al final; un fallo antes de renombrar no deja nada a medias.
- `knip.json`: `state-sqlite` ya importa valores de `@haril/contracts`, así que deja de ignorarse esa dependencia.

### Corregido

Hallazgos del verificador independiente sobre la 0.11.0, cada uno con su prueba:

- **Cuota:** los bordes siguen las palabras del usuario: exactamente 80 % usado y exactamente 20 % restante todavía se permiten; solo más del 80 % cambia o detiene un modelo y solo menos del 20 % rechaza una tarea grande. Un porcentaje `NaN`, negativo o mayor que 100 se trata como «sin dato», nunca como correcto.
- **Modelo fijado:** un modelo vacío o en blanco para la tarea, o un `null` o vacío para la capa, no fija nada, igual en `chooseModel` y en `checkDelegation`.
- **Vigilante:** un hilo cuyos hijos esperan capacidad (límites de rol, de escritores, de superficie o del workflow) cuenta como vivo y se vuelve a evaluar en 15 minutos, nunca se cierra. Lo residual se cancela siempre de inmediato: la opción `closeResidualImmediately` desaparece; `idleStrikesToClose` sigue configurable.
- **Superficies:** un glob tiene como mucho 512 caracteres, una lista como mucho 64, y se rechazan las rutas absolutas y los segmentos `..`. `globsMayOverlap` ya no es recursivo, responde «se solapan» por encima del límite y nunca lanza; una ruta literal puede ser una carpeta (`src` se solapa con `src/a.ts`) y las dos partes se comparan en NFC.

### Valores provisionales

Tomados de la propuesta de la especificación (sección 10.3) o decididos para esta fase:

- P1: `workflow.start` sin autonomía para en `after_plan`; la demostración es autónoma salvo `--stop-at`. P2: el presupuesto del workflow será un presupuesto de tarea sobre la tarea raíz, así que `0008` no reconstruye `budgets`. P3: 1 relanzamiento y 1 escalada. P14: el registro se escribe directo, sin runtime. P15: vista previa de 200 caracteres con censura básica. P16: vigilante cada 15 minutos que cierra tras 1 evaluación sin progreso. L1: los auditores no cuentan como hijos vivos.
- Cada turno corre con `maxAttempts` 1: un relanzamiento es un turno nuevo del mismo hilo, así que solo la máquina de reproceso decide los reintentos.
- Una reformulación es una asignación del delegador con el `localId` de un hilo escalado: continúa ese hilo.
- Un hermano que depende de otro espera a que su predecesor termine de ejecutarse, no a que su auditor lo apruebe (los turnos rechazados se relanzan; si F2 quiere esperar la aprobación, lo decide allí).
- Un intento cerrado por el vigilante deja sus tokens nulos (no reportados).
- En la fila de consumo de un intento de ejecutor, `retries` vale 1 si el intento es un relanzamiento y 0 si no, así que `haril usage summary` suma relanzamientos.
- En la vista, `modelSource` distingue `pinned` de `table`; el modelo propuesto por el padre todavía no se distingue.

### Desvíos y aplazamientos

- `runs` ya tenía `pid` y `pid_started_at` desde la `0001`: la `0007` no añade columnas a `runs`.
- Columnas que la especificación no listaba: `workflows.simulated` y `usage_log.simulated` (las filas de la demostración se distinguen y `model_stats` las excluye), `tasks.local_id` y `tasks.delegation_id`, `audits.rework_action`, y `seq` e `idempotency_key` en `orders` y `usage_log`.
- Los ids del registro no tienen claves foráneas (un registro nunca rechaza una fila por una referencia), salvo `usage_log.order_id`.
- `haril usage log --kind order` muestra solo las órdenes (la especificación solo listaba `chat` y `agent_run`).
- La sección 6 no nombra el comando de demostración: es `haril workflow demo`, junto a los `workflow start|list|show` de la fase F2.
- Aplazado: el bucle concurrente, el puente y `haril workflow start|list|show` con agentes reales (F2); `workflow.stop`, `runtime.resume`, `stop --now`, `tasks.cancel` y `runs.cancel(user_stop)` (F3); `haril usage record` y la captura del chat (F4); escribir en `model_cooldowns` y `quota_samples` (F6).

### Verificación

- Pruebas primero en cada unidad: migraciones (base nueva y desde el esquema 6), cada operación del almacén, la cadena de hashes (una fila alterada se detecta en su posición, una borrada en la siguiente, las últimas por la cabeza), la vista previa, la CLI (filtros de tiempo y de tipo), los agentes simulados y la demostración (nunca pasa un límite, nunca más de 1 reintento y 1 escalada, mismo resultado con la misma semilla). Se vio el rojo antes del verde; en la demostración y el registro, las pruebas se pusieron en rojo quitando el comando o con una fachada vacía.
- Las correcciones de la 0.11.0 tienen cada una su prueba, primero en rojo.
- 121 pruebas nuevas: 114 de Vitest (migraciones, almacén, registro, CLI, agentes simulados, demostración y correcciones de la 0.11.0) y 7 de los scripts de versión.
- La demostración se probó con cinco combinaciones de semilla y tamaño (de 2 a 30 ejecutores): todas terminan, ninguna pasa un límite y la cadena de hashes queda íntegra; con 5 delegadores de 6 ejecutores alcanza exactamente 5 ejecutores vivos y 1 escritor.
- Local: `pnpm run check` 0; `pnpm test` con 1979 pruebas de Vitest (1 omitida, solo POSIX) y 119 de `node:test`; `npm run build` 0, `haril --version` imprime `haril 0.12.0` y `haril workflow demo --data-dir <carpeta temporal>` termina el workflow (42 agentes, 3 relanzamientos, 1 escalada, 1 cierre por inactividad) con `haril usage verify` en 0.

---

## 0.11.0

- **Fecha:** 2026-10-18
- **Estado:** **El núcleo puro de la delegación en tres capas.** El Core ya sabe validar lo que propone un agente, decidir qué tareas pueden arrancar sin pasar ningún límite, elegir el modelo de cada agente según quién lo fijó, la tabla de dificultad y la cuota, acotar los reprocesos y dar el veredicto del vigilante de 15 minutos. Son funciones puras, sin base de datos ni procesos: todavía no hay runtime que las use ni comando nuevo (fase F1a de la delegación, ADR-0021). Además, cada cambio entregado queda obligado a subir la versión: `npm run check` y la CI fallan si no.

### Añadido

- **Núcleo de la delegación** (`packages/core/src/delegation/`):
  - **arquetipos** `orchestrator`, `delegator`, `executor` y `auditor`, sobre los tipos de tarea existentes (`plan`, `plan`, `work` y `verify`), con sus herramientas del puente antes y después de la escritura (F8) y los hijos que cada uno puede proponer;
  - **límites** con los valores iniciales de la configuración: 5 delegadores por orquestador y 4 ejecutores por delegador vivos a la vez por hilo, 5 ejecutores y 5 auditores simultáneos por workflow como límites independientes, 1 escritor, 100 agentes por workflow, 3 propuestas y 100 tareas en cola por hilo. Ninguna regla lleva un número fijo: todas leen el objeto de límites;
  - `checkDelegation`: cada regla de validación con su código cerrado (`workflow_not_running`, `tool_not_allowed`, `too_deep`, `too_many_proposals`, `too_many_queued`, `workflow_agent_cap`, `workflow_token_cap`, `duplicate_task_id`, `unknown_dependency`, `cycle`, `model_not_allowed`, `model_unavailable`, `quota_blocked`, `checkpoint_removes_stop`) y un motivo legible para que el agente corrija. Los hermanos con superficies de escritura solapadas no se rechazan: se ordenan en secuencia siguiendo sus dependencias;
  - `selectClaims`: qué tareas listas arrancan ahora, por prioridad y orden de creación, sin pasar nunca un límite por rol, por hilo, de escritores o del workflow, sin dos turnos del mismo hilo a la vez y sin dos tareas con superficies de escritura que puedan solaparse;
  - `globsMayOverlap`: el algoritmo conservador de la verificación S5; ante sintaxis que no puede analizar, responde que se solapan;
  - `chooseModel`: el modelo que fija el usuario se usa siempre y nunca se sustituye (con la cuota bloqueada espera el reinicio o detiene el workflow); el del padre se valida y, si al lanzar ya no cumple, se cambia por el siguiente elegible indicando cuál reemplazó; si no, la tabla de dificultad (el más barato con tasa de éxito suficiente, desempate por más cuota restante). Reglas de cuota: desde el 80 % de la ventana de 5 h se cambia de modelo, desde el 80 % semanal se deja de usar, con 20 % o menos restante no va una tarea grande, y sin dato la regla se omite para ese proveedor;
  - **máquina de reproceso**: como mucho 1 relanzamiento y 1 escalada por tarea; un intento fallido cuenta como un rechazo y una reformulación no reinicia la cuenta. `checkVerdict` rechaza un veredicto negativo sin ningún criterio incumplido (`verdict_without_reason`);
  - `evaluateLiveness`: el vigilante de 15 minutos hecho en código con datos objetivos: lo residual se cancela sin reintento, lo inactivo se cierra, lo que avanza sigue y se vuelve a evaluar, y las esperas humanas y los enfriamientos no se cierran;
  - **paradas**: el agente solo puede añadirlas; quitarlas es cosa del humano. `stopFor` dice qué parada alcanza cada evento.
- **Contratos** (`packages/contracts`): los esquemas de `haril_delegate`, `haril_assign`, `haril_report`, `haril_verdict`, `haril_request_audit`, `haril_abort`, `haril_run` y `haril_merge`, el vocabulario cerrado de paradas y `WorkflowSnapshot v1`, cada uno con su validador.
- **Versión obligatoria:**
  - `node scripts/bump-version.mjs <patch|minor|major|x.y.z>` (o `npm run version:bump -- minor`) sube todas las cadenas de versión juntas, añade arriba del CHANGELOG una entrada fechada con marcas `TODO(bump-version)` para completar y actualiza `versions/README.md`, conservando los finales de línea de cada archivo. Esta versión se subió con él;
  - `npm run check:version`, dentro de `npm run check`: falla si hay archivos públicos cambiados respecto de la base sin subir la versión, si las cadenas de versión no coinciden, si la entrada de arriba del CHANGELOG no es la versión actual o le quedan marcas, o si `versions/README.md` nombra otra versión. La base es `HARIL_VERSION_BASE` o el merge-base con `origin/main`; sin base (un clon sin remoto) solo comprueba la coherencia y lo dice.

### Cambiado

- La CI descarga el historial completo (`fetch-depth: 0`) para que `check:version` encuentre el merge-base.
- `scripts/check-layers.mjs` asigna la carpeta `core/delegation` a la capa 2, para que el ejecutor y el orquestador (capa 3) puedan leer la tabla de arquetipos.

### Valores provisionales

Tomados de la propuesta de la especificación mientras el usuario no decida (ADR-0021):

- P1: parada por defecto `after_plan`. P3: 1 relanzamiento y 1 escalada. P4: la cuota de un proveedor con varias cuentas es la de su peor cuenta. P16: vigilante cada 15 minutos, cierra tras 1 evaluación sin progreso y cierra los residuales de inmediato.
- Lectura L1: los auditores no cuentan entre los hijos vivos de su delegador; solo los limita su tope simultáneo.
- Una petición al modelo en curso cuenta como progreso para el vigilante: un modelo que razona sin emitir no se cierra (el Broker ya corta un flujo tras 120 s de silencio).
- La forma de `haril_run` (`command` y `args`) no estaba fijada en la especificación.
- Añadidos a la especificación: la clave `maxDepth` (3) en los límites, para que la regla de profundidad también lea un límite, y el código `workflow_token_cap` para el tope de tokens del workflow.
- En el borde exacto, el 80 % ya bloquea: la fórmula de la especificación dice «usado < 80 %».

### Desvíos y aplazamientos

- **Sin runtime ni comandos:** las funciones existen, pero nada las llama todavía. Las migraciones `0007` y `0008`, el registro de consumo y de órdenes, `haril usage`, los agentes simulados `fake:*` y la demostración de tres capas son la fase F1b.
- `checkDelegation` no reutiliza `plan-graph.ts`: sus funciones de grafo son internas y trabajan sobre un plan, así que la delegación tiene las suyas con los mismos códigos.
- `selectClaims` cuenta agentes, no tokens: la configuración define topes por número.
- Una carpeta existente como superficie se trata como `carpeta/**` solo si quien llama la escribe con `/` final: el Core es puro y no mira el disco.
- La consola conserva su copia local de `WorkflowSnapshot` (regla de capas R6); no se tocó.

### Verificación

- Pruebas primero: para cada función pura se escribieron las pruebas, se vio el rojo (con el módulo ausente o con funciones de relleno) y después el verde. Pruebas de propiedades con semilla fija: 3000 instantáneas generadas para `selectClaims` (nunca pasa un límite, nunca solapa superficies y nunca deja una tarea esperando si cabía) y 4000 secuencias de eventos para el reproceso. Dos mutaciones a mano en `selectClaims` (el tope de escritores y el cerrojo de superficie) hicieron fallar las pruebas.
- 198 pruebas nuevas: 31 de contratos, 144 del núcleo de la delegación y 23 de los scripts de versión, que crean repositorios git temporales y los borran al terminar.
- Local: `pnpm run check` 0; `pnpm test` con 1865 pruebas de Vitest (1 omitida, solo POSIX) y 112 de `node:test`; `npm run build` 0 y `haril --version` imprime `haril 0.11.0`. `check:version` sobre esta rama: 0.8.0 → 0.11.0 desde el merge-base con `origin/main`.

---

## 0.10.0

- **Fecha:** 2026-10-18
- **Estado:** **Modelo y nivel de razonamiento en la consola.** La barra y las cabeceras de la consola sobre Pi muestran siempre el modelo y su nivel; un clic los cambia, y para cada modelo de CLIProxyAPI Pi ofrece solo los niveles que ese modelo publica. El nivel llega al proveedor como `reasoning_effort`, comprobado con Pi 1.2.0 contra un servidor falso y contra el CLIProxyAPI local. Es la fase FM de la delegación (ADR-0021, decisiones P24 y P27, resultado S8).

### Añadido

- **Niveles de cada modelo (fase FM):**
  - la consola lee la lista `GET <url>/models?client_version=0.99.0` de cada proveedor de HARIL y registra cada modelo en Pi con `reasoning` y `thinkingLevelMap`, que ofrece solo los niveles publicados, y con el contexto y la salida reales. Los niveles que comparten Pi y CLIProxyAPI (minimal, low, medium, high, xhigh y max) pasan tal cual; `none` es lo que envía `off` cuando el modelo lo publica (si no lo publica, `off` no se ofrece, porque no enviar nada deja al modelo en su nivel por defecto); `auto` no tiene nivel en Pi y no se ofrece;
  - un modelo que esa lista no describe toma `reasoning` y `thinkingLevelMap` del catálogo de Pi por nombre normalizado (sin prefijo de proveedor o cuenta, aceptando `-preview`, `-latest` o una fecha), con los valores que CLIProxyAPI no conoce marcados como no admitidos. Sin ningún dato, el modelo sale «no reasoning» y solo ofrece `off`;
  - si la lista falla (sin respuesta en 10 s, error HTTP, redirección o respuesta que no es JSON), la consola lo avisa y usa el catálogo de Pi, como antes.
- **Siempre visible:** la barra muestra `modelo · nivel`, o `modelo · no reasoning` si el modelo no razona; las cabeceras ancha y compacta, y las áreas `AGENTS` y `EVERYWHERE`, también.
- **Cambiarlo con clic o con teclado:**
  - clic en el modelo de la barra: selector de los modelos con acceso (`getAvailable()`), primero el proveedor o la cuenta (`Gemini1` a `Gemini10`, en orden natural) y luego sus modelos con su contexto y sus niveles;
  - clic en el nivel: solo los niveles de ese modelo, con el actual marcado, el que publica por defecto y el que guarda `/settings` de Pi;
  - el control **Model and level** en `TOOLS` y **Choose reasoning level** en `/haril`;
  - `/model`, `Ctrl+L`, `/thinking` y `Shift+Tab` de Pi siguen funcionando y ahora ofrecen los niveles reales.
- **Recordarlo:** el nivel elegido se recuerda por modelo durante la sesión y vuelve al regresar a ese modelo; también los cambios hechos con `/thinking` y `Shift+Tab`. El reajuste que hace Pi al cambiar de modelo no se toma por una elección. El nivel por defecto que publica CLIProxyAPI se aplica solo si Pi no decide: sin nivel guardado para ese modelo y con un nivel por defecto global que el modelo no ofrece.
- `pi-types.ts` declara `getAvailable`, `setThinkingLevel`, `ThinkingLevelMap`, el nivel por defecto y el nivel por modelo de los ajustes y el evento `thinking_level_select`, con las firmas de Pi 1.2.0.
- **Pruebas:** 48 pruebas nuevas en `integrations/pi-console/tests/`: normalización de nombres, lectura de la lista (con `models` o `data`, `slug` o `id`, niveles como texto o como objeto, campos que faltan, respuestas que no son una lista), correspondencia de niveles, registro con `reasoning` y `thinkingLevelMap` contra un servidor falso en un puerto efímero (incluidos HTML, error 500, redirección, tiempo agotado y servidor caído), selectores con un Pi falso, la memoria por modelo, y la barra y las cabeceras.

### Cambiado

- **Choose Pi model** (en `AGENTS` y en `/haril`) lista solo los modelos con acceso, agrupados, en vez de todo el catálogo de Pi.
- El catálogo de Pi se busca por nombre normalizado, no solo por id exacto; de ahí salen también, si el proveedor no las da, las entradas (texto o imagen), el contexto y la salida.
- Para leer la lista, la extensión toma la clave de la misma variable de entorno que lee Pi, solo en memoria, y la envía a la misma URL a la que Pi la envía, sin seguir redirecciones. Nunca la escribe, la muestra ni la pone en argumentos.

### Corregido

- **No se podía cambiar el nivel de razonamiento en la consola.** Los modelos de CLIProxyAPI se registraban sin razonamiento porque su id no coincidía con el del catálogo de Pi (`gemini-3-flash` frente a `gemini-3-flash-preview`); Pi solo ofrecía `off` y `Shift+Tab` respondía que el modelo no admite razonamiento. La barra solo mostraba el nivel de un modelo que razona y las cabeceras nunca lo mostraban.
- **Vista de orquestación (F5a, hallazgos del verificador):**
  - una letra con `Ctrl`, `Alt` o `Super` en el protocolo de teclado de Kitty ya no hace la acción de la letra: `Ctrl+S` ya no abre la confirmación de la parada real. `Shift` más una letra sigue siendo la letra;
  - en la vista en vivo, `↑` `↓` recorren la lista de la vista desde la que se abrió (el árbol para Quota y Log);
  - la vista en vivo usa el rótulo común «DEMO · sample data, not real» y, en la demostración sin ningún agente en la vista, dice que no hay nada en vivo que mostrar;
  - el README decía que un clic en la fila muestra u oculta el detalle; solo lo muestra, y `Enter` o `[Enter Detail]` lo alternan.

### Desvíos y aplazamientos

- **Recordar el nivel al reiniciar.** Pi 1.2.0 tiene un ajuste por modelo, `modelThinkingLevels`, que aplica al cambiar a ese modelo, pero solo lo escribe su `/settings`: la API de extensiones lee los ajustes y fija el nivel de la sesión, nada más. HARIL lo lee (lo marca en el selector), recuerda el nivel durante la sesión y remite a `/settings` › *Default thinking level per model* para conservarlo al reiniciar. No se creó un archivo de configuración propio.
- **Sin tabla de familias editable** (la fuente «c» del diseño 7.10): queda fuera de FM.
- **Aplazado a F7:** modelo y nivel por capa (`delegation.models.layers`), pasar `--thinking` a los agentes, que el catálogo de la pasarela en `integrations/gateway` (y `haril models`) lea esta lista, y los valores por defecto del contexto de los agentes.
- **`auto` de CLIProxyAPI no se ofrece:** Pi no tiene un nivel que lo represente.
- **Sin probar en una terminal real:** el clic en la barra y los selectores dentro de la interfaz de Pi solo se comprobaron con pruebas automáticas y con la sesión de Pi del SDK, que no dibuja la terminal.

### Verificación

- Local: `pnpm run check` 0; `pnpm test` con 1690 pruebas de Vitest (1 omitida, solo POSIX) y 89 de `node:test`; `npm run build` 0 y `haril --version` imprime `haril 0.10.0`.
- Con Pi 1.2.0 real (su SDK), la extensión compilada, una CLI `haril` falsa y un servidor falso compatible con OpenAI, en un script fuera del repositorio porque Pi no es dependencia del repositorio: al arrancar, `Gemini1/gemini-3-flash` queda en `medium` (el nivel por defecto que publica) y Pi ofrece solo minimal, low, medium y high; `reasoning_effort` llega `high` y luego `low`; `Gemini1/claude-sonnet-4-6` ofrece solo `off` y no envía `reasoning_effort`; al volver a gemini-3-flash recupera `low`.
- En vivo contra el CLIProxyAPI local (tres peticiones): por el mismo camino de Pi, `Gemini1/gemini-3-flash` con `low` y con `high` responde 200 y la petición lleva ese `reasoning_effort`; una petición directa con `high` y una pregunta corta responde 200 con `completion_tokens_details.reasoning_tokens` 393 de 396 tokens de salida.

---

## 0.9.0

- **Fecha:** 2026-10-18
- **Estado:** **La vista de orquestación en la consola, con datos de ejemplo.** El módulo `ORCHESTRATION` de la consola sobre Pi muestra la maqueta aprobada de la delegación en tres capas (ADR-0021): un resumen en el panel y una vista completa en superposición, manejables con clic y con teclado. El motor de orquestación todavía no existe, así que la vista solo tiene datos con `/orchestration demo`, siempre rotulados como de ejemplo. La versión incluye también la consola interactiva integrada en el PR #37: cabecera y áreas navegables con clic, controles por módulo y registro de la carpeta como proyecto.

### Añadido

- **Vista de orquestación (fase F5a de la delegación):**
  - resumen en el módulo `ORCHESTRATION`: métricas de cabecera (tokens, tiempo, ejecutores de 5, auditores de 5, agentes de 100, cola), un árbol compacto que cabe en la altura disponible, los botones de las vistas, «Open full view» y «■ Stop all», todos con clic;
  - vista completa en una superposición de Pi: las vistas Tree, By layer, Queue, Quota y Log; el detalle del nodo seleccionado (objetivo, modelo con su origen y nivel, archivos, dificultad, contexto frente al umbral con barra, cuota de 5 h y semanal con la marca del 80 % o `n/a`, progreso, próxima revisión del vigilante, auditoría y memo); los eventos recientes. Versión ancha desde 120×40 y compacta por debajo;
  - teclado dentro de la vista: `Tab` y `←` `→` cambian de vista, `↑` `↓` mueven la selección, `Enter` muestra u oculta el detalle, `L` abre la vista en vivo, `F` filtra el registro (all, agent_run, chat), `D` activa la demostración, `W` simula el vigilante, `R` reinicia, `S` para todo y `Esc` cierra. Cada acción tiene su equivalente con clic, y se reconocen también las secuencias del protocolo de teclado de Kitty;
  - vista en vivo de un agente: en la demostración, cabecera (rol, capa, modelo, nivel, estado, tokens y contexto), línea de tiempo y una transcripción simulada rotulada DEMO; fuera de ella, dice que llegará con los workflows reales;
  - modo demostración: `/orchestration demo`, el control «Demo on/off» del módulo, `D` o el menú `/haril` cargan los once nodos de ejemplo de ADR-0021 con el rótulo permanente «DEMO · sample data, not real». «Simular vigilante» cierra solo el nodo sin progreso (e5) y deja continuar a los activos; «Stop all» cancela los nodos vivos sin parar nada real; «Reset» vuelve al inicio;
  - `/orchestration view`, el control «Open orchestration view» y el atajo `Alt+O` (libre en los atajos por defecto de Pi 1.2.0) abren la vista completa; `/orchestration` sin argumentos sigue abriendo el área;
  - cada estado se dibuja con símbolo y texto, nunca solo con color; `HARIL_CONSOLE_ASCII=1` cambia `●`, `○`, `✓`, `✗`, `■`, `‖` y `→` por `*`, `o`, `v`, `x`, `#`, `||` y `->`;
  - el contrato `WorkflowSnapshot v1` copiado en la consola: `null` se muestra como `n/a` y nunca se inventa un valor.
- **Primeras pruebas de la consola:** `integrations/pi-console/tests/`, con 59 pruebas de Vitest sobre funciones puras y un Pi falso: ancho de cada línea a 80 y 140 columnas, símbolo y texto por estado, contenido del detalle, estado vacío sin números de ejemplo, respaldo ASCII, teclado, vigilante y parada simulados, mapeo de clics y el comando `/orchestration`.

### Cambiado

- El módulo `ORCHESTRATION` muestra primero el resumen del workflow (o el estado vacío «No workflows yet») y, debajo, una sola línea con las tareas, la cola, las aprobaciones y los eventos del proyecto. Conserva todos sus controles y suma «Open orchestration view» y «Demo on/off».
- «■ Stop all» fuera de la demostración reutiliza la parada del runtime compartido, con su confirmación, y la ejecuta después de cerrar la superposición.

### Corregido

- Sin correcciones en esta versión.

### Desvíos y aplazamientos

- **Solo datos de ejemplo.** La vista no lee workflows reales: el cargador de datos y `haril workflow show` llegan en la fase siguiente (F5b).
- **El módulo WORKFLOWS sigue.** Se retira en una fase posterior, cuando las metodologías pasen a TOOLS.
- **«Stop all» todavía no es la parada inmediata:** fuera de la demostración pide confirmación; la parada de emergencia sin confirmación y su atajo global llegan con su fase.
- **Sin «Continuar una parada» (`C`):** la demostración no tiene paradas humanas pendientes.
- **Tiempo del workflow de ejemplo:** 00:21:12 en lugar del 00:03:12 de la maqueta, para que e5 pueda llevar 17 minutos sin actividad.
- **Sin probar en una terminal real:** el dibujo, los símbolos en PowerShell y los clics dentro de Pi solo se comprobaron con pruebas automáticas y con la extensión compilada cargada en un Pi falso.

### Verificación

- Local: `pnpm run check` 0; `pnpm test` con 1638 pruebas de Vitest (1 omitida, solo POSIX) y 89 de `node:test`; `npm run build` compila la extensión de la consola y `haril --version` imprime `haril 0.9.0`.
- La extensión compilada, cargada con un Pi falso, registra `Alt+O` y `/orchestration`; `/orchestration demo` dibuja el resumen, un clic en una fila abre la superposición y las teclas la manejan.

---

## 0.8.0

- **Fecha:** 2026-10-17
- **Estado:** **`haril` abre Pi.** Al escribir `haril` en una terminal (o `haril console`) se abre Pi, con el Node 24.22.0 y el Pi 1.2.0 fijados que instala HARIL, en la carpeta actual y con una extensión de HARIL, igual que Gentle Shell es Pi más su extensión. Quedan todos los comandos de Pi (`/login`, `/model`, el nivel de razonamiento, `/settings`, las sesiones) y se suman una barra amarilla de HARIL y los comandos para pedir un plan, aprobarlo y seguir sus tareas. La interfaz anterior sigue en `haril shell`. La versión recoge también lo integrado de M4 desde la 0.7.0: resultados de dependencias, motivo del reintento, puerto y outbox de memoria con su adaptador de Engram, SecretStore y el orden de cierre de Pi en Windows.

### Añadido

- **Consola de HARIL sobre Pi:**
  - `haril` sin subcomando en una terminal y `haril console [--data-dir <ruta>]` lanzan Pi como proceso externo, sin fork, con el Node y el Pi de `runtime\manifest.json`, en la carpeta actual y con la extensión `integrations/pi-console` (`-e`); no usan `--no-extensions` ni `--offline`, así que `/login`, `/model`, `/thinking` (también `shift+tab`), `/settings` y el resto de Pi funcionan;
  - Pi guarda sus ajustes, accesos y sesiones de HARIL en `<raíz>\agent` (`%LOCALAPPDATA%\HARIL\agent` en Windows), separado de `~\.pi` y de `~\.gentle-shell`. Salvo que `PI_SKIP_VERSION_CHECK` o `PI_TELEMETRY` ya estén definidas, Pi arranca sin consultar su última versión y sin telemetría de instalación;
  - necesita una terminal real y el runtime instalado: sin terminal sale con 2; sin runtime imprime una línea que remite a `npm run runtime:install` o al instalador y sale con 2; sin la extensión compilada pide `npm run build` y sale con 1. Su código de salida es el de Pi;
  - la extensión es un solo `.mjs` autocontenido (`npm run build:console`, parte de `npm run build`) y solo llama a la CLI `haril`, sin shell: el estado sigue en `haril.db` y lo escribe el runtime. El instalador la copia junto a la CLI.
- **Barra amarilla y cabecera de HARIL:** el pie de Pi muestra `◆ HARIL ◇ <proyecto o carpeta> ◇ <modelo> · <nivel>` y, a la derecha, `ctx <medidor> <pct>% ◇ $<coste> ◇ <N pending> ◇ runtime <estado>`; debajo, la carpeta, su rama de git y los estados de otras extensiones. El nivel solo sale con un modelo que razona; el coste es la suma de lo que Pi registró en la sesión; `N pending` solo con planes por aprobar; el runtime es `running`, `starting`, `idle` o `unknown`. En una terminal estrecha la barra suelta primero el coste y al final el medidor de contexto. Cambiar de modelo o de nivel la actualiza, y se vuelve a leer cada 5 s solo mientras hay un runtime en marcha o un plan por aprobar. La cabecera de arranque lleva la versión y `/haril for commands`.
- **Comandos de HARIL dentro de Pi:** ninguno choca con los nativos de Pi, y cada uno ejecuta la CLI sobre el proyecto de la carpeta actual (el registrado cuya raíz es esa carpeta o su antecesora más cercana; sin proyecto, la barra muestra la carpeta).

  | Comando | Acción |
  |---|---|
  | `/haril` | Lista los comandos de HARIL |
  | `/init [nombre]` | Registra la carpeta actual como proyecto de HARIL |
  | `/goal <texto>` | Encola una tarea de plan para `planner`: con el modelo actual si lo sirve un proveedor de HARIL; si no, con `HARIL_DEFAULT_MODEL`; si no, con `fake:plan` y lo avisa |
  | `/plans`, `/plan <id>` | Los planes por aprobar; un plan entero con cada tarea |
  | `/approve [id]`, `/deny [id]` | Aprueba o rechaza un plan; sin id, el único pendiente |
  | `/tasks`, `/task <id>`, `/events` | Estado del proyecto y su cola; una tarea con su resultado, error y tokens; los últimos 20 eventos |

  Tras `/goal` y `/approve`, si ningún runtime está en marcha, la consola arranca `haril start --started-by shell` en segundo plano, con su salida en `logs\runtime-<fecha>.log`, como `haril shell`.
- **Los modelos de HARIL en `/model` de Pi:** cada proveedor de `haril.json` (por defecto `cliproxy`) que responde con modelos se registra en Pi como proveedor compatible con OpenAI llamado `haril-<id>`. La clave nunca pasa por la extensión, la línea de comandos ni el disco: Pi lee por sí mismo la variable que nombra `keyEnv` (por ejemplo `HARIL_CLIPROXYAPI_KEY`). Un proveedor sin esa variable o sin respuesta no se registra y la consola lo dice al abrir. Al arrancar se restaura el último modelo de HARIL elegido en Pi; sin modelo, se usa el de `HARIL_DEFAULT_MODEL` o el primero de HARIL.
- **Resultados de dependencias (PR #30):** una tarea recibe en su prompt los resultados de las tareas de su `dependsOn`, en el orden en que se crearon, marcados como escritos por otros agentes (datos, no instrucciones) y con cada línea precedida por `| `, así que un resultado no puede imitar el final de la sección, una cabecera ni una instrucción. Cada resultado se corta a 8000 caracteres y el objetivo de su cabecera a 200; la sección entera cuesta como mucho un octavo de los tokens de la tarea por llamada, y lo que no cabe se deja fuera con una nota.
- **Motivo del reintento (PR #31):** la salida que no pasa la verificación ahora se guarda. Los intentos siguientes de un agente real reciben, tras los resultados de sus dependencias, el último intento rechazado por sus comprobaciones: su número, las comprobaciones que falló y la salida que rechazaron, dentro de la mitad del presupuesto de las secciones de datos (el encabezado y la primera comprobación fallida salen siempre). `task show` muestra `rejected output: …` (en `--json`, `error.output`); en una tarea completada, un fallo anterior es solo historia (`earlier attempt <n> failed: …`, `earlierFailure`). `verification_exhausted` se registra también en el último intento, y `haril task add --help` describe cada opción.
- **Memoria (PR #32, #33 y #34):**
  - los contratos y el puerto `MemoryProvider` (con `ScopeRef` obligatorio y fallos tipados), los proveedores `Null` e `InMemory` y una suite de contrato compartida;
  - la migración 0006 (aditiva) con `memory_outbox` y `memory_refs`, y el servicio de memoria de Core: entrega al menos una vez sin duplicados, `memory.degraded` y `memory.recovered` una vez por transición, lecturas vacías mientras el proveedor no está disponible, y solo se bloquean las tareas cuyo `requires[]` incluye memoria;
  - `haril memory status [--json]` (solo lee `haril.db`, sin runtime) y el estado de la memoria en `haril status` y en la caja Connect de `haril shell`; el runtime avanza el outbox antes de cada reclamo y, al quedar ocioso o parar, dice las tareas y las escrituras que espera la memoria;
  - el adaptador de Engram (`@haril/memory-engram`, por HTTP y probado contra un Engram falso con inyección de fallos) y la supervisión de `engram serve`: guardas de directorio de datos y de puerto, entorno cerrado, comprobación de que el serve es propio y cierre del árbol de procesos. **Aún no está conectado al runtime**, que arranca con el proveedor `Null`.
- **SecretStore (PR #36):** el puerto `SecretStore` con secretos sellados (`SecretRef` `env:NOMBRE`; el valor no sale en JSON, `String()` ni errores), su doble y una suite de contrato, y `EnvSecretStore`. La clave de CLIProxyAPI se lee por referencia (`env:HARIL_CLIPROXYAPI_KEY`) y llega sellada al adaptador compatible con OpenAI, que solo la revela para la cabecera `Authorization`; `HARIL_CLIPROXYAPI_KEY` funciona como antes. Una clave canario no aparece en la salida de la CLI, en `haril.db`, en los archivos de la raíz de datos ni en el entorno o los argumentos del hijo Pi.

### Cambiado

- `haril` sin subcomando en una terminal abre la consola sobre Pi y no la interfaz de la 0.7.0; fuera de una terminal sigue imprimiendo la ayuda y saliendo con 2. `haril shell` abre la interfaz anterior, sin cambios de uso.
- La columna derecha de `haril shell` ya no tiene la caja Taxis: quedan proyecto, git, runtime, aprobaciones y tokens.
- El esquema del almacén pasa de 5 a 6 con la migración 0006, aditiva; una versión anterior no abre una base ya migrada, que nunca se degrada.

### Corregido

- En Windows, `agent-pi` cerraba Pi justo después de lanzar `taskkill /F /T`, que no encontraba el proceso y no recorría el árbol: un proceso que una shell bajo Pi había arrancado sobrevivía al run. Ahora espera a que `taskkill` acabe antes de matar a Pi, y lo mata también si `taskkill` no puede arrancar (PR #35).
- La guarda de instalaciones ajenas de e2e ignora el `.last-cleanup` de Claude Code, que se reescribía durante la ejecución; solo se ignora ese archivo en la raíz de `~/.claude`.
- El adaptador compatible con OpenAI también redacta los ecos de la clave en base64, base64url y codificados como URL, en los cuerpos de error HTTP y en los errores a mitad de flujo (PR #36).

### Desvíos y aplazamientos

- **La memoria aún no usa Engram.** El adaptador y su supervisión existen y pasan la suite de contrato, pero el runtime arranca con el proveedor `Null`: no se guarda nada y no se encola ninguna escritura.
- **Sin keyring.** `EnvSecretStore` lee solo el entorno; el almacén de claves del sistema sigue pendiente.
- **La consola no tiene los paneles de `haril shell`.** El avance de las tareas se sigue con `/tasks`, `/task <id>` y `/events`; la vista En vivo, los paneles y los temas de HARIL no están en Pi.
- **El coste de HARIL sigue sin registrarse.** El `$` de la barra es el que Pi anota en la sesión; con un proveedor de HARIL es cero, porque HARIL no sabe cuánto cobra el proveedor.
- **Consola sin verificar todavía en una terminal real:** la barra, `/model` y los comandos no se han ejecutado aún en Windows Terminal.

### Verificación

- Local: `pnpm run check` 0; `pnpm test` con 1579 pruebas de Vitest (1 omitida, solo POSIX) y 89 de `node:test`; `npm run e2e` y `npm run e2e:demo` pasan; `npm run build` compila la extensión de la consola junto a la CLI y `haril --version` imprime `haril 0.8.0`.
- La consola no tiene suite propia: la extensión solo se comprueba con los tipos, las reglas de capas (solo importa `node:*` y sus propios archivos) y la compilación a un solo `.mjs`; solo tienen pruebas el despacho de `haril` sin subcomando a la consola y la copia de la extensión por el instalador. Falta ejecutarla en una terminal real (ver Desvíos).

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
