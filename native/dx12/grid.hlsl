// Editor overlay, evaluated in unjittered OUTPUT pixels after reconstruction.
// Compute shaders have no screen derivatives: differentiate the ray/plane
// intersection analytically. A distance-only footprint misses the foreshortening
// of the ground and aliases badly when the camera looks along it.
float3 compositeGrid(float3 bg, float3 origin, float3 ray, float2 coord) {
    float3 rayDx = mul(transpose((float3x3)view), float3(2 / (projection[0][0] * aaInfo.x), 0, 0));
    float3 rayDy = mul(transpose((float3x3)view), float3(0, -2 / (projection[1][1] * aaInfo.y), 0));
    float planeT = (misc.x - origin.y) / ray.y;
    float2 dx = (planeT * (rayDx - ray * (rayDx.y / ray.y))).xz;
    float2 dy = (planeT * (rayDy - ray * (rayDy.y / ray.y))).xz;
    float2 footprint = max(sqrt(dx * dx + dy * dy), 1e-6);
    float cell = max(grid.w, 1e-6);
    float2 distanceToLine = abs(frac(coord / cell + 0.5) - 0.5) * cell;
    // Approximately one output pixel wide at every view angle. Fade each family
    // of lines before its projected period falls below two pixels (Nyquist).
    float2 lines = 1 - smoothstep(0, 1, distanceToLine / footprint);
    lines *= 1 - smoothstep(0.125, 0.5, footprint / cell);
    float minor = 1 - (1 - lines.x) * (1 - lines.y);
    // Draw the two center axes independently, avoiding a hard color switch on
    // neighboring minor lines. Their 1.5-pixel width survives grid minification.
    float2 axes = 1 - smoothstep(0.25, 1.25, abs(coord) / footprint);
    float major = 1 - (1 - axes.x) * (1 - axes.y);
    float2 bounds = saturate((grid.z * 0.5 - abs(coord)) / footprint + 0.5);
    float extent = bounds.x * bounds.y;
    bg = lerp(bg, decodeSRGB(float3(54, 58, 68) / 255.0), minor * extent);
    return lerp(bg, decodeSRGB(float3(90, 96, 112) / 255.0), major * extent);
}
