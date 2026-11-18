# CodeMirror 5 reference sources

CodeMirror 5.65.16, vendored from cdnjs for the shader-stack code editor.
MIT license: `licenses/CodeMirror-MIT.txt`.

Unmodified upstream files:

| File | Source |
|---|---|
| `codemirror.min.js` | `codemirror/5.65.16/codemirror.min.js` |
| `codemirror.min.css` | `codemirror/5.65.16/codemirror.min.css` |
| `mode/clike/clike.min.js` | `codemirror/5.65.16/mode/clike/clike.min.js` |
| `theme/material-darker.min.css` | `codemirror/5.65.16/theme/material-darker.min.css` |

Loaded as classic scripts in `renderer/index.html` (the app has no bundler and
its CSP forbids remote origins). The clike mode highlights HLSL as C++-like;
the editor is created lazily by `renderer/shader-stack-panel.js`.
