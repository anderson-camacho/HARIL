# Changelog de HARIL, versión mayor 0

Las versiones van de la más reciente a la más antigua. Cada entrada indica la versión, la fecha, el estado y los cambios agrupados en Añadido, Cambiado y Corregido, y cómo se verificó.

---

## 0.22.1

- **Fecha:** 2026-10-24
- **Estado:** estudio de viabilidad de una consola de tres columnas reales, sin alterar la interfaz Pi predeterminada.

### Añadido

- Compositor puro `joinThreeColumns()` en `apps/shell`, con pruebas de dimensiones, truncamiento Unicode, estilos y geometría inválida.
- Documento `apps/shell/ARCHITECTURE.md` con inventario de las dos interfaces existentes y las puertas de compatibilidad antes de integrar Pi en un host visual propio.

### Cambiado

- Se fija una ruta propuesta que reutiliza la TUI y los temas de `apps/shell`; la elección RPC/SDK queda condicionada a probar el Pi instalado por HARIL y sus extensiones.

### Corregido

- Se documenta explícitamente que los paneles del encabezado de Pi no son laterales a toda altura y que `ctx.ui.custom()` y otros métodos de interfaz no se trasladan directamente a RPC.

### Verificación

- Se completaron 283 pruebas del paquete shell, `tsc --noEmit -p apps/shell` y Biome en los archivos editados; la comprobación integral del monorepositorio se repetirá con esta versión.

---

## 0.22.0

- **Fecha:** 2026-10-21
- **Estado:** cambio de idioma de la interfaz propia de HARIL mediante /language; traducción inicial de la barra derecha, con persistencia de preferencia y comunicación de fallos.

### Añadido

- Comando `/language` con selector Español / English y opciones directas `/language es` y `/language en`.
- Persistencia de `ui.locale` a través del CLI, manteniendo la selección anterior si falla el guardado.
- Prueba de etiquetas principales de la barra lateral en ambos idiomas.

### Cambiado

- Etiquetas principales de ruta, modo, proyecto, modelo, avisos, extensiones, sesión y acciones según el idioma configurado.
- README con instrucciones de selección de idioma y límites respecto a mensajes de Pi, modelos y extensiones externas.

### Corregido

- Formato exigido por Biome en la implementación del comando, el panel y sus pruebas.

### Verificación

- En la ejecución previa del CI de Ubuntu pasaron Biome, TypeScript, comprobaciones de arquitectura y dependencias. La suite completa de CI de esta versión requiere confirmación.

---

## 0.21.9

- **Fecha:** 2026-10-21
- **Estado:** guía desde cero de instalación de HARIL en Windows desde PowerShell.
- README: instalar/verificar Node compatible usando winget o el instalador oficial; instalar Corepack si hace falta; ejecutar el script remoto completo sin clonar repositorio; verificar HARIL/Gentle Shell; resolver PATH y problemas frecuentes; ejecutar haril update.
- **Sin cambios en el instalador ni en las dependencias**: únicamente documentación y versión de paquete, para respetar las verificaciones automáticas del repositorio.

---

## 0.21.8

- **Fecha:** 2026-10-20
- **Estado:** visibilidad de alertas y estado de extensiones en el panel HARIL aunque el menú de acciones sea largo.
- Los avisos, extensiones y orquestación se muestran antes del menú de acciones para que el recorte por altura no los oculte. Cada grupo muestra hasta tres filas y ofrece acceso al visor completo cuando quedan más.
- La tarjeta de orquestación se despliega por defecto al seleccionar esa área; otras tarjetas conservan su estado plegado/extendido.
- El visor de detalles presenta todos los estados de extensiones que Pi comunique, sin confundir estados publicados con paquetes instalados. Mantiene el menú `/haril` como alternativa accesible.

---

## 0.21.7

- **Fecha:** 2026-10-20
- **Estado:** corrección de regresión de HARIL 0.21.6: los controles de cada área vuelven a estar disponibles para clic dentro del panel lateral derecho.
- Bloques plegables con ▶/▼ para acciones, warnings, extensiones, estado y orquestación; sin widgets grandes en el centro. Menú completo siempre accesible con `/haril`.
- `Estoy en: <ruta>` en el panel; ojo `◉` discreto que cambia de teal (reposo) a amarillo (runtime/ejecutores activos) o rojo (contexto ≥85% o capacidad de ejecución ≥80%).
- Retira `Alt+F`, reservado por Pi `tui.editor.cursorWordRight`; `/haril-focus` abre el visor, `Alt+R` muestra/oculta panel y abre el menú de acciones en terminales pequeñas.
- El historial de Pi sigue desplazándose de forma nativa y puede mostrar líneas de arranque; HARIL no puede moverlas fuera del historial sin una modificación de Pi.

---

## 0.21.6

- **Fecha:** 2026-10-21
- **Estado:** panel de estado a la derecha en el encabezado TUI, con warnings reales y resumen de orquestación según la sección activa.
- En terminales grandes muestra la columna a la derecha del todo; `Alt+R` alterna mostrar/ocultar; `Alt+F` o clic abre el visor enfocado. En terminales pequeñas se oculta automáticamente y `Alt+R` abre el detalle.
- Captura avisos reales emitidos por el registro de proveedores de HARIL, incluido `HARIL provider cliproxy: unreachable`, junto con errores locales y fallos de log. Los nombres de extensiones impresos por Pi al iniciar no están disponibles a través de su API.
- El módulo grande que interrumpía el chat se elimina del widget vertical permanente; comandos y detalles se mantienen a través del menú /haril, las áreas y los visores existentes.
- **Límite de la API de Pi:** esta columna se ancla dentro del encabezado de HARIL, no ocupa toda la altura del historial del chat. Un split-pane real de toda la terminal requeriría un host TUI propio.

---

## 0.21.5

- **Fecha:** 2026-10-21
- **Estado:** borde cian/teal y encabezado uniforme para el selector de áreas Alt+H.
- El selector respeta el ancho disponible, no cambia las flechas ↑/↓, Enter o Esc, y mantiene compatibilidad con ←/→.

---

## 0.21.4

- **Fecha:** 2026-10-20
- **Estado:** instaladores para usuarios sin clonar repositorio y actualizador con fuente remota por defecto.
- Windows: `scripts/install-online.ps1` con ZIP de GitHub, respaldo por Git (HTTP/1.1, reintentos), instalación en perfil de usuario y registro PATH de usuario preservando el tipo de registro. Acompañante Gentle Shell standalone opcional si falta, sin modificar configuraciones existentes.
- macOS/Linux: `scripts/install-online.sh` con misma prioridad ZIP/Git, instalación de usuario y acompañante opcional.
- `haril update`, `haril update --check`, `haril update --yes` consultan main automáticamente. `--from <carpeta>` permanece para la instalación local avanzada. Git usa reintentos y reporta timeouts explícitos.
- **Límites:** no hay releases firmadas, artefacto binario propio ni rollback; la fuente de main temporal aún requiere compilar desde código descargado; todas las dependencias necesitan acceso a sus orígenes.

---

## 0.21.3

- **Fecha:** 2026-10-19
- **Estado:** columna izquierda de estado integrada al encabezado de la terminal.
- El modo ACTION/CONSULT/PLAN/DELEGATION, los estados de extensiones efectivamente reportados y las advertencias (incluidos errores del log de actividad) tienen un panel ordenado en el encabezado persistente.
- Se aprovecha mejor la anchura en pantallas grandes; las terminales pequeñas mantienen la vista compacta sin consumir más espacio del chat.
- La lista de nombres de extensiones cargadas que Pi imprime al iniciar sigue perteneciendo al historial de Pi: el API de estado de extensiones no proporciona ese inventario.

---

## 0.21.2

- **Fecha:** 2026-10-19
- **Estado:** mejoras visuales y de navegación de la consola HARIL.
- El selector `Alt+H` utiliza flechas **↑/↓** acordes con la lista vertical; conserva **←/→**, `Enter` y `Esc`.
- La cabecera muestra un logotipo tipográfico estático sin parpadeos en terminales con espacio suficiente; pantallas pequeñas conservan la marca compacta.
- En **TOOLS** y **EVERYWHERE** aparece **Registro de actividad reciente** (`L`), que consulta los últimos 40 registros de 24 horas mediante `haril usage log` y los muestra en un visor de pantalla completa. También se encuentra en el menú `/haril`.

---

## 0.21.1

- **Fecha:** 2026-10-19
- **Estado:** actualización nativa local implementada; actualización desde releases y rollback siguen pendientes.

### Añadido

- `haril update --check` compara la versión instalada con un checkout local y no modifica archivos.
- `haril update --from <ruta> [--yes]` actualiza desde un checkout local.
- `haril update --main [--check | --yes]` consulta el SHA más reciente de la rama de desarrollo en GitHub mediante un clon temporal, sin modificar el worktree local.

### Cambiado

- Documentada la diferencia entre un checkout local, el canal de desarrollo `main` y una release oficial.
- Los detalles completos de la consola ahora se abren en un overlay de pantalla completa que se cierra con Escape.

### Corregido

- La actualización se rechaza con un runtime activo, un estado de lease desconocido o una versión fuente inferior.

### Verificación

- Añadidas pruebas herméticas del comando: lectura de versiones, confirmación, runtime, fallos y versiones no válidas. Validación integral pendiente de CI.

---

## 0.21.0

- **Fecha:** 2026-10-19
- **Estado:** Cambios de consola y barreras de delegación incluidos en esta versión en preparación. La verificación integral y la prueba manual en Windows siguen pendientes; el idioma español configurable todavía no está implementado.

### Añadido

- Selector de áreas de la consola con `Alt+H`: las flechas eligen, Enter abre y Esc cancela, sin sustituir la navegación por ratón.
- Entrada explícita de proyecto, fuente y revisión del plan, y metodología con instrucciones completas; el workflow conserva una instantánea y las huellas de ese contenido.
- Comprobación previa de implementación que informa si el proyecto y las capacidades permiten continuar, sin iniciar el workflow ni ejecutar pruebas durante esa comprobación.

### Cambiado

- Cabecera de la consola compacta con la marca `HARIL ◉`, conservando la información operativa.
- Selector de modelos de la delegación: muestra los proveedores y modelos conectados compatibles e indica de forma segura por qué una opción no está disponible; las opciones incompatibles con el runtime no se guardan.

