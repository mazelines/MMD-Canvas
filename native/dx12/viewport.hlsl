// Scene-linear DX12 material lighting. DXR visibility is evaluated before EV100 / GT7.
#include "gt7.hlsl"
struct Vertex { float3 position; float3 normal; float2 uv; };
struct Material { float4 color; float4 emission; int4 maps; float4 options; float4 uvTransform; float4 extra; float4 normals; float4 mapFlags; };
cbuffer Frame : register(b0) {
    float4x4 view;
    float4x4 projection;
    float4 sun;              // towards light, lux
    float4 sky;              // linear RGB, ambient lux
    float4 ground;           // linear RGB, sky directionality 0..1
    float4 viewport;         // width, height, tan(light angular radius), AO world radius
    float4 settings;         // EV exposure scale, toon, shadows, AO enabled
    float4 ao;               // strength, debug: 0/color 1/filtered 2/raw 3/bent, shadow samples, bias
    float4 background;       // display-linear background, grid enabled
    float4 misc;             // ground height, grid size, model diagonal, outline width
    float4 outlineColor;     // exposure-protected scene-linear outline RGB, requested AA mode
    float4 grid;             // center X/Z, width, cell size
    float4 sharpening;       // post-reconstruction amount 0..1, unused, unused, unused
    uint4 mipInfo[8];        // width, height, packed offset, unused
    float4x4 previousView;
    float4x4 previousProjection;
    uint4 temporalInfo;      // sampling frame, valid history, max history, enabled
    float4 aaInfo;           // output width/height, DLSS active, material mip bias
    float4 aaJitter;         // current/previous sample offsets in render pixels
};
cbuffer Draw : register(b1) { uint materialId; uint mipLevel; uint triangleOffset; uint selected; };
StructuredBuffer<Vertex> vertices : register(t0);
StructuredBuffer<uint4> triangles : register(t1);
StructuredBuffer<Material> materials : register(t2);
RaytracingAccelerationStructure scene : register(t3);
Texture2D<float4> normalDepth : register(t4);
StructuredBuffer<uint> packed : register(t5);
Texture2D<float4> rawAO : register(t6); // visibility, view-space bent normal
Texture3D<uint> occluderLut : register(t7);
Texture2D<float4> images[128] : register(t8);
Texture2D<float4> hdrColor : register(t136);
StructuredBuffer<Vertex> previousVertices : register(t137);
Texture2D<float4> shadowSurface : register(t138);
Texture2D<float4> shadowMotion : register(t139);
Texture2D<float4> shadowRaw : register(t140);
Texture2D<float4> shadowHistory : register(t141);
Texture2D<float4> previousSurface : register(t142);
Texture2D<float4> shadowSpatialInput : register(t143);
Texture2D<float4> shadowResolved : register(t144);
Texture2D<float4> shadowGuide : register(t145);
Texture2D<float4> shadowSpatialIntermediate : register(t146);
Texture2D<float4> aaResult : register(t147);
Texture2D<float4> composite : register(t148);
Texture2D<uint> selectionMask : register(t150); // nativeId+1 coverage of the loaded object (0=background)
RWStructuredBuffer<uint> packedOut : register(u0);
RWTexture2D<float4> aoOut : register(u1);
RWTexture2D<float4> output : register(u2);
RWTexture2D<float4> surfaceOut : register(u3);
RWTexture2D<float4> motionOut : register(u4);
RWTexture2D<float4> shadowRawOut : register(u5);
RWTexture2D<float4> shadowSpatialOut : register(u6);
RWTexture2D<float4> shadowHistoryOut : register(u7);
RWTexture2D<float4> shadowGuideOut : register(u8);
RWTexture2D<float4> shadowFinalOut : register(u9);
RWTexture2D<float2> aaMotionOut : register(u10);
RWTexture2D<float> aaDepthOut : register(u11);
RWTexture2D<float> aaExposureOut : register(u12);
RWTexture2D<float4> compositeOut : register(u13);
SamplerState linearWrap : register(s0);
SamplerState nearestClamp : register(s1);
float3 decodeSRGB(float3 c) { return select(c <= 0.04045, c / 12.92, pow((c + 0.055) / 1.055, 2.4)); }
float3 encodeSRGB(float3 c) { return select(c <= 0.0031308, c * 12.92, 1.055 * pow(max(c, 0), 1.0 / 2.4) - 0.055); }
float4 imageSample(int id, float2 uv) { return id < 0 ? float4(1,1,1,1) : images[NonUniformResourceIndex(id)].SampleLevel(linearWrap, uv, 0); }
float4 imageSurface(int id, float2 uv) { return id < 0 ? float4(1,1,1,1) : images[NonUniformResourceIndex(id)].SampleBias(linearWrap, uv, aaInfo.w); }
float2 surfaceUv(Material m, float2 uv) { uv = uv * m.uvTransform.xy + m.uvTransform.zw; return float2(uv.x, m.extra.x > 0 ? 1 - uv.y : uv.y); }
float surfaceAlpha(Material m, float2 uv) { return m.color.a * imageSample(m.maps.x, uv).a * imageSample(m.maps.y, uv).g; }
struct Varying { float4 position : SV_Position; float3 world : TEXCOORD0; float3 normal : TEXCOORD1; float2 uv : TEXCOORD2; float depth : TEXCOORD3; centroid float3 shadowWorld : TEXCOORD4; float3 previousWorld : TEXCOORD5; float4 previousClip : TEXCOORD6; };
Varying vertexMain(uint id : SV_VertexID) {
    Vertex v = vertices[id]; Varying o; o.world = o.shadowWorld = v.position; o.normal = v.normal; o.uv = v.uv;
    o.previousWorld = previousVertices[id].position;
    o.previousClip=mul(previousProjection,mul(previousView,float4(o.previousWorld,1)));
    float4 p = mul(view, float4(v.position, 1)); o.position = mul(projection, p); o.depth = -p.z;
    o.position.xy+=float2(-2,2)*aaJitter.xy/viewport.xy*o.position.w;return o;
}
// Non-jittered vertex for the selection mask: stable sub-pixel coverage across AA
// phases so the post-AA selection ring does not flicker on a static view.
Varying maskVertex(uint id : SV_VertexID) {
    Vertex v = vertices[id]; Varying o; o.world = o.shadowWorld = v.position; o.normal = v.normal; o.uv = v.uv;
    o.previousWorld = previousVertices[id].position;
    o.previousClip=mul(previousProjection,mul(previousView,float4(o.previousWorld,1)));
    float4 p = mul(view, float4(v.position, 1)); o.position = mul(projection, p); o.depth = -p.z;
    return o;
}
Varying outlineVertex(uint id : SV_VertexID) {
    Varying o=vertexMain(id);float4 n=mul(projection,float4(mul((float3x3)view,o.normal),0));
    float2 direction=(n.xy*o.position.w-o.position.xy*n.w)*viewport.xy;
    if(length(direction)>0.00001)o.position.xy+=normalize(direction)*(2*misc.w/viewport.xy)*o.position.w;
    float4 previousN=mul(previousProjection,float4(mul((float3x3)previousView,previousVertices[id].normal),0));
    float2 previousDirection=(previousN.xy*o.previousClip.w-o.previousClip.xy*previousN.w)*viewport.xy;
    if(length(previousDirection)>0.00001)o.previousClip.xy+=normalize(previousDirection)*(2*misc.w/viewport.xy)*o.previousClip.w;
    o.position.z+=0.00001*o.position.w;return o;
}
float4 outlineMain(Varying v,bool front:SV_IsFrontFace):SV_Target {
    if(front)discard;Material m=materials[materialId];clip(surfaceAlpha(m,surfaceUv(m,v.uv))-max(m.options.x,0.5));
    return float4(outlineColor.rgb,1);
}
float3 surfaceNormal(Varying v, bool front, Material m) {
    float3 n=normalize(v.normal)*(front?1:-1);float3 q0=ddx(v.world),q1=ddy(v.world);
    if(m.normals.w>0){float3 flat=normalize(cross(q0,q1));n=dot(flat,n)<0?-flat:flat;}
    float2 uv=v.uv*m.uvTransform.xy+m.uvTransform.zw;
    if(m.extra.y>=0){
        float2 normalUv=float2(uv.x,m.mapFlags.x>0?1-uv.y:uv.y);
        float3 mapN=imageSurface((int)m.extra.y,normalUv).xyz*2-1;mapN.xy*=m.normals.xy;
        float2 st0=ddx(normalUv),st1=ddy(normalUv);float3 q1perp=cross(q1,n),q0perp=cross(n,q0);
        float3 tangent=q1perp*st0.x+q0perp*st1.x,bitangent=q1perp*st0.y+q0perp*st1.y;
        float scale=rsqrt(max(max(dot(tangent,tangent),dot(bitangent,bitangent)),1e-20));
        n=normalize(tangent*scale*mapN.x+bitangent*scale*mapN.y+n*mapN.z);
    }else if(m.extra.z>=0){
        float2 bumpUv=float2(uv.x,m.mapFlags.y>0?1-uv.y:uv.y);float height=imageSurface((int)m.extra.z,bumpUv).r*m.normals.z;
        float3 r1=cross(q1,n),r2=cross(n,q0);float det=dot(q0,r1);
        n=normalize(abs(det)*n-sign(det)*(ddx(height)*r1+ddy(height)*r2));
    }return n;
}
void cullSide(Material m, bool front) { if ((m.options.z < 0.5 && !front) || (m.options.z > 1.5 && front)) discard; }
// Selection/ID mask: writes nativeId+1 (0=background) with the same alpha test and
// sidedness as the surface prepass, so picking matches what is actually on screen.
uint maskMain(Varying v,bool front:SV_IsFrontFace):SV_Target {
    Material m=materials[materialId];
    cullSide(m,front);
    // Match the color pass visibility (max(alphaTest,0.001)), not the prepass 0.5
    // representative-surface cutoff, so visible translucent surfaces are pickable.
    clip(surfaceAlpha(m,surfaceUv(m,v.uv))-max(m.options.x,0.001));
    return materialId+1;
}
// Depth-only variant for the mask depth pass: same alpha clip so alpha holes do not
// write depth (rear surfaces remain pickable through them). No color output.
void maskDepthMain(Varying v,bool front:SV_IsFrontFace) {
    Material m=materials[materialId];
    cullSide(m,front);
    clip(surfaceAlpha(m,surfaceUv(m,v.uv))-max(m.options.x,0.001));
}
struct PrepassOutput { float4 normal : SV_Target0; float4 surface : SV_Target1; float4 motion : SV_Target2; };
PrepassOutput normalMain(Varying v, bool front : SV_IsFrontFace, uint primitive : SV_PrimitiveID) {
    Material m = materials[materialId]; cullSide(m, front); float a = surfaceAlpha(m, surfaceUv(m, v.uv));
    clip(a - max(m.options.x, m.options.y > 0 ? 0.5 : 0.001));
    PrepassOutput o;
    // Occluder disks must describe the actual rasterized surface. Interpolated
    // or normal-mapped lighting normals can put the surface itself inside its
    // sampling hemisphere, creating triangle-shaped self-occlusion.
    float3 viewPosition = mul(view, float4(v.world, 1)).xyz;
    float3 geometric = normalize(cross(normalize(ddx(viewPosition)), normalize(ddy(viewPosition))));
    geometric *= dot(geometric, -viewPosition) >= 0 ? 1 : -1;
    o.normal = float4(geometric, v.depth);
    o.surface = float4(v.world, (front ? 1.0 : -1.0) * (triangleOffset + primitive + 1));
    o.motion = float4(v.previousWorld, 1);
    return o;
}
// Round outward after offsetting: adding a small offset to a large coordinate can
// otherwise round back onto the surface. Use the smallest normal float at zero
// because GPU arithmetic is allowed to flush subnormals.
float roundAway(float value, float direction) {
    if (direction == 0) return value;
    if (abs(value) < 1.175494351e-38) return direction > 0 ? 1.175494351e-38 : -1.175494351e-38;
    return asfloat(asint(value) + ((value > 0) == (direction > 0) ? 1 : -1));
}
float3 offsetShadowOrigin(float3 p, float3 normal, float distance) {
    precise float3 origin = mad(distance, normal, p);
    return float3(roundAway(origin.x, normal.x), roundAway(origin.y, normal.y), roundAway(origin.z, normal.z));
}
struct ShadowSurface { float3 origin; float3 normal; };
ShadowSurface triangleShadowSurface(float3 p, uint primitive, bool front) {
    // SV_PrimitiveID restarts for each material draw; the BLAS uses global indices.
    uint3 indices = triangles[primitive].xyz;
    float3 v0 = vertices[indices.x].position;
    precise float3 e1 = vertices[indices.y].position - v0;
    precise float3 e2 = vertices[indices.z].position - v0;
    float3 edgeMax = max(abs(e1), abs(e2));
    float edgeScale = max(max(edgeMax.x, edgeMax.y), max(edgeMax.z, 1.175494351e-38));
    float3 normal = cross(e1 / edgeScale, e2 / edgeScale);
    float normalLength = length(normal);
    normal = normalLength > 0 ? normal / normalLength : float3(0,0,0);
    if (!front) normal = -normal;

    // Raster interpolation is not a ray hit reconstruction. Reproject its position
    // onto this triangle's plane before applying an error-sized geometric offset.
    // Both rasterization and the identity-instance BLAS read these same world-space
    // vertices, including skin/morph updates, so no object transform term is needed.
    precise float3 delta = p - v0;
    precise float planeDistance = dot(delta, normal);
    precise float3 onPlane = mad(-planeDistance, normal, p);
    const float unitRoundoff = 5.960464478e-8;
    float3 extent3 = abs(e1) + abs(e2) + abs(abs(e1) - abs(e2));
    float extent = max(max(extent3.x, extent3.y), extent3.z);
    // Conservative allowance for plane projection/rounding, plus the triangle
    // intersection term from NVIDIA's DXR self-intersection analysis (3 * u).
    // This is an estimate for the raster path, not a universal hardware guarantee.
    float3 error = 4 * unitRoundoff * (abs(v0) + abs(p) + abs(delta)) + 3 * unitRoundoff * extent;
    ShadowSurface surface;
    surface.normal = normal;
    surface.origin = offsetShadowOrigin(onPlane, normal, dot(error, abs(normal)));
    return surface;
}
float shadowHitDistance(float3 p, float3 direction) {
    RayDesc ray; ray.Origin = p; ray.Direction = direction; ray.TMin = 0; ray.TMax = max(misc.z * 8, 1);
    RayQuery<RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH> q;
    q.TraceRayInline(scene, RAY_FLAG_NONE, 255, ray);
    while (q.Proceed()) {
        if (q.CandidateType() != CANDIDATE_NON_OPAQUE_TRIANGLE) continue;
        uint4 tri = triangles[q.CandidatePrimitiveIndex()]; Material m = materials[tri.w];
        // Shadow rays travel receiver -> light. Raster front-face culling would
        // incorrectly remove thin single-sided casters when hit from underneath.
        float2 b = q.CandidateTriangleBarycentrics();
        float2 uv = vertices[tri.x].uv * (1 - b.x - b.y) + vertices[tri.y].uv * b.x + vertices[tri.z].uv * b.y;
        if (surfaceAlpha(m, surfaceUv(m, uv)) >= max(m.options.x, 0.5)) q.CommitNonOpaqueTriangleHit();
    }
    return q.CommittedStatus() == COMMITTED_TRIANGLE_HIT ? q.CommittedRayT() : -1;
}
bool blocked(float3 p, float3 direction) { return shadowHitDistance(p,direction) >= 0; }
float shadowVisibility(float3 origin, float3 geometricNormal, float2 pixel) {
    if (settings.z == 0) return 1;
    float3 l = normalize(sun.xyz), tangent = normalize(cross(abs(l.y) < 0.95 ? float3(0,1,0) : float3(1,0,0), l));
    float3 bitangent = cross(l, tangent);
    float phase = frac(52.9829189 * frac(dot(pixel, float2(0.06711056,0.00583715)))) * 6.2831853;
    float visibility = 0; uint samples = clamp((uint)ao.z, 1u, 128u);
    for (uint i = 0; i < samples; ++i) {
        float r = sqrt((i + 0.5) / samples) * viewport.z;
        float a = i * 2.39996323 + phase;
        float3 ray = normalize(l + r * (cos(a) * tangent + sin(a) * bitangent));
        // Reflection shadows stay on the visible geometric side. Moving the origin
        // to the light-facing back side would let light through thin opaque surfaces.
        if (dot(geometricNormal, ray) > 0) visibility += blocked(origin, ray) ? 0 : 1;
    }
    return visibility / samples;
}
#include "temporal-shadow.hlsl"
float3 directionOr(float3 direction, float3 fallback) {
    float length2 = dot(direction, direction);
    return all(isfinite(direction)) && length2 > 1e-8 ? direction * rsqrt(length2) : fallback;
}
float4 occlusionAt(int2 pixel) {
    float4 center = normalDepth.Load(int3(pixel, 0));
    if (settings.w == 0 || ao.x == 0 || center.w == 0) return float4(1, center.xyz);
    float weight = 0, total = 0;
    float3 bentDelta = 0;
    float bentWeight = 0;
    for (int y = -2; y <= 2; ++y) for (int x = -2; x <= 2; ++x) {
        int2 p = clamp(pixel + int2(x,y), int2(0,0), int2(viewport.xy)-1);
        float4 neighbor = normalDepth.Load(int3(p,0));
        float w = exp(-0.5 * (x*x+y*y)) * pow(saturate(dot(center.xyz, neighbor.xyz)), 8);
        w *= saturate(1 - abs(center.w - neighbor.w) / max(viewport.w * 0.1, center.w * 0.001));
        if (neighbor.w == 0) w = 0;
        float4 sampleAO = rawAO.Load(int3(p,0));
        total += sampleAO.x * w; weight += w;
        // A fully blocked sample has no preferred direction. Weight directions
        // by visibility so its fallback normal cannot pull open neighbors.
        bentDelta += (sampleAO.yzw - neighbor.xyz) * (sampleAO.x * w);
        bentWeight += sampleAO.x * w;
    }
    float visibility = saturate(1 - (1 - (weight > 0 ? total / weight : 1)) * ao.x);
    // Filter the bend, not the underlying surface normal: fully open curved
    // surfaces and normal maps must not acquire a blur-induced lighting tilt.
    float3 bent = directionOr(center.xyz + bentDelta / max(bentWeight, 1e-8), center.xyz);
    bent = directionOr(lerp(center.xyz, bent, saturate(ao.x)), center.xyz);
    return float4(visibility, bent);
}
float visibilityAt(int2 pixel) { return occlusionAt(pixel).x; }
#include "shading-context.hlsl"
// Shared Lambert base and directional indirect lighting for all shader stacks.
void baseShading(Varying v, bool front, uint primitive, inout ShadingContext ctx) {
    Material m = materials[materialId]; cullSide(m, front); float2 uv = surfaceUv(m, v.uv);
    float alpha = surfaceAlpha(m, uv); clip(alpha - max(m.options.x, 0.001));
    float3 n = surfaceNormal(v, front,m);
    float ndl = dot(n, normalize(sun.xyz));
    float shade = 1;
    if (settings.z != 0 && ao.y == 0) {
        uint globalPrimitive = triangleOffset + primitive;
        float key = (front ? 1.0 : -1.0) * (globalPrimitive + 1);
        if (temporalInfo.w != 0 && shadowSurface.Load(int3(int2(v.position.xy),0)).w == key)
            shade = shadowResolved.Load(int3(int2(v.position.xy),0)).x;
        else {
            ShadowSurface surface = triangleShadowSurface(v.shadowWorld, globalPrimitive, front);
            // MSAA silhouettes / secondary transparent layers have no matching history.
            shade = temporalInfo.w != 0 ? traceShadow(surface.origin,surface.normal,v.position.xy).x : shadowVisibility(surface.origin, surface.normal, v.position.xy);
        }
    }
    // Neutral Lambert base; toon/stylized looks are shader stacks (e.g. Default Toon).
    float direct = max(ndl, 0) * shade;
    int2 pixel = int2(v.position.xy);
    float4 occlusion = occlusionAt(pixel);
    float3 bentNormal = n;
    // Only the visible prepass surface owns this bent normal (MSAA edges and
    // secondary transparent layers can belong to a different surface).
    float surfaceKey = (front ? 1.0 : -1.0) * (triangleOffset + primitive + 1);
    if (settings.w != 0 && ao.x > 0 && shadowSurface.Load(int3(pixel,0)).w == surfaceKey)
    {
        // Transfer only the occlusion-induced bend to the lighting normal.
        // Smooth normals and normal maps still shape the light; the AO basis
        // must not turn an open smooth mesh into a faceted lighting surface.
        float3 bend = occlusion.yzw - normalDepth.Load(int3(pixel,0)).xyz;
        bentNormal = directionOr(n + mul(transpose((float3x3)view), bend), n);
    }
    float3 fill = evaluateAmbient(bentNormal, bentNormal.y * 0.5 + 0.5);
    float screenAO = occlusion.x;
    float materialAO = saturate(1 + (imageSample(m.maps.w, uv).r - 1) * m.options.w);
    float3 base=imageSurface(m.maps.x,uv).rgb,emissive=imageSurface(m.maps.z,uv).rgb;
    float3 albedo = m.color.rgb * (m.mapFlags.z>0?decodeSRGB(base):base);
    float3 emission = m.emission.rgb * (m.mapFlags.w>0?decodeSRGB(emissive):emissive);
    float3 lit = albedo * (direct * sun.w + fill * min(materialAO, screenAO)) / 3.141592653589793 + emission;
    ctx.worldPos = v.world; ctx.normal = n; ctx.geoNormal = n; ctx.bentNormal = bentNormal; ctx.uv = uv;
    ctx.viewDir = normalize(-mul(transpose((float3x3)view),float3(view[0][3],view[1][3],view[2][3])) - v.world);
    ctx.depth = v.depth; ctx.pixel = v.position.xy; ctx.front = front ? 1.0 : -1.0;
    ctx.albedo = albedo; ctx.emission = emission; ctx.alpha = alpha; ctx.materialColor = m.color.rgb;
    ctx.ndl = ndl; ctx.direct = direct; ctx.shade = shade; ctx.fill = fill; ctx.ao = min(materialAO, screenAO);
    ctx.sunDir = normalize(sun.xyz); ctx.sunLux = sun.w; ctx.skyColor = sky.rgb; ctx.groundColor = ground.rgb;
    ctx.ambientLux = sky.w; ctx.materialId = materialId;
    ctx.viewportSize = viewport.xy;
    ctx.lightDirScreen = mul((float3x3)view, ctx.sunDir).xy * float2(0.5, -0.5);
    ctx.color = lit;
}
// User stack injection point. The build-time default is empty (no layers); the
// runtime generator replaces this with sequential calls to user void functions.
void runUserStack(inout ShadingContext ctx) { }
float4 colorMain(Varying v, bool front : SV_IsFrontFace, uint primitive : SV_PrimitiveID) : SV_Target {
    ShadingContext ctx;
    baseShading(v, front, primitive, ctx);
    runUserStack(ctx);
    return float4(ctx.color / 100.0, ctx.alpha);
}

