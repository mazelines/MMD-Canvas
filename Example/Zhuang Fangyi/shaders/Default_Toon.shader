{
  "format": "mmd-canvas-shader",
  "version": 1,
  "name": "Default Toon",
  "outline": true,
  "metadata": {
    "tags": [],
    "modifiedAt": "2026-11-20T02:52:47.040Z"
  },
  "layers": [
    {
      "id": "layer-2",
      "name": "DepthRimLight",
      "code": "//@property float width = 1.0 [0,3] \"림 폭\"\n//@property float bias = 0.1 [0,1] \"깊이 임계값\"\n//@property float fade = 0.3 [0.01,1] \"전이 폭\"\n//@property float intensity = 1.0 [0,2] \"강도\"\n//@property float3 rimColor = (1,1,1) \"림 색상\"\nvoid DepthRimLight(inout ShadingContext ctx) {\n    // Light-facing variant: width is linear, in 3-pixel units at 1080p.\n    float2 direction = ctx.lightDirScreen / max(length(ctx.lightDirScreen), 1e-5);\n    float2 samplePixel = ctx.pixel + direction * (3.0 * width) * (ctx.viewportSize.y / 1080.0);\n    // Off-screen depth is unknown; do not turn the viewport border into a rim.\n    if (any(samplePixel < 0) || any(samplePixel >= ctx.viewportSize)) return;\n    float neighborDepth = sampleSceneDepth(samplePixel);\n    float rel = (neighborDepth - ctx.depth) / max(ctx.depth, 0.001);\n    // Background is 0 in this renderer, and represents open space beyond the silhouette.\n    float mask = neighborDepth <= 0 ? 1.0 : smoothstep(bias, bias + max(fade, 1e-5), rel);\n    ctx.color += rimColor * mask * intensity;\n}",
      "enabled": true
    },
    {
      "id": "toon-band",
      "name": "ToonBand",
      "code": "//@property float shadowFloor = 0.251 [0,1] \"그림자 바닥\"\nvoid ToonBand(inout ShadingContext ctx) {\n    float band = ctx.ndl < 0 ? shadowFloor : 1.0;\n    float toonDirect = lerp(shadowFloor, band, ctx.shade);\n    ctx.color += ctx.albedo * (toonDirect - ctx.direct) * ctx.sunLux / 3.141592653589793;\n}",
      "enabled": true
    },
    {
      "id": "toon-fill",
      "name": "ToonFill",
      "code": "void ToonFill(inout ShadingContext ctx) {\n    float3 flatFill = evaluateAmbient(ctx.bentNormal, 0.5);\n    ctx.color += ctx.albedo * (flatFill - ctx.fill) * ctx.ao / 3.141592653589793;\n}",
      "enabled": true
    }
  ]
}
