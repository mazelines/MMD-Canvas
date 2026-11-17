# CORTAO reference sources

Daniel Isheden's CORTAO 1.0.3, pinned to
[`420b168d88dd6f9276077ba62f3711cac9d7b46c`](https://github.com/theagentd/CORTAO/tree/420b168d88dd6f9276077ba62f3711cac9d7b46c).
MIT license: `licenses/CORTAO-MIT.txt` (also retained in the source headers).

The headers and 32 x 32 x 24 / 32-ray R32_UINT lookup table are unmodified upstream files.
`native/dx12/viewport.hlsl` includes the reference HLSL directly. The Windows build
compiles DXIL and packages it with the integer LUT beside the native executable.
No external download is needed when the app starts.

The full-resolution depth/normal prepass produces eight packed mip levels. Camera
parameters account for Direct3D's texture coordinates. A fixed seed and a 5x5
depth/normal-guided spatial filter are used; temporal accumulation is not enabled.

The resulting visibility affects indirect diffuse lighting. Bent normals are not
currently consumed. This remains a screen-space approximation; hidden and off-screen
geometry are not available, and no DXR/RTX hardware tracing is involved.
