# CORTAO reference sources

Daniel Isheden's CORTAO 1.0.3, pinned to
[`420b168d88dd6f9276077ba62f3711cac9d7b46c`](https://github.com/theagentd/CORTAO/tree/420b168d88dd6f9276077ba62f3711cac9d7b46c).
MIT license: `licenses/CORTAO-MIT.txt` (also retained in the source headers).

The headers and 32 x 32 x 24 / 32-ray R32_UINT lookup table are unmodified upstream files.
`native/dx12/viewport.hlsl` includes the reference HLSL directly. The Windows build
compiles DXIL and packages it with the integer LUT beside the native executable.
No external download is needed when the app starts.

The full-resolution RGBA32F prepass stores geometric normals and fp32 linear
depth, then produces eight packed mip levels. Lighting/normal-map normals are
not used as occluder geometry: their tilt causes false self-occlusion. Half-float
linear depth also creates acne on high-resolution sloped surfaces. Camera
parameters account for Direct3D's texture coordinates. A fixed seed and a 5x5
depth/normal-guided spatial filter are used; temporal accumulation is not enabled.

Visibility and view-space bent normals are stored together in RGBA16F. The
depth/normal-guided filter averages the bend relative to each surface normal,
weighted by visibility. Fully open/blocked samples use their surface normal.
The color pass transforms the bend relative to the geometric normal to world
space, adds it to the authored lighting normal and uses it to evaluate a
broad sun-aligned environment lobe, then applies AO to indirect diffuse lighting.
Direct sunlight and DXR shadows still use the surface normal. The environment
is an analytic approximation, not atmospheric scattering or bounced-light GI.
This remains a screen-space approximation; hidden and off-screen
geometry are not available, and no DXR/RTX hardware tracing is involved.
