# NVIDIA Image Scaling reference sources

NVIDIA Image Scaling SDK v1.0.3, pinned to
[`35e13ba316c98eeecf16f37eae70ce88019911f6`](https://github.com/NVIDIAGameWorks/NVIDIAImageScaling/tree/35e13ba316c98eeecf16f37eae70ce88019911f6).
MIT license: `licenses/NVIDIA-NIS.txt` (also retained in the source headers).

Unmodified upstream files and their SHA-256:

| File | SHA-256 |
|---|---|
| `NIS_Main.hlsl` | `46402103801007b402aeeb8481d60b1bda37799bf68b543b32daea65f255f301` |
| `NIS_Scaler.h` | `2d3bd5b45d6a0c4169fe36dfe349e7ff5a099dff6fb6876f8a3286489f74d3bf` |
| `NIS_Config.h` | `f33c5dd82bb63f3c1cc7cefd86690053de0bd3fe0e730463a5e63e90e7778754` |

Only **NVSharpen** is used (`NIS_SCALER=0`): the adaptive directional
sharpening-only algorithm, for applications that do not need scaling. DLAA/DLSS
already reconstruct at the output resolution, so NVScaler and its coefficient
textures are not integrated. The DLSS SDK itself no longer supports sharpening
(`NVSDK_NGX_DLSS_Feature_Flags_DoSharpening` is deprecated); NIS is NVIDIA's
sharpening replacement and is MIT-licensed, unlike the DLSS runtime.

`scripts/build-dx12.ps1` compiles `NIS_Main.hlsl` to `nis-sharpen.cso` with
`NIS_SCALER=0`, `NIS_BLOCK_WIDTH=32`, `NIS_BLOCK_HEIGHT=32`,
`NIS_THREAD_GROUP_SIZE=256` (the SDK's NVSharpen defaults) and fp32 math.
`native/dx12/renderer.h` includes `NIS_Config.h` for `NISConfig` /
`NVSharpenUpdateConfig` and dispatches the pass on the finished sRGB composite
after GT7 tone mapping and background/grid composition, matching the SDK's
required pipeline placement (display-referred LDR input). The pass runs on any
DX12 Ultimate GPU, including the MSAA fallback, and is skipped entirely at 0%.
