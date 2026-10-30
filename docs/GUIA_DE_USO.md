# Guía completa de uso de HARIL

> **Many minds. One flow.** Manual práctico de la consola, los paneles laterales y los indicadores.
>
> Esta guía refleja el código de HARIL 0.23.4 y posteriores. Lo que ves depende del tamaño de la terminal, la configuración guardada y las extensiones realmente cargadas.

## Contenido

1. [Qué hace HARIL](#1-qué-hace-haril)
2. [Plan de uso paso a paso](#2-plan-de-uso-paso-a-paso)
3. [Cómo se distribuye la pantalla](#3-cómo-se-distribuye-la-pantalla)
4. [Panel izquierdo: todas las vistas](#4-panel-izquierdo-todas-las-vistas)
5. [Panel derecho: significado de los valores](#5-panel-derecho-significado-de-los-valores)
6. [Barra de estado y cinco áreas](#6-barra-de-estado-y-cinco-áreas)
7. [Los cuatro modos de trabajo](#7-los-cuatro-modos-de-trabajo)
8. [Atajos y comandos](#8-atajos-y-comandos)
9. [Ejercicios prácticos](#9-ejercicios-prácticos)
10. [Actualizar, Matrix y resolver problemas](#10-actualizar-matrix-y-resolver-problemas)
11. [Límites reales y buenas prácticas](#11-límites-reales-y-buenas-prácticas)

## 1. Qué hace HARIL

HARIL reúne una **consola de chat basada en Pi**, una **línea de comandos propia**, **almacenamiento de tareas y eventos** y un **runtime local** capaz de ejecutar planes y workflows de agentes. Puedes consultar código, escoger modelos, organizar tareas, revisar aprobaciones y observar el trabajo realizado.

| Componente | Función | Entrada |
| --- | --- | --- |
| Consola Pi con HARIL | Chat, editor, modelo, cinco áreas y paneles laterales | `haril` o `haril console` |
| CLI | Proyectos, tareas, configuración, extensiones, modelos, métricas y actualización | `haril help` |
| Runtime | Ejecutar cola y tareas registradas | `haril run` o `haril start` |
| Orquestación | Seguimiento de workflows de orquestador, delegadores, ejecutores y auditores | Área ORCHESTRATION o `haril workflow ...` |
| Shell alternativo | Interfaz independiente anterior | `haril shell` |
| Pi privado | Configuración, sesiones y extensiones propias de HARIL | Se abre desde `haril` |

**Clave:** la vista de un módulo del dock **no demuestra** que una extensión de terceros esté instalada. HARIL distingue espacios visuales de paquetes Pi.

## 2. Plan de uso paso a paso

| Fase | Qué haces | Qué debes comprobar |
| --- | --- | --- |
| **1. Instalar** | Sigue el [README](../README.md). Después, `haril --version` y `haril doctor`. | CLI disponible, requisitos y avisos claros. |
| **2. Ubicarte** | Entra con `cd` al proyecto de código y ejecuta `haril`. | «Estoy en» muestra la carpeta que elegiste. |
| **3. Personalizar** | `/haril-theme matrix`, `/language es`, `/model`. | Tema, idioma HARIL y modelo correcto. |
| **4. Explorar** | `Alt+L` para vistas, `Alt+H` para áreas, `/haril-commands`. | Conoces menús sin iniciar trabajo. |
| **5. Consultar** | `/mode consult` y pide una explicación del proyecto. | No se alteran archivos. |
| **6. Planificar** | `/init` si falta proyecto, `/mode plan` y `/goal <objetivo>`. | Plan/objetivo consultable cuando hay proveedor y runtime. |
| **7. Revisar** | `/plans`, `/plan <id>`; luego `/approve <id>` solo si estás conforme. | Tareas y aprobaciones registradas. |
| **8. Seguir** | `/tasks`, `/events` y ORCHESTRATION. | Estado, avisos y resultados visibles. |
| **9. Auditar** | `haril usage summary`, `haril status`, `haril metrics`. | Consumo y eventos locales revisables. |

### Tu primer arranque en Windows

Abre Windows Terminal / PowerShell en la carpeta donde quieres trabajar:

```powershell
cd D:\github\mi-proyecto
haril --version
haril doctor
haril
```

**No tienes que abrir HARIL desde el repositorio fuente de HARIL.** La carpeta actual determina el contexto.

Los dos paneles laterales nativos requieren una terminal de al menos **132 columnas y 24 filas**, además de una versión compatible de Pi. Con una ventana menor puede aparecer una cabecera compacta o abrirse un menú en lugar del panel permanente. Esto es una adaptación de la interfaz, no necesariamente un error de instalación.

## 3. Cómo se distribuye la pantalla

| Zona | Qué contiene | Cómo interactúas |
| --- | --- | --- |
| **Izquierda** | Vistas GIT, YT, MEM y THEME | Pestañas, clic, `Alt+L`, rueda del mouse |
| **Centro** | Chat real de Pi, comandos `/` y respuestas de herramientas | Escribes peticiones, `/model`, `/haril` |
| **Derecha** | Ubicación, modo, modelo, avisos, extensiones, sesión, acciones y eventos | Clic en `▶`/`▼`, `Alt+I` |
| **Inferior** | Modo, modelo, uso del contexto, coste, planes pendientes, runtime y STOP ALL | `Alt+H`, `Alt+M`, clic |

El centro puede estar negro y vacío al iniciar porque **no se ha conversado todavía**. Las columnas no crean una conversación automáticamente.

### Color Matrix

- **Negro:** fondo principal.
- **Verde brillante:** bordes y elementos destacados.
- **Verde claro:** texto principal.
- **Verde oscuro:** detalles secundarios o atenuados.
- **Amarillo:** avisos y ciertos resaltados semánticos.
- **Rojo:** errores o parada de emergencia.

La paleta visual de HARIL y el tema interno de Pi son configuraciones relacionadas pero distintas. Si ves el chat verde y los laterales naranja, hay probablemente una preferencia antigua `ui.theme=amber` guardada: usa `/haril-theme matrix` o `haril config set ui.theme matrix`.

## 4. Panel izquierdo: todas las vistas

La cabecera incluye la carpeta y «VISTAS · Alt+L». Los números 1–4 indican el **orden actual de espacios visibles**; si cambias el orden, los números cambian.

| Vista | Qué significa | Qué puedes hacer | Límite |
| --- | --- | --- | --- |
| **GIT** | Rama, estado `git status`, cambios resumidos e historial | Consultar diferencias e historial | No hace commit, push ni merge desde esta vista |
| **YT / YouTube** | Espacio reservado para un reproductor externo | Ver si se detecta el comando `/yt` | No instala ni abre un reproductor automáticamente |
| **MEM / Memoria** | Estado de salud del proveedor de memoria | Inspeccionar disponibilidad/errores | No implica que Engram esté conectado |
| **THEME / Temas** | Paleta visual del dock | Cambiar matrix, violet, rose, amber, obsidian | No cambia los modelos ni instala extensiones |

### Ocultar, mostrar o reordenar espacios

Ejecuta **fuera del chat**, en PowerShell:

```powershell
haril plugins list
haril plugins hide youtube
haril plugins show youtube
haril plugins move git up
haril plugins reset
```

Dentro de HARIL usa `/haril-plugins`. Se ofrecen **Mostrar, Ocultar, Subir y Bajar**. Para entrar directamente a una vista: `/haril-plugin git`, `/haril-plugin memory` o `/haril-plugin themes`. El argumento numérico selecciona una vista **visible**.

Estas operaciones cambian la interfaz, no los paquetes Pi. Si gestionaste el dock desde otra ventana, usa `/haril-plugins` o reabre HARIL para verlo reflejado.

## 5. Panel derecho: significado de los valores

Las secciones con `▶` están contraídas y con `▼` expandidas. Su contenido corresponde a la **sesión y área actuales**, no a un inventario universal.

En el panel derecho responden al clic las cabeceras de sección (`AVISOS`, `EXTENSIONES`, `SESIÓN`, `ACCIONES`), cada acción de `ACCIONES` y el texto `cambiar` de la fila `Modo`.

| Elemento | Qué mide o representa | Qué hacer |
| --- | --- | --- |
| `HARIL · AGENTS · panel` | Área actualmente enfocada | `Alt+H` o pestañas inferiores |
| `Estoy en: C:\...` | Directorio real desde donde abriste HARIL | Cambia de carpeta con `cd` antes de iniciar |
| `Modo: ACTION` | Nivel de permisos/herramientas del chat | Clic, `Alt+M`, `/mode` |
| `Proyecto: ander` | Proyecto asociado o nombre de la carpeta | `/init` y `haril project list` |
| `Modelo: gpt-6.1-sol · medium` | Modelo Pi y esfuerzo/nivel que publica | `/model` o selector en barra |
| `AVISOS · 0` | Cantidad de avisos conocidos ahora | Expande; cero **no garantiza** ausencia total de errores |
| `EXTENSIONES · 0` | **Estados observados** de extensiones, no paquetes instalados | `haril extensions list --json` para inventario declarado |
| `SESIÓN` | Modelo, runtime, proyecto y memoria resumida | Expande con clic |
| `ACCIONES · AGENTS · 4` | Cuatro controles disponibles en **esa área**, no cuatro agentes ejecutando | Clic en un control o `/haril` |
| `ACTIVIDAD RECIENTE` | Eventos consultados del proyecto | `/events`, `haril events`, `haril usage log` |
| `Sin eventos registrados` | No hay eventos que mostrar en la consulta | Revisa registro del proyecto; no implica fallo en Pi |

**Ojo IA (`◉`):** pequeño indicador basado en hechos observables. Puede volverse rojo cuando el contexto supera un umbral alto o hay muchos trabajadores ocupados; amarillo si se está ejecutando trabajo. **No** mide emociones ni esfuerzo interno invisible del modelo.

### Acciones contextuales

- `[I] Registrar esta carpeta`: vincular un proyecto.
- `[D] Ver detalles completos`: consultar datos del área.
- `[M] Elegir modelo`: seleccionar modelo.
- `[R] Actualizar datos`: volver a consultar estado y eventos.
- `[V] Abrir vista de orquestación`: ver árbol y nodos.
- `[P] Elegir el flujo`: seleccionar workflow seguido.
- `[G] Encolar objetivo`: pedir planificación tras registrar un proyecto.

**Atención:** una letra entre corchetes es la pista del control **en ese menú**; no es necesariamente un atajo global. Los botones cambian si no hay proyecto, si el runtime está ocupado o si el modo es de solo lectura.

## 6. Barra de estado y cinco áreas

### Qué representan los números de abajo

| Valor | Qué significa | Ejemplo |
| --- | --- | --- |
| `MODE: ACTION` | Modo del chat | ACTION permite herramientas activas de Pi |
| `ander` | Carpeta o proyecto | Puede ser solo la carpeta, aún no registrada |
| `gpt-6.1-sol · medium` | Modelo elegido y nivel de razonamiento | Se cambia por el selector de Pi |
| `ctx ▱▱ 0%` | Porcentaje de ventana de contexto informado por Pi | `?%` si Pi no tiene dato |
| `$0.000` | Coste acumulado de respuestas reportado en la sesión | **No** representa necesariamente toda la facturación externa |
| `1 pending` | **Un plan pendiente de aprobación** conocido | Consulta `/plans` y revisa antes de aceptar |
| `runtime idle` | Motor local confirmado sin trabajo activo | Se puede preparar cola |
| `runtime running` | Runtime compartido activo | Puede atender más de un proyecto |
| `runtime unknown` | No hay confirmación fiable del runtime | Revisa estado; no asumas que está detenido |
| `■ STOP ALL` | Parada global inmediata | Cancela trabajo: **no lo uses como prueba decorativa** |

### Las cinco áreas inferiores

| Área | Objetivo | Acciones habituales |
| --- | --- | --- |
| **1. AGENTS** | Modelo activo y tareas por agente **observado** | Registrar carpeta, detalles, elegir modelo, ver tareas |
| **2. ORCHESTRATION** | Workflows, planificación, aprobaciones, cola, eventos y agentes | Ver flujo, elegir workflow, activar demo, revisar planes |
| **3. AUTOMATION** | Cola de trabajos del proyecto y runtime compartido | Ejecutar cola, arrancar/detener runtime, revisar estados |
| **4. TOOLS** | Herramientas Pi, metodologías y ajustes de delegación | Modelo/nivel, tools activas, límites, catálogo y consumo |
| **5. EVERYWHERE** | Vista panorámica de recursos y sesión | Directorio, Git, proveedores, MCP, memoria, coste y eventos |

**Limitaciones precisas:**

- AGENTS presenta los agentes **observados en las tareas**; no es un catálogo independiente completo de perfiles.
- AUTOMATION administra cola y runtime; **no incorpora aún un programador de tareas periódicas basado en calendario**.
- ORCHESTRATION diferencia trabajo real y demostración. `/orchestration demo` utiliza datos **simulados**. Cuando hay un workflow real, HARIL puede seguirlo mediante `haril workflow watch` y leer la actividad de nodos con `haril workflow tail`.

## 7. Los cuatro modos de trabajo

| Modo | Cuándo utilizarlo | Restricciones |
| --- | --- | --- |
| **ACTION** | Desarrollo y uso normal del chat | Herramientas Pi permitidas por la sesión; revisa cambios |
| **CONSULT** | Investigar sin modificar código | Solo lectura; puede guardar **un informe Markdown** si lo pides expresamente |
| **PLAN** | Preparar pasos, archivos, pruebas y riesgos | No modifica código; pide «guárdalo» o usa `/save-plan` para guardarlo en `docs/planes`; `/goal` envía la planificación al mecanismo de tareas |
| **DELEGATION** | Proponer trabajo a varios agentes | El mensaje abre una tarjeta de delegación que ofrece primero los planes guardados; sin paradas salvo que las pidas; chat restringido |

Cambiar:

```text
/mode action
/mode consult
/mode plan
/mode delegation
```

`Alt+M` recorre los modos. En CONSULT/PLAN/DELEGATION HARIL bloquea herramientas de escritura no permitidas, incluso si otra extensión intenta habilitarlas.

### Delegar con modelos de Claude (claude-bridge)

Si solo tienes Claude Code, instala la extensión una vez con `haril extensions install npm:pi-claude-bridge --yes` y elige un modelo `claude-bridge/...` con `/model`. La tarjeta `/delegate` lo toma como modelo del orquestador y el selector `M` lista los demás modelos de claude-bridge. Los agentes usan el mismo login de Claude Code que el chat: no hay que configurar ninguna clave ni Broker.

- Cada capa usa el modelo del orquestador, salvo que fijes otro en `delegation.models.layers.<capa>.model` (también desde el panel de delegación).
- El uso de cada llamada se carga al presupuesto de la tarea y del proyecto y aparece en `haril usage`; si el presupuesto se agota, el agente se detiene antes de la siguiente llamada.
- Cada llamada vuelve a enviar todo el contexto (con claude-bridge, unos 10 000 tokens o más), así que un auditor recibe como mínimo `delegation.limits.minAuditorTokens` (60 000 por defecto) aunque el tercio del presupuesto de su ejecutor sea menor. Si un auditor agota su presupuesto antes del veredicto, HARIL no relanza al ejecutor: el paso queda fallido y su rama `step` conserva el trabajo.
- El proyecto tiene un presupuesto de tokens para toda su vida, `delegation.limits.projectTokens` (50 000 000 por defecto), que se aplica en cada arranque de agente. Si ya no alcanza para el turno del orquestador, la verificación previa lo rechaza sin encolar nada; súbelo con `haril config set delegation.limits.projectTokens <tokens>`.
- La tarjeta repite el aviso de facturación del Agent SDK que da el README de la extensión: hoy consume la cuota de tu plan como Claude Code.
- `haril workflow start --preflight --agent orchestrator --model claude-bridge/<id>` dice si la extensión falta o el id no es de Claude.

## 8. Atajos y comandos

### Atajos registrados en HARIL

| Teclas | Resultado |
| --- | --- |
| **Alt+L** | Selector del dock izquierdo: **1–4**, `↑/↓`, `Enter`, `Esc` |
| **Alt+H** | Selector de las cinco áreas: `↑/↓`, `Enter`, `Esc` |
| **Alt+I** | Mostrar/ocultar panel derecho; en terminal compacta abre acciones |
| **Alt+C** | Catálogo de comandos Pi/HARIL disponibles |
| **Alt+M** | Siguiente modo de consola |
| **Alt+O** | Vista de orquestación |
| **Alt+X** | **STOP ALL** global: cancelar agentes y runtime inmediatamente |

Las flechas `←/→` también pueden mover la selección en los diálogos, pero `↑/↓` son las principales. `Esc` cierra el **selector** que está abierto; no es un cierre global de HARIL. Algunas terminales pueden interceptar combinaciones `Alt`.

### Comandos `/` dentro de la consola

| Comando | Para qué sirve |
| --- | --- |
| `/haril` | Menú general |
| `/haril-commands` | Comandos efectivamente disponibles en esta sesión |
| `/haril-plugin [vista]` | Abrir una vista del dock |
| `/haril-plugins` | Mostrar, ocultar o mover espacios del dock |
| `/haril-extensions` | Administrar paquetes Pi declarados; la carga puede requerir reiniciar |
| `/haril-dock left` / `right` / `both` | Mostrar u ocultar columnas |
| `/haril-theme matrix` | Cambiar paleta del dock |
| `/language es` / `en` | Idioma de textos propios de HARIL |
| `/model` | Selector de modelo Pi |
| `/mode ...` | Cambiar política de herramientas |
| `/init` | Registrar carpeta |
| `/goal <objetivo>` | Enviar objetivo para planificación |
| `/plans` / `/plan <id>` | Revisar planes |
| `/approve <id>` / `/deny <id>` | Decidir sobre un plan revisado |
| `/tasks` / `/task <id>` / `/events` | Consultar tareas y eventos |
| `/save-plan [título] [--chat]` / `/guardar-plan` | Guardar la última respuesta (o toda la conversación con `--chat`) como plan en `docs/planes` |
| `/delegate <objetivo>` | Tarjeta de workflow con agentes |
| `/continue` | Continuar workflow retirando paradas indicadas |
| `/orchestration view` / `pick` / `demo` | Vista completa, selector o simulación |

### Comandos de la CLI (PowerShell/Bash)

```powershell
haril help
haril doctor
haril status
haril models
haril plugins list
haril extensions list --json
haril project list
haril events --limit 20
haril usage summary --by model
haril metrics
```

Otros comandos disponibles incluyen `haril quota`, `haril memory status`, `haril methodology list`, `haril difficulty show`, `haril workflow list|show|watch|tail|continue|stop` y `haril plan validate|propose|import`. Para sintaxis actualizada usa `haril help`.

## 9. Ejercicios prácticos

### A. Conocer la consola sin agentes reales

1. Ejecuta `haril` desde una carpeta de proyecto.
2. `Alt+L` → Git; recorre el estado y el historial con la rueda.
3. `Alt+H` → recorre las cinco áreas y vuelve a AGENTS.
4. Escribe `/orchestration demo` para activar una muestra. Repítelo para desactivarla.
5. Ejecuta `/haril-commands` para ver qué comandos registra realmente Pi.

**Esperado:** recorriste la interfaz sin ejecutar agentes reales; la demo usa datos de muestra.

### B. Investigar, planear y autorizar

1. Abre tu proyecto. Si no está registrado, usa `/init`.
2. `/mode consult`: pide «Analiza la estructura sin editar archivos».
3. `/mode plan`: pide pasos, pruebas, riesgos y archivos afectados.
4. Cuando tengas un objetivo claro, `/goal <objetivo>`; después `/plans` y `/plan <id>`.
5. **Solo tras leer el plan**, cambia al modo adecuado y confirma `/approve <id>`.
6. Observa `/tasks`, `/events` y ORCHESTRATION.

`/approve` no es una operación de lectura: el runtime podrá ejecutar trabajo aprobado después. Este flujo depende de un modelo y configuración operativos.

### C. Probar la estructura de agentes sin consumir modelos

En PowerShell:

```powershell
haril workflow demo --seed 1 --delegators 2 --executors 2
```

La salida simula una estructura de orquestador, delegadores, ejecutores y auditores con un almacén temporal. **No demuestra integración real ni permisos de escritura.**

### D. Ver diferencia entre módulos y extensiones

```powershell
haril plugins list
haril extensions list --json
```

El primero devuelve **visibilidad y orden de espacios**; el segundo, **paquetes Pi declarados** en el agente privado de HARIL. El contador del panel derecho puede permanecer en cero porque muestra otra métrica.

## 10. Actualizar, Matrix y resolver problemas

### Comprobación y actualización

Cierra las sesiones HARIL antes de actualizar:

```powershell
haril update --check
haril update
haril --version
haril doctor
haril
```

- `haril update --check` consulta sin instalar.
- `haril update` consulta e instala con confirmación cuando corresponde.
- `haril update --yes` permite actualizar sin pedir confirmación.
- Las herramientas administradas de Matrix pueden verificarse o repararse incluso si HARIL ya tiene la versión más reciente.
- Si GitHub/npm está inaccesible, la actualización no puede completar las descargas; revisa el error.

Al arrancar, HARIL intenta el efecto original `tte matrix` y, si no está disponible, usa el motor integrado. La lluvia debe llenar la terminal, transformarse progresivamente en **HARIL** grande y dejarlo visible **3 segundos**. La presentación visual de cada sistema operativo requiere comprobación real.

### Problemas habituales

| Situación | Qué revisar |
| --- | --- |
| Panel central verde pero laterales naranja/rosa | `haril config get ui.theme`; dentro, `/haril-theme matrix`; o `haril config set ui.theme matrix` y reabrir |
| No aparece un lateral | Ancho/alto de la terminal, compatibilidad Pi; `Alt+I` o `/haril-dock both` |
| `EXTENSIONES · 0` aunque hay paquetes | El contador no es inventario; `haril extensions list --json` |
| No hay tareas y runtime está idle | `/tasks` y `haril status`; registrar proyecto y preparar objetivo |
| Runtime `unknown` | `haril doctor`, avisos y estado; **no asumir** que está detenido |
| No puedes elegir un modelo o responde 401 | `/model`, `/login`, `haril models`, `haril doctor`; revisar proveedor y autenticación |
| Flechas no funcionan | Asegúrate de que el selector `Alt+L`/`Alt+H` tiene foco; prueba números y `Enter` |
| Cambio de plugins no aparece | `/haril-plugins` para recargar o reinicia HARIL |
| Lluvia Matrix recortada | Fuente monoespaciada, tamaño de terminal, soporte ANSI y motor TTE/integrado |

HARIL usa una **instancia privada de Pi**: sus extensiones y sesiones no se copian automáticamente de Gentle Shell u otra instalación global.

## 11. Límites reales y buenas prácticas

| Función | Estado y límite |
| --- | --- |
| Chat, modelos, temas e idioma | Disponibles si los proveedores y Pi responden |
| Paneles | Nativos en Pi y terminal compatibles; en tamaños pequeños se compactan |
| GIT | Vista de inspección, **no** un IDE/cliente Git de edición |
| YouTube | Espacio visual dependiente de una extensión externa |
| AGENTS | Agentes observados en tareas; **no** catálogo universal de perfiles |
| AUTOMATION | Cola y runtime; **no** un calendario de tareas recurrentes |
| ORCHESTRATION demo | **Simulada**, no invoca agentes reales |
| ORCHESTRATION real | Depende de proyecto, modelos, capacidad, permisos, paradas y runtime |
| EXTENSIONES del panel | Estados observados, **no** listado completo de paquetes |
| Actualización | Depende de red y validaciones; conserva preferencias antiguas explícitas |

### Una rutina fiable para trabajar

1. **Ubicación:** confirma «Estoy en» antes de dar instrucciones sobre archivos.
2. **Modo:** consulta primero; usa PLAN para un cambio complejo y ACTION solo cuando proceda.
3. **Aprobación:** lee el plan y el alcance antes de ejecutar.
4. **Supervisión:** mira avisos, contexto, coste, tareas y eventos.
5. **Emergencias:** `Alt+X` y `haril stop --now` cancelan trabajo de manera global y **sin confirmación**. `haril resume` reanuda la aceptación de trabajo posterior; no recupera tareas canceladas automáticamente.

Para referencia de instalación y arquitectura avanzada, consulta el [README del repositorio](../README.md) y `haril help`.
