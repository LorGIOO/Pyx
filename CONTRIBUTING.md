# Contribuir a Pyx

¡Gracias por tu interés! Las contribuciones (código, ideas, reportes de errores) son bienvenidas.

## Entorno de desarrollo

Necesitas **Node.js 18+** y **Rust**. Python y LaTeX: los del sistema si los hay; si no,
Pyx ofrece prepararlos al arrancar (Python con uv, LaTeX con Tectonic).

```bash
npm install
npm run tauri:dev     # levanta la app de escritorio con recarga en caliente
```

- El frontend (SolidJS + Vite + CodeMirror) recarga en caliente al guardar.
- Editar el kernel de Python (`src-tauri/python/kernel.py`) o el código Rust requiere reiniciar
  `tauri:dev` (Tauri recompila el backend automáticamente).

## Estructura

```
js/            Frontend: editor (CodeMirror), celdas, visor PDF, cinta, stores (SolidJS)
src-tauri/     Backend Rust: kernel de Python, compilación LaTeX, comandos del sistema
  python/      kernel.py — el REPL persistente embebido en el binario
styles/        CSS temático (variables claro/oscuro/azul)
public/dict/   Diccionarios del corrector ortográfico
test/          Pruebas (npm test; las de Rust con cargo test)
Manual de usuario/  El manual (Manual de usuario.pltx, hecho con Pyx) y su PDF
```

## Antes de abrir un Pull Request

1. Que el proyecto **compile limpio**:
   ```bash
   npm run build                                   # frontend, 0 warnings
   cargo check --manifest-path src-tauri/Cargo.toml
   ```
2. Sigue el estilo del código que rodea tu cambio (nombres, densidad de comentarios, idiomas).
3. Un cambio, un propósito: PRs pequeños y enfocados se revisan antes.
4. Describe **qué** cambia y **cómo probarlo**.

## Licencia

Al contribuir, aceptas que tu aportación se publique bajo la licencia [MIT](LICENSE) del proyecto.
