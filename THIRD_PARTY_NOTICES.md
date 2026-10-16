# Avisos de terceros

Este archivo recoge el código de terceros que los paquetes distribuidos de HARIL llevan dentro, con su licencia y su aviso de copyright, y el texto completo de cada licencia. También indica qué software descarga el instalador sin redistribuirlo.

## Código de terceros incluido en los paquetes

| Paquete distribuido | Componente de terceros | Versión | Licencia | Copyright |
|---|---|---|---|---|
| `apps/haril/dist/haril.mjs` (CLI `haril`) | typebox | 1.3.27 | MIT | Copyright (c) 2017-2026 Haydn Paterson |
| `integrations/agent-pi-bridge/dist/bridge.mjs` (extensión del puente) | ninguno | - | - | Solo importa módulos `node:*` |
| `apps/bootstrap/dist/haril-bootstrap.mjs` (instalador) | ninguno | - | - | Solo importa módulos `node:*` |

Los `dist` se generan con tsdown, que incluye en el bundle los paquetes `@haril/*` (código propio) y `typebox`. Esta lista se obtuvo revisando a mano los bundles compilados de la versión 0.4.1: el de `haril.mjs` solo contiene `typebox@1.3.27` como dependencia de terceros.

### typebox 1.3.27

Texto completo de la licencia, copiado del archivo `LICENSE` del paquete (`node_modules/typebox/license`):

```text
TypeBox

The MIT License (MIT)

Copyright (c) 2017-2026 Haydn Paterson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### Obra derivada: metodología ODD

El bloque de metodología `odd` (`apps/haril/dist/blocks/methodologies/odd/block.md`) es una obra derivada, redactada a partir del protocolo de enrutado ODD de Gentle AI (`routing.go`, versión 4.1.1). No importa ni copia ningún archivo de Gentle AI.

- Fuente: <https://github.com/Gentleman-Programming/gentle-ai>, etiqueta `v4.1.1`, archivo `LICENSE` (verificado el 2026-10-16; idéntico al de `v4.0.0`).
- Licencia de la fuente: MIT. Texto completo:

```text
MIT License

Copyright (c) 2025 Gentleman Programming

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Gentle AI y Engram son marcas de sus titulares. HARIL no está afiliado ni respaldado por ellos.

## Software que se descarga y no se redistribuye

El instalador de HARIL (`npm run runtime:install`, o `haril-bootstrap install-runtime`) descarga y usa los siguientes componentes, bajo sus propias licencias. HARIL no los incluye en sus paquetes:

- **Node.js**, descargado desde su sitio oficial (`https://nodejs.org/dist/`) y verificado con su `SHASUMS256.txt`. Licencia MIT, OpenJS Foundation.
- **Pi** (`@earendil-works/pi-coding-agent`), instalado desde el registro de npm. Licencia MIT, Copyright (c) 2025 Mario Zechner.

Las dependencias de desarrollo (TypeScript, Vitest, Biome, knip, tsdown) no se incluyen en los paquetes distribuidos.
