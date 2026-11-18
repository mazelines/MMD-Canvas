#pragma once
// Shared shading state for the character surface pass. The fixed base shading
// (baseShading in viewport.hlsl) populates this context; user-authored stack
// layers are `void fn(inout ShadingContext ctx)` functions that mutate it in
// order. `color` is scene-linear lit radiance before the /100 storage scale and
// before EV100/GT7/sRGB (those stay in outputMain). Fields are plain data so the
// struct can be shared by the build-time shader and runtime-generated stacks.
struct ShadingContext {
    // Surface (read-only for layers)
    float3 worldPos;
    float3 normal;       // lighting normal (normal/bump mapped)
    float3 geoNormal;    // geometric normal
    float2 uv;
    float3 viewDir;      // normalized surface -> camera
    float  depth;        // view-space depth (-view.z)
    float2 pixel;        // SV_Position.xy (render pixels)
    float  front;        // +1 front face, -1 back face
    // Material
    float3 albedo;
    float3 emission;
    float  alpha;
    float3 materialColor;
    // Lighting intermediates
    float  ndl;
    float  direct;       // direct term (toon band or Lambert, shadowed)
    float  shade;        // DXR shadow visibility 0..1
    float3 fill;         // indirect sky/ground fill (lux-scaled)
    float  ao;           // combined material/screen AO
    float3 sunDir;
    float  sunLux;
    float3 skyColor;
    float3 groundColor;
    // Screen-space (for depth-based effects)
    float2 viewportSize;   // render width/height in pixels
    float2 lightDirScreen; // sun direction projected to screen XY (y flipped)
    // Result (writable)
    float3 color;        // scene-linear lit, before /100
};

// Screen-space scene depth from the prepass (view-space depth; 0 = background).
// Lets stack layers sample neighbor depth for depth-based rim/edge effects.
// Included after the Frame cbuffer and normalDepth (t4) declarations in viewport.hlsl.
float sampleSceneDepth(float2 pixel) {
    int2 p = clamp(int2(pixel), int2(0, 0), int2(viewport.xy) - 1);
    return normalDepth.Load(int3(p, 0)).w;
}
