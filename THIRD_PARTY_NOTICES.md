# Avisos de terceros

Este archivo recoge el código de terceros que los paquetes distribuidos de HARIL llevan dentro, con su licencia y su aviso de copyright, y el texto completo de cada licencia. También indica qué software descarga el instalador sin redistribuirlo.

## Código de terceros incluido en los paquetes

| Paquete distribuido | Componente de terceros | Versión | Licencia | Copyright |
|---|---|---|---|---|
| `apps/haril/dist/haril.mjs` (CLI `haril`) | typebox | 1.3.27 | MIT | Copyright (c) 2017-2026 Haydn Paterson |
| `integrations/agent-pi-bridge/dist/bridge.mjs` (extensión del puente) | ninguno | - | - | Solo importa módulos `node:*` |
| `apps/bootstrap/dist/haril-bootstrap.mjs` (instalador) | ninguno | - | - | Solo importa módulos `node:*` |
| `apps/bootstrap/dist/haril-bootstrap.mjs` | Shader CRT suave (obra derivada, ver abajo) | - | CC0 1.0 y MIT | Hammster; Copyright (c) Microsoft Corporation |
| `apps/shell/dist/shell.mjs` (interfaz `haril shell`) | @earendil-works/pi-tui | 1.3.0 | MIT | Copyright (c) 2025 Mario Zechner |
| `apps/shell/dist/shell.mjs` | marked | 18.0.11 | MIT | Copyright (c) 2018+, MarkedJS; Copyright (c) 2011-2018, Christopher Jeffrey |
| `apps/shell/dist/shell.mjs` | get-east-asian-width | 1.6.0 | MIT | Copyright (c) Sindre Sorhus |
| `apps/shell/dist/shell.mjs` | typebox | 1.3.27 | MIT | Copyright (c) 2017-2026 Haydn Paterson |

La fábrica de la consola (`integrations/pi-console`) y `haril update` siguen los colores y las formas de las piezas de [ascii-magic-art](https://github.com/kailashsr38/ascii-magic-art): no se copia su código, solo datos (paleta, glifos y disposición). Su licencia está más abajo.

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

### @earendil-works/pi-tui 1.3.0

El paquete npm declara MIT y no incluye un archivo de licencia. El texto completo es el `LICENSE` de la raíz del repositorio de origen (`https://github.com/earendil-works/pi`, etiqueta `v1.3.0`; `packages/tui` no tiene uno propio), verificado el 2026-10-16. El helper nativo opcional del paquete (`native/`) no se incluye en `shell.mjs`.

```text
MIT License

Copyright (c) 2025 Mario Zechner

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

### marked 18.0.11

Texto completo de la licencia, copiado del archivo `LICENSE` del paquete:

```text
# License information

## Contribution License Agreement

If you contribute code to this project, you are implicitly allowing your code
to be distributed under the MIT license. You are also implicitly verifying that
all code is your original work. `</legalese>`

## Marked

Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)

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

## Markdown

Copyright © 2004, John Gruber
http://daringfireball.net/
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* Neither the name “Markdown” nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

This software is provided by the copyright holders and contributors “as is” and any express or implied warranties, including, but not limited to, the implied warranties of merchantability and fitness for a particular purpose are disclaimed. In no event shall the copyright owner or contributors be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.
```

### get-east-asian-width 1.6.0

Texto completo de la licencia, copiado del archivo `license` del paquete:

```text
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
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

### Obra derivada: shader CRT para Windows Terminal

El texto HLSL que escribe `haril-bootstrap terminal-profile` (`apps/bootstrap/src/terminal-shader.ts`) es una versión reducida de `crt.hlsl`. Solo conserva las pasadas de bloom y de scanlines, con valores más suaves.

- Fuente: <https://github.com/Hammster/windows-terminal-shaders>, archivo `crt.hlsl` de la rama `main` (consultado el 2026-10-31). Licencia CC0 1.0 Universal (dominio público); no exige aviso, se cita por transparencia.
- La pasada de scanlines de ese archivo procede de `samples/PixelShaders/Retro.hlsl` de Microsoft Terminal (<https://github.com/microsoft/terminal>), bajo licencia MIT. Texto completo, copiado del archivo `LICENSE` de ese repositorio:

```text
Copyright (c) Microsoft Corporation. All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Software que se descarga y no se redistribuye

El instalador de HARIL (`npm run runtime:install`, o `haril-bootstrap install-runtime`) descarga y usa los siguientes componentes, bajo sus propias licencias. HARIL no los incluye en sus paquetes:

- **Node.js**, descargado desde su sitio oficial (`https://nodejs.org/dist/`) y verificado con su `SHASUMS256.txt`. Licencia MIT, OpenJS Foundation.
- **Pi** (`@earendil-works/pi-coding-agent`), instalado desde el registro de npm. Licencia MIT, Copyright (c) 2025 Mario Zechner.

Las dependencias de desarrollo (TypeScript, Vitest, Biome, knip, tsdown) no se incluyen en los paquetes distribuidos.

### ascii-magic-art

Referencia visual de la fábrica. Licencia copiada del archivo `LICENSE` del repositorio.

```text
MIT License

Copyright (c) 2026 ASCII Magic (ascii-magic.com)

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
