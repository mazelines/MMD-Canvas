// Scene-linear DX12 material lighting. DXR visibility is evaluated before EV100 / GT7.
#include "gt7.hlsl"
struct Vertex { float3 position; float3 normal; float2 uv; };
struct Material { float4 color; float4 emission; int4 maps; float4 options; float4 uvTransform; float4 extra; float4 normals; float4 mapFlags; };
cbuffer Frame : register(b0) {
    float4x4 view;
    float4x4 projection;
    float4 sun;              // towards light, lux
    float4 sky;              // linear RGB, ambient lux
    float4 ground;
    float4 viewport;         // width, height, tan(light angular radius), AO world radius
    float4 settings;         // EV exposure scale, toon, shadows, AO enabled
    float4 ao;               // strength, debug: 0/color 1/filtered 2/raw, shadow samples, bias
    float4 background;       // display-linear background, grid enabled
    float4 misc;             // ground height, grid size, model diagonal, outline width
    float4 outlineColor;     // exposure-protected scene-linear outline RGB
    float4 grid;             // center X/Z, width, cell size
    uint4 mipInfo[8];        // width, height, packed offset, unused
};
cbuffer Draw : register(b1) { uint materialId; uint mipLevel; uint triangleOffset; uint unused1; };
StructuredBuffer<Vertex> vertices : register(t0);
StructuredBuffer<uint4> triangles : register(t1);
StructuredBuffer<Material> materials : register(t2);
RaytracingAccelerationStructure scene : register(t3);
Texture2D<float4> normalDepth : register(t4);
StructuredBuffer<uint> packed : register(t5);
Texture2D<float> rawAO : register(t6);
Texture3D<uint> occluderLut : register(t7);
Texture2D<float4> images[128] : register(t8);
Texture2D<float4> hdrColor : register(t136);
RWStructuredBuffer<uint> packedOut : register(u0);
RWTexture2D<float> aoOut : register(u1);
RWTexture2D<float4> output : register(u2);
SamplerState linearWrap : register(s0);
SamplerState nearestClamp : register(s1);
float3 decodeSRGB(float3 c) { return select(c <= 0.04045, c / 12.92, pow((c + 0.055) / 1.055, 2.4)); }
float3 encodeSRGB(float3 c) { return select(c <= 0.0031308, c * 12.92, 1.055 * pow(max(c, 0), 1.0 / 2.4) - 0.055); }
float4 imageSample(int id, float2 uv) { return id < 0 ? float4(1,1,1,1) : images[NonUniformResourceIndex(id)].SampleLevel(linearWrap, uv, 0); }
float4 imageSurface(int id, float2 uv) { return id < 0 ? float4(1,1,1,1) : images[NonUniformResourceIndex(id)].Sample(linearWrap, uv); }
float2 surfaceUv(Material m, float2 uv) { uv = uv * m.uvTransform.xy + m.uvTransform.zw; return float2(uv.x, m.extra.x > 0 ? 1 - uv.y : uv.y); }
float surfaceAlpha(Material m, float2 uv) { return m.color.a * imageSample(m.maps.x, uv).a * imageSample(m.maps.y, uv).g; }
struct Varying { float4 position : SV_Position; float3 world : TEXCOORD0; float3 normal : TEXCOORD1; float2 uv : TEXCOORD2; float depth : TEXCOORD3; centroid float3 shadowWorld : TEXCOORD4; };
Varying vertexMain(uint id : SV_VertexID) {
    Vertex v = vertices[id]; Varying o; o.world = o.shadowWorld = v.position; o.normal = v.normal; o.uv = v.uv;
    float4 p = mul(view, float4(v.position, 1)); o.position = mul(projection, p); o.depth = -p.z; return o;
}
Varying outlineVertex(uint id : SV_VertexID) {
    Varying o=vertexMain(id);float4 n=mul(projection,float4(mul((float3x3)view,o.normal),0));
    float2 direction=(n.xy*o.position.w-o.position.xy*n.w)*viewport.xy;
    if(length(direction)>0.00001)o.position.xy+=normalize(direction)*(2*misc.w/viewport.xy)*o.position.w;
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
float4 normalMain(Varying v, bool front : SV_IsFrontFace) : SV_Target {
    Material m = materials[materialId]; cullSide(m, front); float a = surfaceAlpha(m, surfaceUv(m, v.uv));
    clip(a - max(m.options.x, m.options.y > 0 ? 0.5 : 0.001));
    return float4(mul((float3x3)view, surfaceNormal(v, front,m)), v.depth);
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
    uint3 indices = triangles[triangleOffset + primitive].xyz;
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
bool blocked(float3 p, float3 direction) {
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
    return q.CommittedStatus() == COMMITTED_TRIANGLE_HIT;
}
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
float visibilityAt(int2 pixel) {
    if (settings.w == 0 || ao.x == 0) return 1;
    float4 center = normalDepth.Load(int3(pixel, 0));
    if (center.w == 0) return 1;
    float weight = 0, total = 0;
    for (int y = -2; y <= 2; ++y) for (int x = -2; x <= 2; ++x) {
        int2 p = clamp(pixel + int2(x,y), int2(0,0), int2(viewport.xy)-1);
        float4 neighbor = normalDepth.Load(int3(p,0));
        float w = exp(-0.5 * (x*x+y*y)) * pow(saturate(dot(center.xyz, neighbor.xyz)), 8);
        w *= saturate(1 - abs(center.w - neighbor.w) / max(viewport.w * 0.1, center.w * 0.001));
        if (neighbor.w == 0) w = 0;
        total += rawAO.Load(int3(p,0)) * w; weight += w;
    }
    return saturate(1 - (1 - (weight > 0 ? total / weight : 1)) * ao.x);
}
float4 colorMain(Varying v, bool front : SV_IsFrontFace, uint primitive : SV_PrimitiveID) : SV_Target {
    Material m = materials[materialId]; cullSide(m, front); float2 uv = surfaceUv(m, v.uv);
    float alpha = surfaceAlpha(m, uv); clip(alpha - max(m.options.x, 0.001));
    float3 n = surfaceNormal(v, front,m);
    float ndl = dot(n, normalize(sun.xyz));
    float shade = 1;
    if (settings.z != 0) {
        ShadowSurface surface = triangleShadowSurface(v.shadowWorld, primitive, front);
        shade = shadowVisibility(surface.origin, surface.normal, v.position.xy);
    }
    float band = settings.y > 0 ? (ndl * 0.5 + 0.5 < 0.5 ? 64.0/255.0 : 1) : max(ndl, 0);
    float direct = settings.y > 0 ? lerp(64.0/255.0, band, shade) : band * shade;
    float3 fill = lerp(ground.rgb, sky.rgb, settings.y > 0 ? 0.5 : n.y * 0.5 + 0.5) * sky.w;
    float screenAO = visibilityAt(int2(v.position.xy));
    float materialAO = saturate(1 + (imageSample(m.maps.w, uv).r - 1) * m.options.w);
    float3 base=imageSurface(m.maps.x,uv).rgb,emissive=imageSurface(m.maps.z,uv).rgb;
    float3 albedo = m.color.rgb * (m.mapFlags.z>0?decodeSRGB(base):base);
    float3 emission = m.emission.rgb * (m.mapFlags.w>0?decodeSRGB(emissive):emissive);
    float3 lit = albedo * (direct * sun.w + fill * min(materialAO, screenAO)) / 3.141592653589793 + emission;
    return float4(lit / 100.0, alpha);
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
void cortao_writeResult(int2 p, float visibility, float3 bentNormal, float3x3 basis, uint bits) { aoOut[p] = visibility; }
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
    aoOut[tid.xy] = 1;
    if (settings.w == 0 || normalDepth[tid.xy].w == 0) return;
    CORTAOMainPassParameters p = (CORTAOMainPassParameters)0;
    p.packedResolution = (uint(viewport.x) | (uint(viewport.y) << 16)); p.randomSeed = 0x7123ab49u;
    p.normalBias = (1.0 / projection[0][0]) / viewport.x * sqrt(2.0); p.radius = viewport.w;
    p.unprojectParams = float4(2/projection[0][0], -2/projection[1][1], -1/projection[0][0], 1/projection[1][1]);
    p.projectionParams = float4(projection[0][0] * 0.5, -projection[1][1] * 0.5, -0.5, -0.5);
    float r = (1 / projection[1][1]) * 0.4; p.maxApparentCircleRadiusCoefficient = r / sqrt(r*r+1);
    p.mipBias = log2(projection[1][1] * viewport.y * 0.5) - 4;
    p.inverseMaxSlopeCompensation = 0.25; p.backfaceThreshold = 0.5;
    cortao_mainPass(tid.xy, p);
}
[numthreads(8,8,1)] void outputMain(uint3 tid : SV_DispatchThreadID) {
    if (any(tid.xy >= uint2(viewport.xy))) return;
    if (ao.y > 0) {
        float visible = ao.y > 1 ? rawAO[tid.xy] : visibilityAt(int2(tid.xy));
        output[tid.xy] = float4((normalDepth[tid.xy].w > 0 ? visible : 0.14).xxx, 1); return;
    }
    float4 hdr = hdrColor[tid.xy]; float3 rgb = gt7ToneMap(hdr.rgb / max(hdr.a, 0.00001) * settings.x);
    float3 bg=background.rgb;
    if(hdr.a<1 && (settings.z>0 || background.w>0)) {
        float3 origin=-mul(transpose((float3x3)view),float3(view[0][3],view[1][3],view[2][3]));
        float2 uv=(float2(tid.xy)+0.5)/viewport.xy;
        float3 direction=mul(transpose((float3x3)view),normalize(float3((uv.x*2-1)/projection[0][0],(1-uv.y*2)/projection[1][1],-1)));
        float t=(misc.x-origin.y)/direction.y;
        if(t>0 && direction.y<-0.00001) {
            float3 p=origin+direction*t;float2 coord=p.xz-grid.xy;
            float fade=1-smoothstep(misc.z*0.35,misc.z*0.65,length(coord));
            if(settings.z>0 && fade>0) {
                // The analytic ground has an exact Y plane and is not in the BLAS.
                // Snap Y to it rather than retaining the camera-ray intersection error.
                float3 groundOrigin = float3(p.x, roundAway(misc.x, 1), p.z);
                bg*=1-0.5*(1-shadowVisibility(groundOrigin,float3(0,1,0),float2(tid.xy)))*fade;
            }
            if(background.w>0 && all(abs(coord)<grid.z*0.5)) {
                float pixelWorld=max(t*2/(projection[1][1]*viewport.y),0.000001);
                float2 edge=abs(frac(coord/grid.w+0.5)-0.5)*grid.w;
                float coverage=1-smoothstep(pixelWorld*0.2,pixelWorld*0.8,min(edge.x,edge.y));
                float3 color=decodeSRGB(min(abs(coord.x),abs(coord.y))<pixelWorld?float3(90,96,112)/255.0:float3(54,58,68)/255.0);
                bg=lerp(bg,color,coverage);
            }
        }
    }
    rgb = lerp(bg, rgb, hdr.a);
    output[tid.xy] = float4(encodeSRGB(saturate(rgb)), 1);
}