### Corregido

- Cierre y cancelación con Esc en ajustes y menús, con restauración del foco; Delegation Settings acepta flechas, desplazamiento y Enter para editar, incluidos eventos de teclado Kitty.
- El auditor queda como hijo del delegador y hermano del ejecutor evaluado; la tarea auditada se registra por separado del parentesco estructural.
- La implementación falla de forma cerrada si falta la comprobación previa; la aprobación y el cierre exigen evidencia del host de un commit del intento y una prueba ejecutada con éxito, no solo una afirmación del agente.

### Verificación

- Para este incremento: 33 pruebas de los scripts de versión y la prueba de versión de HARIL pasaron; `pnpm run check:version`, Biome de los cinco archivos de versión y `git diff --check` terminaron con código 0. El Node local es 24.19.0, por debajo del mínimo declarado de 24.21.0.
- Pasaron las pruebas focalizadas de la consola, la entrada de planes, la jerarquía de auditoría y las barreras de evidencia, junto con las comprobaciones de Biome y tipos registradas para esas unidades de trabajo.
- La última suite completa, en `6c8a930`, terminó con 2.608 pruebas aprobadas y 3 fallidas. La suite completa aún no se ha repetido sobre `c595af3`; la prueba manual de Windows sigue pendiente. No se declara verificación integral en verde.

---

## 0.20.2

- **Fecha:** 2026-10-18
- **Estado:** Corrección de una prueba que fallaba a veces en la CI de Linux; el producto no cambia.

### Corregido

- `integrations/pi-console/tests/fake-cli.ts`: al terminar cada prueba, el CLI falso borraba su carpeta temporal mientras una llamada tardía de la consola (el temporizador de estado o el registro del chat) todavía escribía en ella, y el borrado fallaba con `ENOTEMPTY`. Ahora el borrado reintenta hasta 10 veces con 50 ms de espera. Ocurrió en una de las dos corridas de `ubuntu-latest` del PR #38 (`chat-log-console.test.ts`).

### Verificación

- `corepack pnpm vitest run integrations/pi-console` y `corepack pnpm run check` (con `check-version`): salida 0.

---

## 0.20.1

- **Fecha:** 2026-10-18
- **Estado:** **Parche de 0.20.0: tres arreglos de la escritura en paralelo que encontró el último verificador independiente, y tres fallos de la CI de la PR #38.** Un commit que un comando hacía durante un intento que fallaba o se manipulaba sobrevivía al reintento y llegaba a la rama de integración; un comando podía mover `main` sin que nada lo notara; y las entradas ` *` de la lista de `haril_run` se burlaban con abreviaturas de npm o flags de node. Probado con pruebas automáticas (repositorios git temporales, workflows herméticos que escriben y sondas de cada ataque) y, para la prueba del barrido de arranque, con una sonda en Linux (WSL) sobre el código real; todavía no en una terminal real ni en el carril real (fase F8 de la delegación).

### Añadido

- **Migración `0016`:** `worktrees.verified_sha`, el último commit verificado de la rama de un ejecutor: donde empezó el paso (el commit base con el trabajo de sus predecesores fusionado) y luego cada commit que comprobó el final de un turno con éxito. Vacío para el worktree de integración y para los registros anteriores, que usan su último commit registrado o, si no tienen, el HEAD que encuentran.
- **Eventos `worktree.restored`** (una rama volvió a su commit verificado: la rama y el commit que tenía HEAD y el commit al que volvió) **y `base.moved`** (la rama base cambió durante un turno: su commit anterior y el nuevo, cuántos comandos corrió el turno y si se detuvo el workflow).

### Cambiado