#define CORTAO_HLSL 1
#define CORTAO_16_BIT 0
#define CORTAO_PERSPECTIVE_PROJECTION 1
#define CORTAO_SAMPLE_COUNT 32
#define CORTAO_RAY_COUNT 32
#define CORTAO_OCCLUDER_LOOKUP_TABLE 1
#include "CORTAOMainPass.h"
float3 cortao_loadNormal(int2 p) { float3 n = normalDepth.Load(int3(p,0)).xyz; return n.z < -0.99999 ? normalize(n + float3(0.0001,0,0.0001)) : n; }
uint cortao_samplePackedData(float2 uv, float level) {
    if (any(uv < 0) || any(uv >= 1)) return 0;
    uint mip = min(7u, (uint)max(0, floor(level + 0.5)));
    uint4 info = mipInfo[mip]; uint2 p = min(uint2(uv * info.xy), info.xy-1);
    return packed[info.z + p.y * info.x + p.x];
}
uint cortao_sampleOccluderLookupTable(float3 uv) { return any(isnan(uv)) || any(isinf(uv)) ? 0 : occluderLut.Load(int4(clamp(int3(uv * float3(32,32,24)), int3(0,0,0), int3(31,31,23)), 0)); }
void cortao_writeResult(int2 p, float visibility, float3 bentNormal, float3x3 basis, uint bits) {
    float3 normal = normalDepth[p].xyz;
    // The finite 32-ray set has a small directional bias even when fully open;
    // use the exact surface normal there. Fully blocked rays can produce NaN.
    float3 bent = bits == 0 || visibility <= 0 ? normal : directionOr(bentNormal, normal);
    aoOut[p] = float4(visibility, bent);
}
[numthreads(8,8,1)] void packMain(uint3 tid : SV_DispatchThreadID) {
    if (any(tid.xy >= uint2(viewport.xy))) return;
    float4 n = normalDepth[tid.xy]; uint value = 0;
    if (n.w > 0) {
        uint seed = cortao_hash(cortao_seed(tid.xy) + 0x7123ab49u);
        float2 dither = float2(cortao_unpack16(seed)) / 65535.0;
        uint mask = (1u << CORTAO_PACKED_NORMAL_BITS)-1;
        value = (asuint(n.w) & ~mask) | (cortao_encodeNormal(cortao_loadNormal(int2(tid.xy)), dither) & mask);
    }
    packedOut[tid.y * uint(viewport.x) + tid.x] = value;
}
[numthreads(8,8,1)] void mipMain(uint3 tid : SV_DispatchThreadID) {
    uint4 dst = mipInfo[mipLevel], src = mipInfo[mipLevel-1]; if (any(tid.xy >= dst.xy)) return;
    uint2 dither = uint2(0x7123ab49u,0x7123ab49u) >> uint2(mipLevel*2, mipLevel*2+1);
    uint2 p = min(tid.xy * 2 + ((tid.yx ^ dither) & 1), src.xy-1);
    packedOut[dst.z + tid.y * dst.x + tid.x] = packedOut[src.z + p.y * src.x + p.x];
}
[numthreads(8,8,1)] void cortaoMain(uint3 tid : SV_DispatchThreadID) {
    if (any(tid.xy >= uint2(viewport.xy))) return;
    aoOut[tid.xy] = float4(1, normalDepth[tid.xy].xyz);
    if (settings.w == 0 || normalDepth[tid.xy].w == 0) return;
    CORTAOMainPassParameters p = (CORTAOMainPassParameters)0;
    p.packedResolution = (uint(viewport.x) | (uint(viewport.y) << 16)); p.randomSeed = 0x7123ab49u;
    p.normalBias = (1.0 / projection[0][0]) / viewport.x * sqrt(2.0); p.radius = viewport.w;
    p.unprojectParams = float4(2/projection[0][0], -2/projection[1][1], (-1+2*aaJitter.x/viewport.x)/projection[0][0], (1-2*aaJitter.y/viewport.y)/projection[1][1]);
    p.projectionParams = float4(projection[0][0] * 0.5, -projection[1][1] * 0.5, -0.5+aaJitter.x/viewport.x, -0.5+aaJitter.y/viewport.y);
    float r = (1 / projection[1][1]) * 0.4; p.maxApparentCircleRadiusCoefficient = r / sqrt(r*r+1);
    p.mipBias = log2(projection[1][1] * viewport.y * 0.5) - 4;
    p.inverseMaxSlopeCompensation = 0.25; p.backfaceThreshold = 0.5;
    cortao_mainPass(tid.xy, p);
}
#include "grid.hlsl"
[numthreads(8,8,1)] void outputMain(uint3 tid : SV_DispatchThreadID) {
    if (any(tid.xy >= uint2(aaInfo.xy))) return;
    if (ao.y > 0) {
        if (ao.y == 3) {
            float3 bent = directionOr(mul(transpose((float3x3)view), occlusionAt(int2(tid.xy)).yzw), float3(0,1,0));
            output[tid.xy] = float4(normalDepth[tid.xy].w > 0 ? bent * 0.5 + 0.5 : float3(0.14,0.14,0.14), 1); return;
        }
        float visible = ao.y == 2 ? rawAO[tid.xy].x : visibilityAt(int2(tid.xy));
        output[tid.xy] = float4((normalDepth[tid.xy].w > 0 ? visible : 0.14).xxx, 1); return;
    }
    float4 hdr = aaInfo.z>0?aaResult[tid.xy]:hdrColor[tid.xy];
    hdr.a=saturate(hdr.a);
    float3 rgb = gt7ToneMap(hdr.rgb / max(hdr.a, 0.00001) * settings.x);
    float3 bg=background.rgb;
    if(hdr.a<1 && (settings.z>0 || background.w>0)) {
        float3 origin=-mul(transpose((float3x3)view),float3(view[0][3],view[1][3],view[2][3]));
        float2 uv=(float2(tid.xy)+0.5)/aaInfo.xy;
        int2 inputPixel=clamp(int2(uv*viewport.xy-aaJitter.xy),0,int2(viewport.xy)-1);
        float3 ray=mul(transpose((float3x3)view),float3((uv.x*2-1)/projection[0][0],(1-uv.y*2)/projection[1][1],-1));
        float3 direction=normalize(ray);
        float t=(misc.x-origin.y)/direction.y;
        if(t>0 && direction.y<-0.00001) {
            float3 p=origin+direction*t;float2 coord=p.xz-grid.xy;
            float fade=1-smoothstep(misc.z*0.35,misc.z*0.65,length(coord));
            if(settings.z>0 && fade>0) {
                // The analytic ground has an exact Y plane and is not in the BLAS.
                // Snap Y to it rather than retaining the camera-ray intersection error.
                float3 groundOrigin = float3(p.x, roundAway(misc.x, 1), p.z);
                float groundShade = temporalInfo.w != 0 && shadowSurface[inputPixel].w == GROUND_KEY ? shadowResolved[inputPixel].x :
                    temporalInfo.w != 0 ? traceShadow(groundOrigin,float3(0,1,0),float2(tid.xy)).x : shadowVisibility(groundOrigin,float3(0,1,0),float2(tid.xy));
                bg*=1-0.5*(1-groundShade)*fade;
            }
            if(background.w>0) bg=compositeGrid(bg,origin,ray,coord);
        }
    }
    rgb = lerp(bg, rgb, hdr.a);
    float4 result = float4(encodeSRGB(saturate(rgb)), 1);
    // Object selection outline (Blender/Unreal style): a uniform outer-silhouette
    // ring in display space, drawn AFTER temporal reconstruction so the UI highlight
    // never mixes into AA history. Outer-only: background pixels adjacent to the
    // selection mask. sharpening.y carries the object-selected flag.
    if (sharpening.y != 0) {
        // Center and neighbors use the SAME output->mask coordinate map (fractional
        // phase preserved) so the ring is symmetric and width-stable across AA modes.
        float2 outc=float2(tid.xy)+0.5;
        float2 rsc=viewport.xy/aaInfo.xy;
        // round() keeps the fractional phase symmetric for +/- offsets.
        int2 sp=clamp(int2(outc*rsc+0.5),0,int2(viewport.xy)-1);
        if (selectionMask[sp]==0) {
            const int R=2; uint ring=0;
            [unroll] for(int dy=-R;dy<=R;dy++) [unroll] for(int dx=-R;dx<=R;dx++) {
                if(dx*dx+dy*dy>R*R) continue;
                int2 q=clamp(int2((outc+float2(dx,dy))*rsc+0.5),0,int2(viewport.xy)-1);
                ring |= (selectionMask[q]!=0)?1u:0u;
            }
            if(ring!=0) result.rgb=lerp(result.rgb,float3(1.0,0.604,0.239),0.9);
        }
    }
    // Sharpening reads finished neighbors, so the composite lands in an
    // intermediate surface first; sharpenMain then writes the shared output.
    if (sharpening.x > 0) compositeOut[tid.xy] = result; else output[tid.xy] = result;
}
#include "antialiasing.hlsl"
