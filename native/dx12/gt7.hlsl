// GT7 SDR color-volume mapping. See licenses/GT7-MIT.txt and docs/color-pipeline.md.

float3 gt7ToRec2020(float3 c) {
  return float3(dot(c, float3(0.627403896, 0.329283038, 0.043313066)),
              dot(c, float3(0.069097289, 0.919540395, 0.011362316)),
              dot(c, float3(0.016391439, 0.088013308, 0.895595253)));
}
float3 gt7ToRec709(float3 c) {
  return float3(dot(c, float3(1.660491002, -0.587641139, -0.072849863)),
              dot(c, float3(-0.124550475, 1.132899897, -0.008349422)),
              dot(c, float3(-0.018150763, -0.100578898, 1.118729661)));
}
float3 gt7PQ(float3 nits) {
  float3 p = pow(max(nits, ((float3)(0.0))) / 10000.0, ((float3)(2610.0 / 16384.0)));
  return pow((((float3)(3424.0 / 4096.0)) + (2413.0 / 128.0) * p)
    / (((float3)(1.0)) + (2392.0 / 128.0) * p), ((float3)(2523.0 / 32.0)));
}
float3 gt7InversePQ(float3 encoded) {
  float3 p = pow(clamp(encoded, 0.0, 1.0), ((float3)(32.0 / 2523.0)));
  return 10000.0 * pow(max(p - (3424.0 / 4096.0), ((float3)(0.0)))
    / ((2413.0 / 128.0) - (2392.0 / 128.0) * p), ((float3)(16384.0 / 2610.0)));
}
float3 gt7ToICtCp(float3 nits) {
  float3 lms = float3(dot(nits, float3(1688.0, 2146.0, 262.0)),
                  dot(nits, float3(683.0, 2951.0, 462.0)),
                  dot(nits, float3(99.0, 309.0, 3688.0))) / 4096.0;
  float3 p = gt7PQ(lms);
  return float3(0.5 * (p.x + p.y),
    dot(p, float3(6610.0, -13613.0, 7003.0)) / 4096.0,
    dot(p, float3(17933.0, -17390.0, -543.0)) / 4096.0);
}
float3 gt7FromICtCp(float3 c) {
  float3 lms = gt7InversePQ(float3(c.x + 0.00860904 * c.y + 0.11103 * c.z,
    c.x - 0.00860904 * c.y - 0.11103 * c.z,
    c.x + 0.560031 * c.y - 0.320627 * c.z));
  return max(float3(dot(lms, float3(3.43661, -2.50645, 0.0698454)),
    dot(lms, float3(-0.79133, 1.9836, -0.192271)),
    dot(lms, float3(-0.0259499, -0.0989137, 1.12486))), ((float3)(0.0)));
}
float gt7Curve(float x) {
  x = max(x, 0.0);
  const float peak = 2.5; // 250 nits / 100 nits reference
  const float gray = 0.538;
  const float section = 0.444;
  const float k = (section - 1.0) / (0.25 - 1.0);
  if (x < section * peak) {
    return lerp(gray * pow(x / gray, 1.280), x, smoothstep(0.0, gray, x));
  }
  // Equivalent to ka + kb * exp(kc*x), avoiding a large intermediate exponential.
  return peak * section + peak * k * (1.0 - exp((section - x / peak) / k));
}
float3 gt7ToneMap(float3 linearRec709) {
  float3 rgb = gt7ToRec2020(clamp(linearRec709, 0.0, 65504.0));
  float3 original = gt7ToICtCp(rgb * 100.0);
  float3 curved = float3(gt7Curve(rgb.r), gt7Curve(rgb.g), gt7Curve(rgb.b));
  float3 skewed = gt7ToICtCp(curved * 100.0);
  float peakI = gt7PQ(((float3)(250.0))).x;
  float chroma = 1.0 - smoothstep(0.98, 1.16, original.x / peakI);
  float3 restored = gt7FromICtCp(float3(skewed.x, original.yz * chroma)) / 100.0;
  float3 mapped = 0.4 * min(lerp(curved, restored, 0.6), ((float3)(2.5)));
  // The desktop viewport is SDR Rec.709; bound any remaining out-of-gamut channels.
  return clamp(gt7ToRec709(mapped), 0.0, 1.0);
}