- Una entrada tuya de `delegation.commands.allow` terminada en ` *` admite solo argumentos posicionales: ninguno que empiece por `-` (tampoco `--` solo), que lleve una ruta absoluta en cualquier parte (`/` o `\` al principio o tras `=`, una unidad con `:` y separador, `C:` relativo al principio, `\\`) ni un segmento `..`. Las entradas exactas de la lista por defecto no cambian.

### Corregido

- **Un commit de un comando sobrevivía a un intento fallido o manipulado** (verificador): solo el camino del éxito devolvía la rama del paso, y el reintento tomaba su punto de partida del HEAD que encontraba, así que un `outside.txt` confirmado por un comando acababa en la rama de integración. Ahora cada turno de un paso, también el de su auditor, empieza en el último commit verificado de la rama, y si un comando la movió en un turno cuyo final nunca corrió (una caída) vuelve allí antes; un turno que no tiene éxito, que se manipuló o cuyo commit falla deja la rama en ese commit (HEAD vuelve a nombrar la rama del paso antes de moverla, así que ninguna otra rama se mueve), y un éxito cuya rama ya no contiene el commit de inicio no confirma nada. El turno del auditor siempre termina en el commit verificado del paso, y un turno con el cerrojo de integración (el delegador, el auditor final) conserva solo las fusiones de HARIL: el commit de un comando se quita antes de `haril_merge` y al terminar el turno, y una fusión que espera sus conflictos se abandona si la rama se movió debajo de ella.
- **Un comando podía mover la rama base sin que nada lo notara** (N0: apunta el archivo `.git` del worktree al repositorio principal, hace commit y lo deja como estaba, así que la comprobación de manipulación no ve nada). Ahora el turno lee el commit de `refs/heads/<base>` al empezar y lo compara al terminar: si cambió y el turno corrió algún comando, el turno falla, nada se confirma, queda `base.moved` con el commit anterior y el nuevo, y el workflow termina fallido con un motivo que dice cómo revisar los commits (`git log <anterior>..<nuevo>`) y cómo devolver la rama si no son tuyos (`git branch -f main <anterior>`, o `git reset --keep <anterior>` donde `main` está abierta). HARIL nunca la mueve: puede que el commit sea tuyo. Si el turno no corrió ningún comando, solo queda el evento.
- **Las entradas ` *` se burlaban** (verificador): `--prefi=../b` (npm acepta la abreviatura de `--prefix`), `--root=C:/other` (la ruta absoluta solo se buscaba al principio del argumento) y `node *` con `-p`, `--print` o `-r./x`. Ver Cambiado.
- **CI, Ubuntu:** la prueba del barrido de arranque registraba sus procesos sin los ticks y el id de arranque que un intento real registra en Linux (migración `0012`). Sin ellos solo se compara por reloj, así que matar al huérfano dependía de la ventana de 100 ms y el pid reutilizado quedaba como dudoso en vez de conservado. Ahora los registra como un intento real, y cada aserción explica un fallo (inicio registrado y observado, ticks de ambos lados, veredicto del plan y recuento del barrido). La protección contra matar un pid reutilizado no cambia.
- **CI, Windows:** `addWorktree` fallaba con `is a missing but already registered worktree` al rehacer un worktree cuya carpeta se borró: la carpeta temporal del runner se nombra con un nombre corto 8.3 (`RUNNER~1`), git guarda la ruta real y, sin la carpeta, la comparación no los igualaba. Ahora una ruta que no existe se resuelve por su carpeta existente más profunda, y si git todavía guarda un registro de esa ruta sin carpeta se poda con `git worktree prune --expire now` y se intenta una vez más (nunca `add -f`).
- **CI, Windows:** la prueba de `haril workflow demo` que corre cinco demos pasaba de los 15 s en el runner: su archivo tiene ahora un minuto por prueba, sin cambiar lo que comprueba.

### Límites conocidos

- Sin sandbox (N0): una entrada ` *` sigue pasando sus argumentos posicionales al programa; `node *` ejecuta cualquier script del worktree, que escribieron los agentes, y un ejecutor de pruebas puede leer un argumento como archivo o filtro. Usa ` *` solo con programas cuyos argumentos posicionales aceptes de un agente.
- Si el usuario hace commit en `main` durante un turno que corrió un comando, el workflow se detiene igual: HARIL no puede saber quién lo hizo, y prefiere parar a seguir sobre una base que no conoce.
- Negar una tilde seguida de un dígito (los nombres cortos 8.3, como `GIT~1`) también niega nombres legítimos como `src/a~1.ts`: falla cerrado, a propósito.
- Un comando que en un turno caído dejó el worktree de un paso en otra rama hace que ese worktree no se pueda reutilizar (`addWorktree` lo rechaza) y el paso falla hasta escalar: falla cerrado, sin tocar otras ramas.

### Verificación

- `corepack pnpm run check`, `corepack pnpm test` (vitest: 220 archivos y 2 578 pruebas, 1 omitida; `test:stop`: 4 archivos y 17 pruebas, 1 omitida; `test:scripts`: 122), `npm run build` y `corepack pnpm run test:stop` en verde, en Windows.
- Pruebas nuevas, cada una vista fallar antes de pasar: en un workflow hermético, un comando confirma `sneaked.txt` en el primer intento del ejecutor, que luego falla o tiene su `.git` reescrito (con el código de 0.20.0 el archivo llegaba a la rama de integración; ahora no, y el reintento parte del commit verificado); un comando del auditor y del delegador confirma en su rama (se deshace y las fusiones de HARIL se quedan); un comando confirma en `main` por un `.git` reapuntado (con 0.20.0 el workflow terminaba completado; ahora falla con el motivo `base_moved:` y `main` sigue donde la dejó el comando); con git real, el reintento y el auditor tras una caída empiezan en el commit verificado, el final de cada turno devuelve la rama, un commit del usuario en `main` sin comandos solo queda registrado; una sonda por cada forma de burlar ` *`; la migración `0016` en la base nueva y en el almacén.
- CI: la prueba de `addWorktree` con un worktree nombrado por una unión y luego borrado falló aquí con el mismo error que el runner de Windows y ahora pasa, también con la resolución por carpeta desactivada (el reintento basta solo). La prueba del barrido de arranque no corre en Linux aquí: una sonda en WSL (Ubuntu 20.04, Node 22) sobre `process-control.ts` y el supervisor reales mostró que sin ticks el pid reutilizado quedaba dudoso, y con ticks se mata al huérfano y se conserva el reutilizado. El tiempo de la demo no se reproduce en local (2,6 s).

---

## 0.20.0

- **Fecha:** 2026-10-18
- **Estado:** **Escritura en paralelo: en un proyecto git, los ejecutores de un workflow cambian código, cada uno en su propio worktree creado desde `main` (o la rama que nombres), y el delegador integra su trabajo en la rama `haril/<workflow>/integration`, que revisas tú; nada se fusiona en `main` ni se sube.** Dos tareas que pueden escribir el mismo archivo nunca corren a la vez (en un workflow ni entre workflows del mismo proyecto); un conflicto de fusión le llega al delegador como datos y lo resuelve él. La configuración de 0.19.0 ya llega a la escritura: la lista de comandos de `haril_run`, su tiempo máximo y su límite de salida, la rama base y el número de escritores salen de `haril.json`. Esta versión integra la fase F8, construida en paralelo con la F7, y corrige los fallos que encontró el verificador independiente de F8, entre ellos uno grave: un nombre corto 8.3 (`GIT~1`) dejaba reescribir el archivo `.git` de un worktree y llevar el commit del turno a `main`. Probado con pruebas automáticas (repositorios git temporales, workflows herméticos que escriben en paralelo, en secuencia y con un conflicto, y sondas de los ataques del verificador) y con la CLI compilada sobre un proyecto git temporal con agentes simulados; el carril real `npm run e2e:writes-real` pasó en la rama de F8 antes de la integración y no se repitió aquí; todavía no en una terminal real ni en un proyecto con dependencias (fase F8 de la delegación, ADR-0021).

### Añadido

- **Un worktree por ejecutor (3.10.2):** cada hilo de ejecutor trabaja en su worktree y su rama `haril/<workflow>/step/<parte>-<paso>-<hash>`, creada desde el commit de la rama base que el workflow fijó al empezar (`base_sha`). Una tarea que depende de otra, o que el Core ordenó detrás de ella dentro de una misma asignación, nace con el commit aprobado de su predecesora fusionado (P13). Con `core.longpaths=true`, sin hooks del proyecto, sin Git LFS, sin ayudantes de credenciales y sin ninguna operación remota (`protocol.allow=never`).
- **`write` y `edit` para los ejecutores (las formas de Pi):** los sirve el host, no Pi, solo dentro del worktree y de la superficie declarada (`files.write`). El `PathGuard` niega rutas absolutas, unidades, recursos UNC, flujos alternativos, `..`, `.git`, `.haril`, `.pi`, archivos con aspecto de secreto, nombres reservados de Windows, nombres cortos 8.3 (una tilde y un dígito) y cualquier ruta fuera de la superficie; luego comprueba el disco: ningún enlace simbólico, unión ni enlace duro, el nombre real de cada componente igual al pedido, la ubicación real dentro del worktree y la identidad del archivo abierto. Al terminar el turno se hace commit solo de lo cambiado dentro de la superficie, y lo demás se descarta.
- **`haril_run`:** un comando de la lista permitida, ejecutado por el host en el worktree del agente, como argv y nunca por un shell (en Windows, npm, pnpm, yarn y los atajos de paquetes de Node corren como `node <script>`; cualquier otro `.cmd` o `.bat` se rechaza), con un entorno limpio sin claves, tiempo máximo que mata el árbol del comando, límite de salida (el final de cada flujo) y el resultado como datos. Su proceso queda registrado con el intento (migración `0015`), así que la parada de emergencia, `haril workflow stop`, el segundo Ctrl+C y el barrido de arranque lo matan, y termina con su turno. El auditor y el delegador lo usan en solo lectura: lo que un comando cambia se descarta tras su turno.
- **`haril_merge {localId}`, `haril_merge_continue` y `haril_merge_abort`:** el delegador fusiona cada paso aprobado en la rama de integración (`git merge-tree --write-tree` antes, `git merge --no-ff` después). Un conflicto vuelve con los archivos en conflicto; el delegador los corrige con su propio `write` o `edit` (exactamente esos archivos, como rutas literales) y `haril_merge_continue` hace el commit, rechazado mientras quede un marcador de conflicto. `haril_report` con estado `done` se rechaza mientras quede trabajo aprobado sin fusionar.
- **Cerrojos de superficie de punta a punta:** dos escritores cuyas superficies pueden solaparse nunca corren a la vez, tampoco entre workflows que escriben en el mismo proyecto, aunque uno de ellos espere al humano; los turnos de delegador y el auditor final de un workflow usan su worktree de integración de a uno (cerrojo `integration:<workflow>`).
- **`haril workflow start` en un proyecto git:** fija la rama base y su commit: `--base <rama>`, si no `delegation.git.baseBranch`, si no `main` o la rama por defecto detectada si se llama distinto (la que nombra `origin/HEAD`, `init.defaultBranch` o `master`); `--read-only` impide escribir. Sin git, o si la raíz no es la raíz de un repositorio, el workflow sigue de solo lectura y lo dice. Una rama configurada que el repositorio no tiene detiene el arranque.
- **La rama de integración a la vista:** `WorkflowSnapshot v1` gana un bloque `git` opcional (rama base y su commit, rama de integración y su último merge, pasos fusionados, ramas con trabajo sin fusionar, worktrees vivos) y `haril workflow show` muestra `branch     haril/<workflow>/integration (from main …; N steps merged)`.
- **Limpieza:** el worktree y la rama de un paso se borran al fusionarse; al terminar el workflow, el runtime (y el barrido de arranque) quita sus worktrees y su carpeta; la rama de integración se queda si tiene trabajo, y eso lo decide git, no el almacén. HARIL solo borra ramas `haril/`.
- **Configuración de la escritura en `haril.json`:** `delegation.commands.allow` (la lista por defecto, ahora visible en `haril config get` y en la consola; una lista vacía no permite ningún comando), `delegation.commands.timeoutMs` (5 minutos) y `delegation.commands.outputMaxBytes` (16 384), que el runtime lee al arrancar; `delegation.git.baseBranch` (sin fijar: detecta) con su validación, `haril config get|set` y el grupo GIT de Delegation settings en `TOOLS`.
- **Migraciones `0014` y `0015`:** la tabla `worktrees` y la tabla `run_commands` (los procesos de `haril_run`).
- **`npm run e2e:writes-real`:** el carril real de la escritura en paralelo.
- **Agentes simulados que escriben:** en un workflow que escribe, `fake:execute` escribe su superficie, `fake:audit` corre el comando de `[fake:run=…]` y `fake:delegate` fusiona y resuelve conflictos; directivas `[fake:common=<ruta>]` y `[fake:own-files]`.

### Cambiado

- Un workflow que escribe deja correr a la vez tantos escritores como ejecutores (3.9.4: el tope de 1 era hasta que existieran los worktrees), salvo que `haril.json` fije `limits.maxConcurrent.writers`, que ahora hereda de `limits.maxConcurrent.executors` y se muestra así en `haril config get` y en la consola.
- Los turnos que solo leen de un workflow que escribe leen el worktree de integración (la base más lo integrado), no tu copia de trabajo.
- El adaptador de Pi deja lanzar las herramientas de worktree de cada rol, según la tabla de arquetipos; las propias de Pi (`bash`, `grep`…) nunca.
- `haril workflow start` es asíncrono (detecta la base antes de encolar).
- La lista por defecto de `haril_run` tiene solo entradas exactas; una entrada tuya terminada en ` *` admite más argumentos salvo los que cargan código o cambian dónde corre el comando (`--import`, `--require`, `-r`, `--loader`, `--config`, `-c`, `--prefix`, `-C`, `--dir`, `--cwd`, `--script-shell`, `--userconfig`, `--globalconfig`, `--node-options`, `--eval`, `-e`, `--inspect…`), rutas absolutas y `..`.
- Cada orden de git que HARIL ejecuta sobre un worktree nombra su propia carpeta de git (`--git-dir`, `--work-tree`) y trata cada ruta como literal (`GIT_LITERAL_PATHSPECS=1`).
- La integración de F8 sobre F7: los límites, la instantánea del contexto, el modelo del orquestador y las paradas por defecto de `haril.json` conviven con la base, `--base`, `--read-only` y el arranque asíncrono de F8 en `haril workflow start`, y con los worktrees en `haril start`.

### Corregido

- **Grave: un nombre corto 8.3 burlaba la negación de `.git`** (verificador de F8). NTFS da a `.git` el alias `GIT~1`; un `write` a `GIT~1` reescribía el archivo `.git` del worktree y el commit del turno caía en `main`. Ahora el `PathGuard` niega una tilde con un dígito en cualquier componente y en cualquier sistema; el escritor y el lector confinados, y el guardián de lectura de Pi, comparan el nombre real de cada componente con el pedido; toda orden de git sobre un worktree usa su propia carpeta de git, nunca la que dice su archivo `.git`; ese archivo debe seguir igual al terminar cada turno (si no, el turno falla, su trabajo se descarta, el archivo se restaura y queda el evento `worktree.tampered`), y el commit del turno exige que HEAD sea la rama del paso.
- **`npm test *` y `pnpm test *` de la lista por defecto ejecutaban código del agente o de otra carpeta** (`--import ./docs/evil.mjs`, `--prefix`, `-C ..`). Ver Cambiado.
- **Un comando de `haril_run` sobrevivía a su turno, a la parada de emergencia y al barrido**, y un proceso que dejaba podía retener su salida hasta el tiempo máximo: ahora se registra, se mata con su turno y su salida se cierra tras un breve drenaje.
- **Git LFS contactaba al remoto** al crear un worktree con los filtros LFS globales del usuario (`POST /info/lfs/objects/batch`): cada orden de git vacía los filtros LFS, los ayudantes de credenciales y los protocolos permitidos, con `GIT_LFS_SKIP_SMUDGE=1`.
- **El commit del turno no se comprobaba contra la superficie:** lo que un comando dejaba preparado o confirmado entraba en él. Ahora se quita del índice antes de añadir y, tras el commit, todo lo que ganó la rama debe estar en la superficie; si no, la rama vuelve a como estaba, el turno falla y queda el evento `worktree.outside_surface`.
- **El delegador no podía resolver algunos conflictos:** nombres con `[]{}!` o caracteres no ASCII no coincidían con nada, y `.env.example` o `.npmrc` se negaban como secretos. Ahora los archivos en conflicto se comparan como rutas literales, y un nombre con aspecto de secreto se admite si el repositorio lo sigue (`git ls-files`), nunca bajo `.git`, `.haril` o `.pi`.
- **Un encabezado Markdown subrayado con siete `=` contaba como marcador de conflicto** y bloqueaba `haril_merge_continue` para siempre: ahora solo cuentan las líneas `<<<<<<< ` y `>>>>>>> `.
- **Los cerrojos entre workflows olvidaban a los escritores en curso de un workflow en espera del humano.**
- **El barrido podía borrar la rama de integración** tras una caída entre el registro de la fusión y el de su commit: ahora lo decide git.
- Fuera de Windows, la superficie distingue mayúsculas (`SRC/a.ts` no está en `src/**`); un worktree creado pero no registrado por una caída recibe en el siguiente turno los commits de sus predecesoras que le falten; la cabecera de `worktrees.ts` dice qué pasos empiezan con el trabajo de otro.
- La prueba «drains a larger queue» fallaba a veces bajo la carga de toda la suite: su tiempo máximo de intento (400 ms) cortaba turnos sanos; ahora 2 s, con las mismas aserciones exactas.

### Valores provisionales

- Rama de integración `haril/<workflow>/integration` (P12); toda rama nace de la base (P13).
- Lista permitida por defecto, 5 min y 16 KiB mientras `delegation.commands` no diga otra cosa; los tres valores ya se configuran.
- Worktrees en `<datos>/worktrees/<hash>/<hash>`: git en Windows no admite la carpeta de un worktree de más de unos 240 caracteres.
- Commits de HARIL con la identidad `HARIL <haril@users.noreply.invalid>`, sin hooks del proyecto.
- Sin sandbox (N0): un comando permitido ejecuta el código del proyecto, el que escribieron los agentes, con los permisos del usuario.

### Verificación

- `corepack pnpm run check`, `corepack pnpm test` (vitest: 220 archivos y 2 556 pruebas, 1 omitida; `test:stop`: 4 archivos y 17 pruebas, 1 omitida; `test:scripts`: 122), `npm run build` y `corepack pnpm run test:stop` en verde. Dos corridas anteriores de toda la suite fallaron solo al borrar la carpeta temporal de una prueba que ya había pasado (EPERM en Windows mientras un proceso matado la soltaba, en `host-commands.test.ts` y en «kill ends a hung Pi»); esas limpiezas ahora reintentan y la sonda del proceso huérfano corre fuera de la carpeta.
- Pruebas nuevas, cada una vista fallar antes de pasar: la lista de comandos, el tiempo y el límite de salida de `haril.json` en `runtimeDelegationOf` y en un workflow por la CLI (`node --version` solo pasa con la lista configurada); `git.baseBranch` (validación, `config set`, la consola y la precedencia `--base` > archivo > detección, con el arranque detenido si falta la rama); los escritores que heredan de los ejecutores salvo que se fijen; `GIT~1` y los demás nombres cortos en los dos guardianes léxicos, el alias 8.3 real en este volumen (el escritor confinado reescribía `.git` antes del arreglo) y el enlace duro; el archivo `.git` reescrito a mano durante un turno (el turno falla, el archivo vuelve, `main` no se mueve) y HEAD en otra rama; cada sonda de `npm test *` y `pnpm test *`; el aborto de un comando, su proceso informado y la respuesta que no espera a un huérfano; los procesos de comandos en el almacén y una parada de emergencia que mata el comando de un auditor en un workflow; un servidor LFS en loopback que no recibe nada; un archivo fuera de la superficie preparado y otro confirmado por un comando; `app/[id]/page.tsx`, `café.md`, `docs/{a,b}!.md` y `.env.example` como archivos en conflicto; un encabezado setext; un escritor en curso de un workflow en espera del humano; el barrido con una rama de integración que el almacén no registró; la superficie con mayúsculas fuera de Windows. También se cubrieron el rechazo de `haril_report done` con trabajo sin fusionar, el `write` de un delegador sin fusión pendiente o fuera de sus archivos en conflicto y el `prepare` que abandona una fusión a medias tras una caída.
- Prueba funcional con la CLI compilada sobre un proyecto git temporal, con `HARIL_HOME`, `--data-dir` y `HARIL_CONFIG` temporales y agentes simulados: con `delegation.commands.allow: ["node --version"]` y `context.perLayer.executor: 400000`, `haril config get` mostró ambos desde `haril.json` (y los escritores heredando 5 de los ejecutores); `haril workflow start` fijó `main`, el workflow escribió dos pasos en sus worktrees, los auditores corrieron `node --version` dos veces (código 0), la instantánea dibujó los ejecutores frente a 400 000 tokens y `haril/<workflow>/integration` quedó con los dos pasos fusionados; `main` no cambió y no quedó ningún worktree.
- Carril real de F8 (CLIProxyAPI, `gemini-3-flash`, en la rama `feat/delegation-writes`, antes de la integración y de estos arreglos): 61 s, 9 turnos, 131 537 tokens; rama de integración con 4 archivos (+20 −2) y `node --test` 4 de 4; `main` sin cambios. No se repitió sobre la versión integrada.

---

## 0.19.0

- **Fecha:** 2026-10-18
- **Estado:** **La configuración de la delegación: la sección `delegation` completa de `haril.json`, `haril config get|set`, el contexto y la salida reales de cada agente, la compactación y el nivel de razonamiento por capa, y la sección Delegation settings del módulo `TOOLS`.** Los límites, el contexto por capa (300 000 tokens por defecto), el modelo y el nivel de cada capa, la cuota, el vigilante y las paradas por defecto se leen y se cambian desde la CLI o desde la consola, con clic y teclado; cada agente real recibe por fin la ventana de contexto real de su modelo en lugar de 32 768 tokens (fase F7 de la delegación, ADR-0021, spike S3). Probado con pruebas automáticas, con la extensión compilada y la CLI real sobre una sesión de Pi y un workflow de agentes simulados, y con un turno real por CLIProxyAPI; todavía no en una terminal real.

### Añadido

- **La sección `delegation` completa de `haril.json`** (sección 5): `context` (`compactAtTokens`, 300 000, y `perLayer.<capa>`), `limits` (hijos vivos por hilo, simultáneos por rol, agentes por workflow, relanzamientos y escaladas, tokens y tiempo del workflow, tarea grande, tiempo máximo de un intento), `models` (`layers.<capa>.model` y `.level`, `allow` por capa, `auditorDistinctFromExecutor`), `quota`, `watchdog` (`intervalMs`, `idleStrikesToClose`, `closeResidualImmediately`, que solo admite `true`), `autonomy.defaultStops`, `commands.allow` y `research.folder` (`docs/investigacion`, P18: `haril_save_research` de la consola guarda ahí las investigaciones de CONSULT y PLAN, y rechaza una carpeta que salga del proyecto). Una sola tabla de campos en `@haril/contracts` la valida, da sus valores por defecto y el origen de cada valor: cada problema lleva su ruta JSON, una clave desconocida se rechaza a cualquier profundidad, igual que un nombre de clave (`apiKey`, `managementKey`, `token`…), y `maxAuditRetries` y `maxEscalationsPerTask` no pasan de 1 (anti-reproceso).
- **`haril config get [<ruta>] [--json]`:** un valor o un grupo (por defecto toda la sección `delegation`), cada valor con su origen (`haril.json` o el valor por defecto; un umbral de capa sin valor propio dice que hereda el general). Con `--json`, cada campo trae su valor, su valor por defecto, su origen, su rango y cuándo surte efecto, que es lo que lee la consola. Lee también las demás claves del archivo tal como están.
- **`haril config set <ruta> <valor> [--json]` y `--reset`:** lee el valor según su campo (`5_000_000`, `72.5`, `after_plan, at_end`, `["a","b"]`, `high`, `null`), comprueba el archivo entero con las mismas reglas que todo lector, conserva las demás claves con su orden, la sangría (espacios, tabuladores o una sola línea) y los finales de línea, y escribe en un archivo temporal que renombra sobre `haril.json`; con `--reset` el valor vuelve a su valor por defecto y desaparecen los grupos que quedan vacíos. Solo cambia la sección `delegation` y se niega a escribir un archivo que contenga una clave. Crea el archivo si no existe.
- **`haril doctor` comprueba la sección `delegation`** (P10): «ok» con su origen, o «error» con cada problema y su ruta.
- **El contexto y la salida reales de cada agente (spike S3):** el runtime pasa a Pi la ventana de contexto y la salida máxima del modelo según el catálogo vivo de los proveedores (por ejemplo 1 048 576 y 65 536 para `gemini-3-flash`); 32 768 y 4 096 quedan solo como respaldo documentado para un modelo que el catálogo no conoce.
- **Compactación por capa:** cada intento escribe en `runs/<run>/agent/settings.json` `compaction.reserveTokens = max(16384, ventana − umbral de su capa)`, así que Pi compacta en el umbral (si la ventana es menor, manda la ventana). El umbral es el que el workflow guardó al empezar, si no el de `haril.json`.
- **Nivel de razonamiento por capa:** `models.layers.<capa>.level` llega a Pi como `--thinking <nivel>`, ajustado al nivel más cercano que publique el modelo como lo hace Pi, y el puente registra el modelo con sus niveles publicados para que Pi lo mande al proveedor como `reasoning_effort` (P27). Un modelo sin niveles publicados corre sin nivel; sin nivel configurado se usa el del gateway.
- **`run.started` registra con qué se lanzó cada agente:** ventana y salida (y si vinieron del catálogo o del respaldo), umbral de compactación, reserva y nivel.
- **Delegation settings en el módulo `TOOLS`** (también `/delegation [<ajuste>]`, `/delegation set <ajuste> <valor>` y el menú `/haril`): una superposición a pantalla completa con todos los valores agrupados (contexto, límites, modelos y niveles, cuota, vigilante, autonomía, comandos, investigación), cada uno con su origen, su rango y cuándo surte efecto. Un clic o Enter lo cambia en los diálogos de Pi: un número se escribe como `400k`, `400,000` o `15 min`; el modelo de una capa se elige entre los modelos de HARIL con credenciales, con su contexto y sus niveles, y después su nivel entre los que publica ese modelo; una lista se edita entrada por entrada. Cada cambio se confirma con el valor anterior y el nuevo y se guarda con `haril config set`; `R` vuelve al valor por defecto; las flechas, RePág/AvPág y la rueda mueven, Esc cierra. En CONSULT se leen pero no se cambian. El panel de `TOOLS` resume los umbrales, los límites, el vigilante y las paradas, y sus detalles listan todos los valores.

### Cambiado

- `haril workflow start` guarda con el workflow los límites y los umbrales de compactación de `haril.json` (P11), usa `autonomy.defaultStops` cuando no dices `--autonomous` ni `--stop-at` (una lista vacía arranca autónomo) y toma el modelo del orquestador de `models.layers.orchestrator.model` si no das `--model` (antes de `HARIL_DEFAULT_MODEL`). Se niega a empezar si la sección tiene problemas.
- El runtime toma al arrancar los límites y la cadencia del vigilante de `haril.json` (con un aviso y los valores por defecto si la sección tiene problemas). Cada elección de modelo de un workflow real fija el modelo configurado de cada capa (nunca se sustituye), aplica las listas permitidas y la regla del auditor, que `auditorDistinctFromExecutor: false` desactiva.
- La instantánea (`WorkflowSnapshot v1`) llena el contexto de cada nodo: lo que ocupa su último intento (la última respuesta de su sesión de Pi, o los tokens del intento de un agente simulado) frente al umbral de su capa, que dibuja la barra de contexto del detalle de `ORCHESTRATION`; y el nivel de cada nodo es el que pidió su capa cuando lo hay.
- La prueba «kill ends a hung Pi at once» compara el tiempo del kill con el plazo de gracia (60 s, cota 10 s) en lugar de 2 s fijos, que una máquina cargada superó dos veces; el presupuesto de 2 s de la parada sigue medido de punta a punta en el carril secuencial `test:stop`.

### Corregido

- **Cada agente recibía 32 768 tokens de contexto y 4 096 de salida** fueran cuales fueran su modelo y su ventana real, así que ninguno llegaba a 300 000 ni compactaba donde debía: `real-agent.ts` nunca rellenaba los límites del modelo (ADR-0021, S3).
- **El panel de proveedores de `haril shell` quedaba en blanco** cuando `haril.json` tenía la sección `delegation`: el shell repetía su propia lista de claves; ahora lee la de `@haril/contracts` y comprueba la sección con las mismas reglas.

### Verificación

- `corepack pnpm run check`, `corepack pnpm test`, `npm run build` y `corepack pnpm run test:stop` en verde (resultados en el informe de la fase).
- Pruebas nuevas, cada una vista fallar antes de pasar salvo las de la consola y la del contexto leído de la sesión de Pi, escritas justo después del código: la sección (valores por defecto que coinciden con los del Core, una sección completa, rutas JSON de cada problema, claves desconocidas, nombres de clave, topes de reproceso), `config get|set` (origen de cada valor, sangría y finales de línea conservados, sin archivo temporal, rechazo sin tocar el archivo, `--reset`, archivo nuevo), `doctor`, la reserva de compactación para varias ventanas, el nivel ajustado como Pi, el lanzamiento de Pi con la ventana real, `--thinking` y la reserva, los niveles que registra el puente, el runtime con los límites y la cadencia configurados, la instantánea del workflow, la sección de `TOOLS` con un `ConsolePi` falso y la CLI falsa (solo los niveles del modelo, el modelo entre los de HARIL, confirmación, `--reset`, CONSULT) y el panel de proveedores del shell con la sección.
- Prueba funcional con la CLI y la extensión compiladas sobre una sesión real de Pi 1.2.0, un `HARIL_CONFIG` y un `HARIL_HOME` temporales: desde `/delegation`, un clic y `2` cambiaron los hijos vivos de un delegador, un clic y `400k` el umbral de los ejecutores, y el nivel del ejecutor solo ofreció los cuatro niveles que publica el modelo; `haril config get` los mostró desde `haril.json`, que conservó sus demás claves y su sangría de 4 espacios, y un workflow de agentes simulados guardó esos valores y dibujó sus ejecutores frente a 400 000 tokens.
- Prueba real por CLIProxyAPI: un turno del orquestador con `cliproxy/Gemini1/gemini-3-flash`, nivel `low` y umbral de 400 000 en su capa arrancó Pi con 1 048 576 de contexto y 65 536 de salida del catálogo, reserva 648 576, y su sesión de Pi registró el nivel `low`. Contra un gateway falso, el nivel `high` del orquestador llegó al proveedor como `reasoning_effort: "high"`.

---

## 0.18.0

- **Fecha:** 2026-10-18
- **Estado:** **La cuota real de CLIProxyAPI, el modelo de cada agente según tarea, cuota y tabla de dificultad, el enfriamiento y el reintento ante 402 y 429, y la tabla de dificultad con su recalibración manual.** `haril quota` muestra el uso de las ventanas de 5 horas y semanal de cada cuenta (o «sin dato»), el runtime elige el modelo de cada hijo del catálogo real de los proveedores con las reglas 80/80/20, un padre puede proponer el modelo de cada hijo, un modelo fijado por el usuario nunca se sustituye, un 402 o 429 enfría el modelo y reintenta el turno una vez en otra cuenta, y sin ningún modelo elegible el workflow termina con `no_capacity`. Además corrige los diez fallos que encontró el verificador independiente de 0.17.0 (fase F6 de la delegación, ADR-0021). Probado con pruebas automáticas, con `haril quota` contra el CLIProxyAPI local (sin clave de gestión: «sin dato») y con un workflow real pequeño por CLIProxyAPI; todavía no con la clave de gestión configurada ni en una terminal real.

### Añadido

- **`haril quota [--json] [--provider <id>]`:** por proveedor y cuenta, el porcentaje usado de la ventana de 5 horas y de la semanal, cuándo empieza de nuevo cada una, lo que dice la regla de cuota de esa cuenta («over 80% of its 5-hour window: avoided», «over 80% of its week: not used», «under 20% left in its 5-hour window: no large task») y los enfriamientos de modelos vigentes. «sin dato» donde no se sabe: un proveedor sin fuente de cuota, la clave de gestión sin poner, un servidor que no responde, una ventana que la cuenta no informa. Guarda la lectura en el almacén (`quota_samples`) cuando hay uno. Sale con 0 aunque no haya dato. Nunca imprime una clave.
- **Lectura de cuota por la API de gestión de CLIProxyAPI (spike S1, P26):** el puerto `QuotaProvider` del Core y su adaptador. `GET <servidor>/v8/management/auth-files` lista las cuentas (y `/v0/management` si `/v8` no existe) y `POST .../api-call` pregunta al endpoint de uso de cada cuenta con su propio token (`$TOKEN$`): Claude (`five_hour` y `seven_day`), Antigravity y Gemini (`retrieveUserQuotaSummary`, el peor cubo de cada ventana; el proyecto se averigua con `loadCodeAssist` si la cuenta no lo nombra) y Codex (sin verificar). Una clave rechazada no se vuelve a probar: cinco intentos fallidos bloquean la dirección unos 30 minutos. Inalcanzable, rechazado o ilegible es «sin dato», nunca una suposición. La referencia de cada cuenta es opaca: ni correo ni nombre de archivo.
- **`delegation.quota` en `haril.json`** (las claves de la sección 5): `managementBaseUrl` (por defecto, el origen del proveedor `cliproxy`), `managementKeyEnv` (por defecto `CLIPROXYAPI_MANAGEMENT_KEY`; la clave vive solo en esa variable, P7), `switchAtPercent5h`, `stopAtPercentWeekly`, `minRemainingPercentForLargeTask` y `maxWaitMs`. Una clave escrita en el archivo o una clave de `delegation` que esta versión todavía no lee se rechazan con su ruta JSON.
- **La tabla de dificultad (`config/difficulty.json`, junto a `haril.json`):** por clase, la tasa de éxito mínima y los modelos que se prueban en orden; por modelo, su nivel de costo; y las tasas de éxito de la última recalibración. Una entrada puede ser un patrón con `*` (`*flash` sigue al modelo en todas las cuentas `Gemini1/…`, `Gemini2/…`). Lo que el archivo no dice toma valores por defecto provisionales (familias de modelos por su nombre habitual, de la más barata a la más cara, sin nada medido).
- **`haril difficulty show [--json]`:** la tabla en efecto, clase por clase, con los modelos recomendados y su nivel de costo y el origen de cada valor (el archivo o el valor por defecto provisional), y las tasas medidas.
- **`haril difficulty calibrate [--yes] [--json]`,** el disparador manual: recalcula las tasas de éxito con la vista `model_stats` (solo ejecuciones reales de ejecutores que un auditor juzgó; las simuladas nunca cuentan), muestra el cambio y escribe el archivo solo con `--yes` (`--apply`, como lo escribe la sección 6, hace lo mismo). Nada más escribe la tabla.
- **El catálogo de modelos de los agentes:** `haril start` lee el catálogo de cada proveedor (la lista `?client_version=` de CLIProxyAPI, con los niveles, el nivel por defecto y la ventana de contexto de cada modelo; si no responde, la lista normal) y lo vuelve a leer cada 10 minutos. Los hijos de un workflow real se eligen de ese catálogo con la tabla de dificultad, las tasas de la última recalibración, las reglas de cuota y los enfriamientos. Un workflow simulado sigue con el modelo del orquestador para todos.
- **Cuota real en las decisiones:** el runtime lee la cuota cada 5 minutos en segundo plano y la guarda en el almacén; cada decisión de modelo lee la lectura más reciente (si tiene menos de 15 minutos) y los enfriamientos. Una cuenta con prefijo responde por sus modelos (`cliproxy/Gemini1/…`, P25); un modelo sin prefijo cuenta como la peor cuenta de su proveedor (P4).
- **El modelo que propone el padre:** `haril_delegate` y `haril_assign` ofrecen un campo `model` opcional por hijo, uno de los modelos que lista el prompt del padre. El Core lo valida (`model_not_allowed`, `model_unavailable`, `quota_blocked`).
- **Enfriamiento y reintento ante errores del proveedor:** un 402 o 429 del gateway deja un enfriamiento del modelo (`model_cooldowns`) hasta el `Retry-After`, o el reinicio de la ventana de cuota que lo bloquea, o una espera fija; un 402 enfría también su cuenta. El turno se reintenta una vez en la misma tarea: en el siguiente modelo o cuenta elegible, o esperando bloqueado (`cooldown`) hasta que termine el enfriamiento. Un error transitorio (5xx, tiempo agotado, flujo cortado) se reintenta una vez con el mismo modelo. Nunca se reintenta después de que se aceptó la llamada decisiva del turno, así que una decisión nunca se aplica dos veces. El intento fallido deja su fila en el registro de consumo, sin modelo servido.
- **El modelo de cada turno se revisa al lanzarlo:** un modelo fijado por el usuario se usa tal cual o el turno espera; nunca se sustituye. El de un padre o de la tabla que ya no cumple las reglas se sustituye por el siguiente elegible (`model.substituted`) o el turno espera. Sin ningún modelo que pueda correr dentro de `maxWaitMs`, el workflow termina `failed` con el motivo `no_capacity: …` y no pregunta.
- **`WorkflowSnapshot v1` con datos reales de modelo y cuota:** `modelSource` (`pinned`, `parent` cuando la propuesta del padre corrió tal cual, si no `table`), `thinkingLevel` cuando el intento lo registró (el nivel por defecto del gateway, porque los agentes no piden ninguno), la cuota de la cuenta de cada nodo, la espera de un enfriamiento y las filas de cuota de la lectura más reciente («sin dato» con su motivo si no se pudo leer). `null` sigue significando «no se sabe». La consola ya dibujaba estos campos y `n/a`.
- **El Broker avisa de cada llamada al proveedor que falla** (el run, su modelo, el código, el estado HTTP y la espera de `Retry-After`) y un 429 lleva el `Retry-After` del proveedor. Sus propias negativas (su presupuesto de tokens) nunca cuentan como del proveedor.
- **Migraciones `0012` y `0013`:** `runs.pid_start_ticks` y `runs.pid_boot_id` (ver «Corregido»), y en `quota_samples` el lote de cada lectura, el tipo y el prefijo de la cuenta y una nota.
- **`--exit-on-stdin-end`** en `haril workflow watch` y `haril workflow tail`: terminan cuando se cierra su entrada estándar (ver «Corregido»).

### Cambiado

- La lista «Models for your children» del prompt de un padre muestra los modelos que recomienda la tabla (con su costo y su estado de cuota), no los 88 del catálogo.
- `no_capacity` de un delegador también termina el workflow, como el del orquestador, y el motivo dice qué no pudo correr.
- Un turno bloqueado por un enfriamiento cuenta como trabajo pendiente: el workflow no se da por atascado mientras espera, y su continuación no corre antes de tiempo.
- `haril workflow show` y `watch` dicen de dónde salió cada modelo (`pinned`, `parent`, `table`).
- `DelegationOptions.models` del runtime puede ser una función que se lee en cada decisión.

### Corregido

Los diez fallos que encontró el verificador independiente de 0.17.0:

- **Caracteres invisibles y bidireccionales en la consola:** `plainText` quitaba las secuencias de escape y los controles C0 y C1, pero dejaba pasar las anulaciones y aislamientos bidireccionales (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F), los caracteres de ancho cero (U+200B–U+200D, U+2060, U+FEFF), los de etiqueta (U+E0000–U+E007F) y los separadores U+2028 y U+2029, con los que un agente puede ocultar palabras o dar vuelta una línea. Ahora aplica la regla de `visibleText` del Core (copiada, porque la consola no puede importar el Core) y los separadores se ven como un espacio; una prueba comprueba que las dos reglas coinciden. El selector de workflow ya no parte un par sustituto al recortar.
- **La hora de inicio en Linux frente a un salto del reloj:** la hora de inicio observada se reconstruía como «ahora menos la edad», así que un salto de NTP o de WSL2 de más de 0,1 s marcaba como reutilizado el pid de un agente vivo, que quedaba vivo y marcado como terminado para siempre. Ahora cada run guarda también los ticks desde el arranque y el id del arranque (`/proc/<pid>/stat` y `boot_id`), que deciden cuando están de los dos lados; si solo un salto del reloj puede explicar la diferencia (un registro sin ticks), el proceso no se mata ni se da por terminado hasta comprobar que salió.
- **La consulta de horas de inicio desbordaba la línea de comandos:** todos los pids iban en un solo comando de PowerShell, que falla en silencio pasados 32 767 caracteres (unos 4600 pids), y todo quedaba sin comprobar. Ahora pregunta de 500 en 500 y un lote que falla deja sin comprobar solo sus pids.
- **El kill del propio runtime:** el kill de emergencia, el que sigue al plazo de gracia y el cierre del vigilante usaban `taskkill /F /T /PID`. Ahora el runtime de Pi recibe el kill verificado del árbol (una foto de los procesos, la hora de inicio comprobada, la raíz primero) y `taskkill /T` queda solo como respaldo documentado para cuando no se puede leer la tabla de procesos.
- **Tiempos relativos congelados en la vista real:** «último progreso» y «próxima revisión» solo se movían al llegar una instantánea, y `haril workflow watch` solo imprime cuando algo cambia. Ahora el temporizador de la consola avanza el reloj de la vista real mientras hay un workflow real a la vista, y salir de la demostración dibuja con la hora actual.
- **El búfer en vivo al cambiar de nodo:** se conservaba, y las líneas tardías se filtraban por la clave del nodo y no por el hijo que las mandó, así que X → Y → X duplicaba cada línea (16 pasaban a 32). Ahora cambiar de nodo vacía el búfer y solo se aceptan líneas del hijo `tail` actual (un id por hijo).
- **Líneas perdidas al cambiar de intento:** cuando un nodo pasaba a un intento nuevo, el lector del anterior se descartaba sin una última lectura y se perdían las últimas líneas de un intento fallido. Ahora se lee hasta el final antes de cambiar.
- **Un hijo `tail` muerto pasaba desapercibido:** ahora, si sale con error, se reinicia tras una espera corta (tres intentos), empezando de nuevo las líneas del nodo, y si sigue fallando la vista en vivo dice «Live feed ended».
- **El orden de los kills:** primero la raíz verificada y después sus descendientes, para que una raíz viva no lance hijos que la foto no vio. Queda documentada la ventana de reutilización de pid entre la foto y el kill en Windows y macOS.
- **El ciclo de vida de los hijos de la consola:** si Pi vuelve a disparar `session_start` sin `session_shutdown` (`/new`, `/resume`, una recarga), los hijos de la sesión anterior terminan antes de crear la nueva. Los hijos `watch` y `tail` reciben una tubería en su entrada estándar y `--exit-on-stdin-end`, así que terminan cuando la consola desaparece.

Y de esta misma fase:

- La prueba de `haril doctor` esperaba el esquema 11 después de las migraciones nuevas.
- La lectura «sin dato» de la fuente de cuota se guarda con su motivo, así que la vista de cuota lo dice en lugar de «No quota data».

### Valores provisionales

Tomados de la propuesta de la especificación (secciones 3.11, 5 y 10.3) o decididos para esta fase:

- P4: un modelo sin prefijo de cuenta cuenta como la peor cuenta de su proveedor; con prefijo, su cuenta (P25).
- P6: el orquestador lo eliges tú; las demás capas, la tabla de dificultad (o la propuesta del padre).
- P7: la clave de gestión va en `CLIPROXYAPI_MANAGEMENT_KEY` (o la variable que nombre `managementKeyEnv`).
- P26: `auth-files` y `api-call` con el campo `data`; se manda también `body` y `authIndex`, como la extensión comunitaria. `/v8/management` primero, `/v0` si no existe.
- La tabla vive en `config/difficulty.json`, junto a `haril.json`, como la sitúa la sección 3.11: se lee, se edita y se revisa como cualquier ajuste; la evidencia queda en el almacén (`model_stats`). Los valores por defecto (familias `*flash-lite`, `*flash`, `*flash-high`, `*sonnet*`, `*pro`, `*opus*` con costos 1 a 4 y tasas mínimas de 0,70 a 0,85) son provisionales.
- La recalibración solo escribe las tasas medidas (`stats`) y su fecha; el orden y los costos los decides tú. El runtime usa esas tasas, no las de `model_stats` en vivo, así que la tabla solo cambia por el disparador manual.
- Enfriamiento sin `Retry-After` ni reinicio conocido: 60 s para un 429 y 15 minutos para un 402. Un turno se reintenta como mucho una vez por cualquier causa del proveedor.
- La lectura de cuota vale 15 minutos; el runtime la renueva cada 5 y el catálogo cada 10; `haril start` espera hasta 3 s el primer catálogo.
- El nivel de un agente es el nivel por defecto del gateway: los agentes no piden ninguno (el puente registra el modelo sin razonamiento).
- `--yes` escribe la tabla; `--apply` hace lo mismo.

### Aplazado

- F7: la sección `delegation` completa (límites, contexto por capa, modelos fijados y permitidos por capa) y su editor en `TOOLS`; hasta entonces el usuario fija el modelo del orquestador y la tabla elige los demás.
- `haril doctor` todavía no comprueba la sección `delegation`.
- El shell anterior (`haril shell`) deja en blanco su panel de proveedores si `haril.json` tiene `delegation`: duplica la lista de claves de primer nivel (`apps/shell/src/data.ts`), fuera de lo que esta fase podía cambiar.
- La lectura real de la cuota con la clave de gestión configurada no se probó: en este equipo `CLIPROXYAPI_MANAGEMENT_KEY` no está puesta.
- El prompt de un padre todavía no muestra la tasa de éxito histórica de cada modelo por clase.
- F8: herramientas de escritura.

### Verificación

- `corepack pnpm run check`: salida 0 (Biome, tipos, capas, pureza, prohibidos, knip, compatibilidad y `check-version` con 0.18.0).
- `corepack pnpm test`: salida 0 en la cuarta pasada completa: Vitest 2338 pasan y 1 omitida en 201 archivos; `test:stop` 17 pasan y 1 omitida (solo Linux) en 4 archivos; `node:test` 122 de 122. Las tres pasadas anteriores salieron 1, cada una por una sola prueba de tiempo con toda la suite en paralelo, y cada una pasó sola: dos veces `agent-pi` («kill ends a hung Pi at once», 2459 ms y 2022 ms frente a un límite de 2000; esa prueba no usa el kill nuevo) y una vez `workflow-runtime` («drains a larger queue…», con un tiempo máximo de intento de 400 ms: 5 intentos agotados en lugar de 1), que pasó tres de tres veces sola.
- `npm run build`: salida 0; `haril --version` muestra 0.18.0.
- `corepack pnpm run test:stop`: salida 0 (4 archivos, 17 pasan y 1 omitida), con el orden nuevo de los kills (la raíz primero).
- Comprobación real de la cuota: `haril quota` con la CLI compilada contra el CLIProxyAPI local (con una carpeta de datos temporal, para no migrar el almacén real) dijo `provider cliproxy  sin dato (not_configured: CLIPROXYAPI_MANAGEMENT_KEY is not set)` y `cooldowns  none`, y salió con 0: en este equipo la variable de la clave de gestión no está puesta, y no se intentó obtener ni adivinar una clave. La lectura con la clave de gestión queda por probar.
- Un workflow real pequeño por CLIProxyAPI (orquestador `cliproxy/gemini-3-flash`, agentes de Pi a través del Broker, la clave del gateway leída del entorno y nunca mostrada, una carpeta de datos temporal): terminó `completed` en 48 s, con 7 turnos y 39 426 tokens. El catálogo real llegó con la lista `?client_version=`: los auditores tomaron `cliproxy/Gemini1/gemini-3-flash` de la tabla (otro modelo que el del ejecutor), cada nodo mostró el nivel por defecto del gateway (`medium`), el ejecutor mostró `parent` (su delegador propuso su modelo) y el orquestador `pinned`. Su instantánea, tras `haril quota`, lista la fila «all accounts · sin dato: not_configured: CLIPROXYAPI_MANAGEMENT_KEY is not set» y la cuota de cada nodo como `null`. El cambio de modelo al cruzar el 80 % con cuota real no se pudo probar sin la clave de gestión; está probado contra un servidor de gestión falso y con agentes simulados.
- Pruebas nuevas, con ROJO observado y después VERDE: el adaptador de cuota contra un servidor de gestión falso en 127.0.0.1 (cuentas y ventanas de Claude, Antigravity con su proyecto y Codex, `/v8` y la vuelta a `/v0`, 401 sin segundo intento, 404, tiempo agotado, nada escuchando, respuestas ilegibles, sin clave); las lecturas, los enfriamientos y el reintento de un turno en el almacén; `haril quota` (sin clave, con cuentas y la regla del 80 %, sin imprimir ninguna clave, y los errores de `haril.json`); `haril difficulty show` y `calibrate` (el cambio, `--yes`, las ejecuciones simuladas fuera); el modelo de cada detalle del gateway (`listModelDetails`); el aviso del Broker y su `Retry-After`; el enfriamiento y el reintento en otra cuenta tras un 429, el reintento de un error transitorio con el mismo modelo, ningún reintento tras una llamada decisiva aceptada (pasaba ya: es una guarda), la espera de un modelo fijado, `no_capacity`, y la revisión del modelo al lanzar un turno; el catálogo y los modelos en vivo; el campo `model` del puente; los campos de la instantánea; y cada una de las diez correcciones (la consola con caracteres invisibles y la paridad con `visibleText`, los ticks de arranque, los lotes de `startTimes`, el kill verificado del runtime de Pi, los tiempos relativos, el búfer en vivo y el id de cada hijo, el final de la lectura de un intento, el reinicio del hijo `tail`, el orden de los kills y los hijos de una sesión que se reinicia, con `--exit-on-stdin-end`). Sin ROJO previo: la prueba de que la consola dibuja los valores nuevos y `n/a` (la consola ya los dibujaba), la vuelta al kill del sistema cuando no se puede leer la tabla de procesos (era el comportamiento anterior) y la comparación de ticks en el kill de Linux, que solo se prueba de forma pura en el Core porque este equipo es Windows.

---

## 0.17.0

- **Fecha:** 2026-10-18
- **Estado:** **La vista de orquestación con datos reales y la vista en vivo de cada agente.** El módulo `ORCHESTRATION` deja de ser una maqueta: sigue el workflow real del proyecto con `haril workflow watch`, que emite una instantánea por cada cambio, y la vista en vivo muestra lo que escribe cada agente y las herramientas que llama, leído de su sesión de Pi con `haril workflow tail`. El módulo `WORKFLOWS` se retira y sus metodologías pasan a `TOOLS`. Además corrige ocho fallos de la parada de emergencia que encontró el verificador independiente de 0.15.0 (fase F5b de la delegación, ADR-0021). Probado con pruebas automáticas, con la CLI y la extensión compiladas sobre un workflow de agentes simulados y con un workflow real pequeño por CLIProxyAPI; todavía no en una terminal real.

### Añadido

- **`haril workflow watch <id>`:** un `WorkflowSnapshot v1` por línea de JSON. Emite uno al empezar y otro por cada aviso del canal de control del runtime (se suscribe como `haril shell`; una ráfaga da como mucho una instantánea cada 250 ms). Sin runtime, revisa el almacén cada segundo (`--interval-ms`) y emite solo si algo cambió, sin contar el reloj, y vuelve a intentar la suscripción, así que también sigue a un runtime que arranca después. Termina tras la instantánea que muestra el workflow terminado (completado, fallido o detenido) o con Ctrl+C. Solo lee. Acepta `--json`, como lo escribe la especificación: cada línea ya es JSON.
- **`haril workflow tail <id> <nodo>`:** lo que hace el agente de un nodo (`o1`, `d1`, `e1`, `a1`, `fa` o el id del hilo) en su intento actual o el último, leído de su sesión de Pi (`runs/<run>/pi/<fecha>_<uuid>.jsonl`, el formato del spike S7): el modelo y el nivel, el prompt del usuario, el tamaño del prompt del sistema, el texto del asistente, cada llamada a herramienta con sus argumentos, cada resultado (`ok` o `error`) y los tokens de cada respuesta, en corto. `--follow` sigue leyendo mientras el archivo crece (una línea a medio escribir espera a su final, y un carácter partido entre dos lecturas se decodifica entero), pasa al siguiente intento del nodo cuando empieza otro turno y termina cuando termina el workflow o con Ctrl+C. `--json` da una línea por entrada (`{at, kind, text, tokensIn?, tokensOut?}`). Lo que escribe un agente se trata como dato: los espacios se pliegan, cada carácter de control se muestra como `?` y el texto se corta a 300 caracteres; nunca va al registro de consumo. Para un agente simulado lo dice: no tiene sesión.
- **`ORCHESTRATION` con datos reales:** la consola lista los workflows del proyecto (`haril workflow list`), sigue el último que corre o espera (si no hay ninguno, el más reciente) con un proceso hijo `haril workflow watch` y dibuja cada instantánea: el resumen del módulo, la vista completa con sus cinco vistas, el detalle del agente (modelo y quién lo eligió, archivos, dificultad, contexto, progreso, próxima revisión, auditoría y memo) y los veredictos del vigilante, que salen de los eventos cuyo texto empieza por el id del nodo. Lo que la instantánea no tiene se dibuja como `n/a` (la cuota y la dificultad de la tabla llegan con F6, el contexto configurable con F7). La selección sigue en su nodo cuando llega la siguiente instantánea. Sin workflow: «No workflows yet. Use /delegate to start one.».
- **Vista en vivo real (`L`):** ejecuta `haril workflow tail <id> <nodo> --follow --json` para el nodo seleccionado y muestra, con lo más nuevo abajo, la actividad de su sesión de Pi (hora, tipo y texto de cada línea, con color por tipo) y la línea de tiempo del nodo (su último progreso y los veredictos del vigilante). Guarda las 500 líneas más recientes. Sin sesión leída dice «Content not available». La transcripción simulada queda solo en la demostración.
- **Elegir el workflow que se sigue:** `P` en la vista completa, el botón `[P Pick workflow]`, el control «Pick the workflow to follow» del módulo, «Pick orchestration workflow» en `/haril` y `/orchestration pick`. Muestra los workflows del proyecto con su estado y su objetivo; al elegir uno sale de la demostración y la vista vuelve a abrirse sobre él.
- **Migración `0011`:** `runs.pid_gone_at`, cuándo se comprobó que el proceso registrado de un run terminó.
- **`ProcessControl`:** `processTable()` (una foto de todos los procesos con su padre y su hora de creación, en una sola consulta: WMI por PowerShell en Windows, `/proc` en Linux, `ps -A` en macOS) y `killProcess()` (un pid validado, sin shell, nunca el propio proceso; en Linux comprueba antes que el pid siga teniendo la hora de inicio de la foto). `startTimes()` dice cuándo no pudo leer el sistema en lugar de dar todos los procesos por terminados. `planTreeKills` del Core decide el árbol que se mata.

### Cambiado

- **`WORKFLOWS` se retira (7.8, P19):** las metodologías («Browse HARIL methodologies») y la lista de comandos de HARIL («Browse HARIL commands») se navegan desde `TOOLS`, con la misma definición completa desplazable; los detalles de `TOOLS` listan las herramientas y las metodologías. Los módulos son cinco: `Ctrl+Shift+1..5`, sin `/workflows`, y el menú `/haril` ofrece esas cinco áreas.
- **El árbol de un agente lo recorre HARIL,** no `taskkill /T`, en la parada de la CLI, `haril workflow stop` y el barrido de arranque: de una sola foto de los procesos, solo los hijos que nacieron a la vez o después que su padre (Windows conserva el pid de un padre muerto en sus hijos, así que un proceso que dice tener por padre un pid reutilizado nació antes que él y se deja en paz), y se mata pid por pid, primero los hijos, con `process.kill`. En POSIX el grupo de procesos de la raíz se va con ella.
- **La hora de inicio se compara con una ventana asimétrica:** hasta 2 s antes de la hora registrada y 100 ms después en Windows y Linux, 1 s después en macOS (cuyo `ps` trunca a segundos). Un pid reutilizado siempre nació después del registrado.
- **Las pruebas con procesos reales** del árbol, el barrido de arranque y el control de procesos corren en `npm run test:stop`, un archivo a la vez: la foto de procesos por WMI tardó más de 10 s con todos los demás archivos en paralelo y 1 s sola.
- La consola puede leer la salida de un comando de HARIL mientras corre (`streamHaril`), sin shell; cierra esos procesos hijos por su propio identificador cuando la vista ya no los necesita y al terminar la sesión.

### Corregido

- **`haril stop --now` después de un `haril stop` normal o de un primer Ctrl+C no mataba a los agentes:** el runtime guardaba solo el primer motivo de parada, así que la orden esperaba, decía «unresponsive» (6,2 s en la prueba del verificador) y la CLI los mataba por su cuenta. Ahora una parada de emergencia mejora la ordenada, cada intento la oye y muere al instante, y la espera de la parada ordenada también despierta con el aviso de la CLI. Un intento que está en el plazo de gracia de su cierre sigue registrado y se puede matar hasta que su proceso termina.
- **Un segundo `stop --now` podía dar un falso «todo limpio»:** las dos barridas miraban solo los runs abiertos (y los que terminaron desde que empezó la orden), así que un run cancelado cuyo proceso sobrevivió al kill quedaba invisible. Ahora cada run con un proceso registrado se revisa en cada parada y en cada arranque hasta que el sistema confirma que el proceso terminó (o que su pid ya es de otro programa); el runtime lo marca al ver salir a su agente. Si la lista de procesos no se pudo leer, la orden lo dice y sale con 1.
- **En el camino «unresponsive», las tareas matadas se cobraban como fallidas:** el runtime cerraba los intentos terminados antes de aplicar la parada en cola, así que un agente que la CLI ya había matado quedaba `pi_exited` y gastaba un intento. Ahora una parada en cola se aplica antes de cerrar los intentos, que terminan `cancelled` sin cobrar.
- **Las 15 pruebas de parada del almacén no corrían:** el `--exclude "**/emergency-stop.test.ts"` de `npm test` también dejaba fuera `integrations/state-sqlite/tests/emergency-stop.test.ts`. La prueba con procesos reales tiene ahora su propio nombre (`emergency-stop-processes.test.ts`).
- **La tolerancia de la hora de inicio era simétrica (±2 s):** un pid reutilizado que nació hasta 2 s después del registrado contaba como el mismo proceso.
- **`taskkill /T` podía llevarse un proceso ajeno** cuyo padre muerto tenía el pid que el sistema dio después a un agente (ver «Cambiado»).
- **El vigilante podía volver a juzgar un intento ya cerrado:** mientras moría el proceso de un intento cerrado por inactivo, el vigilante lo reprogramaba y lo cerraba otra vez en cada vuelta del bucle (o podía decir que seguía activo). Ahora deja fuera los intentos terminados o que se están terminando.
- **La limpieza del carril `e2e:stop-real` tras un fallo** mataba los procesos cuya línea de comandos nombraba la carpeta temporal, y metía esa ruta en una cadena de PowerShell entre comillas simples. Ahora mata el runtime por el identificador de su propio hijo, después ejecuta `haril stop --now` y por último mata solo los pids registrados que siguen teniendo su hora de inicio; la ruta llega a la lista de procesos por una variable de entorno.
- `haril workflow show` y `watch` mostraban la próxima revisión del vigilante de un nodo ya terminado (el almacén conserva la última); ahora solo la tiene un turno vivo.
- `haril workflow tail` decía «system prompt, 0 characters» con una sesión real, que guarda el prompt del sistema en secciones; ahora las cuenta.

### Valores provisionales

Tomados de la propuesta de la especificación (sección 10.3) o decididos para esta fase:

- P19: las metodologías pasan a `TOOLS`, con la lista de comandos de HARIL.
- La vista sigue el workflow más reciente que corre o espera; si no hay ninguno, el más reciente. Elegir otro dura mientras ese workflow siga en la lista.
- `haril workflow watch` se suscribe al canal de control, como `haril shell`: mientras alguien mira un workflow, el runtime no sale por inactividad. Termina con el workflow.
- La ventana de la hora de inicio: 2 s antes y 100 ms después (1 s en macOS).
- La guarda de cada kill: en Linux se vuelve a leer la hora de inicio del pid justo antes; en Windows y macOS leerla exige otro proceso, así que el kill sigue a la foto en el acto.
- Textos de la interfaz en inglés (P22).

### Aplazado

- F6: cuota y dificultad de la tabla (hoy `n/a`); F7: el contexto configurable por capa y la sección de delegación en `TOOLS`; F8: herramientas de escritura.
- El kill que hace el runtime de su propio agente vivo sigue usando `taskkill /T` sobre su hijo (la raíz no puede ser un pid reutilizado mientras el runtime tiene su identificador abierto); recorrer también ese árbol añadiría ~1 s de consulta WMI a cada kill de la parada de emergencia.
- La vista en vivo muestra mensajes completos, como Pi los escribe en la sesión; el texto palabra a palabra (`message_update` por RPC) no llega a la consola.
- La vista de orquestación con datos reales no se ha probado todavía en una terminal real.

### Verificación

- `corepack pnpm run check`: salida 0 (Biome con 590 archivos, tipos, capas, pureza, prohibidos, knip, compatibilidad y `check-version` con 0.17.0). Una primera pasada salió 1: knip señaló dos tipos exportados sin uso fuera de su módulo, que pasaron a ser privados.
- `corepack pnpm test`: salida 0 en la tercera pasada y otra vez sobre la versión final: Vitest 2261 pasan y 1 omitida en 190 archivos; `test:stop` 17 pasan y 1 omitida (solo Linux) en 4 archivos, uno a la vez; `node:test` 122 de 122. La primera pasada salió 1 por dos pruebas de tiempo con toda la suite en paralelo: el `kill` de un Pi colgado tardó 2112 ms (límite 2000) y la foto de procesos por WMI pasó de 10 s; las pruebas con procesos reales del árbol, el barrido y el control de procesos pasaron a `test:stop`. La segunda salió 1 por `agent-pi` («accepts a non-zero exit after agent_settled with a warning»), un paquete que esta versión no toca y que solo pasó 3 de 3 veces.
- `npm run build`: salida 0; `haril --version` muestra 0.17.0.
- `corepack pnpm run test:stop`: salida 0 (4 archivos, 17 pasan y 1 omitida). Con los archivos en paralelo falló una vez la parada de un solo workflow (3,3 s); en secuencia pasó cuatro veces seguidas.
- Prueba funcional A, con la CLI compilada sobre una raíz y un `--data-dir` temporales y agentes simulados: `haril workflow watch` de un workflow que esperaba en `after_plan` emitió 3 instantáneas (en espera, en marcha, completado; de 3 a 12 nodos) y terminó con salida 0, 456 ms después de `haril workflow continue`. `haril workflow tail --follow` siguió el nodo `e1`, que estaba atascado, mientras se escribía su sesión de Pi en el formato de S7 (cada línea en dos mitades, porque un agente simulado no tiene sesión): imprimió cada entrada una sola vez y cuando su línea estuvo completa, y terminó con salida 0 al detener el workflow con `haril workflow stop`.
- Prueba funcional B, con la extensión compilada en un Pi falso (comandos, atajos y widgets registrados, eventos de Pi disparados) y la CLI compilada sobre una raíz temporal, con un workflow de agentes simulados con un nodo atascado: el módulo `ORCHESTRATION` y la vista completa dibujaron ese workflow (su id, su objetivo, `Executor 1 … working`), sin «DEMO» ni ningún dato de ejemplo; `L` sobre `e1` mostró «LIVE · Executor 1 e1» y las líneas de su sesión a medida que se escribían (`read {"path":"src/part-1/shared.ts"}`, `in 1210 · out 48`, la respuesta final); al cerrar la vista terminó el hijo `tail` y al cerrar la sesión el hijo `watch`, y solo quedó el runtime que lanzó la propia prueba.
- Prueba funcional C, un workflow real pequeño por CLIProxyAPI (`cliproxy/gemini-3-flash`, agentes de Pi a través del Broker, la clave leída del entorno por la CLI y nunca mostrada): `haril workflow tail o1 --follow --json` siguió la sesión real del orquestador mientras se escribía (modelo, prompts, `haril_delegate`, tokens, resultado); `haril workflow watch` emitió 15 instantáneas hasta `completed` (5 nodos, 31 140 tokens) y terminó con salida 0, igual que el `tail`. `haril workflow tail e1` mostró después la sesión real del ejecutor (`read {"path":"notes/planets.md"}`, el resultado, la respuesta y sus tokens); el intento de leerla en el momento en que se reclamó encontró aún la sesión sin escribir, por una carrera del propio guion de la prueba. Esta prueba encontró el conteo «system prompt, 0 characters», corregido con su prueba.
- Pruebas nuevas, con ROJO observado y después VERDE: cada una de las ocho correcciones de F3 (la mejora de la parada y el intento en su plazo de gracia, la revisión hasta comprobar el proceso con el almacén, la CLI y el barrido, el orden del camino «unresponsive», la lista de `vitest list`, la ventana asimétrica, el árbol propio con `planTreeKills` y el adaptador, y el vigilante que no vuelve a juzgar); `haril workflow watch` (una instantánea por aviso, el sondeo sin runtime, el final con el workflow y con Ctrl+C); `haril workflow tail` (cada tipo de entrada, sin caracteres de control, un archivo que crece con una línea a medias, el final con el workflow, el prompt en secciones); la próxima revisión de un nodo terminado; y en la consola, con instantáneas y una sesión impresas por la CLI real, la vista con datos reales y sin ningún dato de ejemplo, `n/a` para lo que falta, la demostración que no se mezcla, la vista en vivo que toma sus líneas de `tail`, el flujo de `list`, `watch` y `tail` con una CLI falsa, y los cinco módulos con las metodologías en `TOOLS` (el ROJO de la consola se observó corriendo esas pruebas sobre el código anterior). Sin ROJO previo: la limpieza del carril `e2e:stop-real`, comprobada con un guion aparte (una ruta con comilla simple, la guarda de la hora de inicio y un pid reutilizado), porque las pruebas de `scripts/tests` están fuera de lo que esta fase podía cambiar.

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
