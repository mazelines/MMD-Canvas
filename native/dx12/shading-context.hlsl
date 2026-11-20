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
    float3 bentNormal;   // lighting normal plus world-space AO bend; normal when AO is off
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
    float3 fill;         // directional sky/ground fill before AO (lux-scaled)
    float  ao;           // combined material/screen AO
    float3 sunDir;
    float  sunLux;
    float  ambientLux;
    uint   materialId;
    float3 skyColor;
    float3 groundColor;
    // Screen-space (for depth-based effects)
    float2 viewportSize;   // render width/height in pixels
    float2 lightDirScreen; // sun direction projected to screen XY (y flipped)
    // Result (writable)
    float3 color;        // scene-linear lit, before /100
};

// Broad first-order sky lobe aligned to the sun, not another direct light.
// 2/3 is the cosine-convolution factor for a linear radiance lobe. Its spherical
// mean is one and it stays positive even at full directionality. Ambient lux
// remains independent of sun lux. This is an environment approximation, not GI
// or an atmospheric scattering model. Bent-normal sampling approximates the
// visible environment; the caller applies scalar visibility exactly once.
float3 evaluateAmbient(float3 direction, float skyBlend) {
    float directional = 1 + (2.0 / 3.0) * saturate(ground.w) * dot(direction, normalize(sun.xyz));
    return lerp(ground.rgb, sky.rgb, saturate(skyBlend)) * sky.w * directional;
}

// Screen-space scene depth from the prepass (view-space depth; 0 = background).
// Lets stack layers sample neighbor depth for depth-based rim/edge effects.
// Included after the Frame cbuffer and normalDepth (t4) declarations in viewport.hlsl.
float sampleSceneDepth(float2 pixel) {
    int2 p = clamp(int2(pixel), int2(0, 0), int2(viewport.xy) - 1);
    return normalDepth.Load(int3(p, 0)).w;
}
