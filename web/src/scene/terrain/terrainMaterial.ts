// The one custom terrain shader (SPEC 9.3). Components, all driven by uniforms:
//   realistic shading  graded NAIP (imagery on) or a procedural albedo from FBFM40 + canopy (imagery off), procedural
//                      micro-detail + detail normals by slope / fuel / canopy, sun x baked soft terrain shadow x shadow
//                      map (trees), hemisphere sky x sky-view AO x cavity, water with animated glints that bloom
//   parametric relief  near-black relief with a faint hillshade (visualStyle "parametric", blended by uReliefMix)
//   observed fire      charcoal / ash (dNBR-modulated), ember glow decaying over ~6 h, incandescent animated front
//   isochrones         gold-white lines of equal arrival time (brighter every 4th, density-faded), front filament
//   contours           elevation lines, index line every 5th, fwidth anti-aliasing
//   forecast           P(burned by t) from p10/p50/p90 as a luminous field (hybrid/parametric) or a heat wash
//                      (realistic), crisp 10/50/90 % burn-probability contours and a dashed p50 front at t
//   burn scar, fuels   dNBR ramp and FBFM40 data-viz overlays
//   atmosphere         aerial perspective (height fog) and an edge fade into the sky colour
// Every overlay has an opacity uniform; emissive values > 1 are left in HDR so bloom picks them up.
import * as THREE from 'three'
import { ATMOSPHERE_GLSL, atmosphereUniforms } from '../atmosphere/atmosphere'

export const NOISE_GLSL = /* glsl */ `
float tHash(vec2 p) {
  uvec2 q = uvec2(ivec2(p));
  uint h = (q.x * 0x8da6b343u) ^ (q.y * 0xd8163841u);
  h ^= h >> 15; h *= 0x2c1b3c6du; h ^= h >> 12; h *= 0x297a2d39u; h ^= h >> 15;
  return float(h) * (1.0 / 4294967295.0);
}
// value noise in [0,1] with analytic derivatives (x: value, yz: d/dx, d/dy in noise units)
vec3 tNoised(vec2 x) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = tHash(i);
  float b = tHash(i + vec2(1.0, 0.0));
  float c = tHash(i + vec2(0.0, 1.0));
  float d = tHash(i + vec2(1.0, 1.0));
  float k1 = b - a;
  float k2 = c - a;
  float k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
float tNoise(vec2 x) { return tNoised(x).x; }
`

const vertexShader = /* glsl */ `
  invariant gl_Position;
  uniform float uExag;
  uniform float uExtent;
  varying vec3 vWorld;
  varying vec2 vUv;
  #include <common>
  #include <shadowmap_pars_vertex>
  void main() {
    vec3 p = position;
    p.y *= uExag;
    vec4 worldPosition = modelMatrix * vec4(p, 1.0);
    vWorld = worldPosition.xyz;
    vUv = vec2(p.x / uExtent + 0.5, 0.5 - p.z / uExtent);
    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;
    vec3 transformedNormal = normalMatrix * vec3(0.0, 1.0, 0.0);
    #include <shadowmap_vertex>
  }
`

const fragmentShader = /* glsl */ `
  #include <common>
  #include <packing>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>
  ${ATMOSPHERE_GLSL}
  ${NOISE_GLSL}

  uniform sampler2D uElev;
  uniform vec2 uElevTexel;
  uniform float uExtent;
  uniform float uExag;
  uniform sampler2D uNaip;
  uniform float uImagery;
  uniform sampler2D uFuel;
  uniform float uHasFuel;
  uniform sampler2D uLut;
  uniform sampler2D uCanopy;
  uniform float uHasCanopy;
  uniform sampler2D uSkyView;
  uniform float uHasSkyView;
  uniform sampler2D uWater;
  uniform float uHasWater;
  uniform sampler2D uBakeA;
  uniform sampler2D uBakeB;
  uniform float uBakeMix;
  uniform sampler2D uObserved;
  uniform float uHasObserved;
  uniform sampler2D uForecast;
  uniform float uHasForecast;
  uniform sampler2D uSeverity;
  uniform float uHasSeverity;

  uniform float uTimeH;      // timeline time, hours since manifest.time_origin_ms
  uniform float uFcTimeH;    // timeline time, hours since forecast.time_origin_ms
  uniform float uFcStartH;   // forecast start / end, hours since forecast.time_origin_ms
  uniform float uFcEndH;
  uniform float uFcObsStartH; // forecast start in observed hours (mask of the already-burned area)
  uniform float uClock;      // seconds (animation)

  uniform vec3 uSunColor;
  uniform vec3 uSkyAmb;
  uniform vec3 uGroundAmb;
  uniform float uReliefMix;
  uniform float uLineGain;
  uniform float uRealistic;
  uniform float uNaipSat;
  uniform vec3 uNaipTint;
  uniform float uNaipGain;
  uniform float uNaipGreen;
  uniform float uDetail;
  uniform float uWaterGlint;

  uniform float uTerrainOpacity;
  uniform float uObsOpacity;
  uniform float uIsoOpacity;
  uniform float uIsoStep;
  uniform float uContourOpacity;
  uniform float uContourInterval;
  uniform float uForecastOpacity;
  uniform float uScarOpacity;
  uniform float uFuelsOpacity;
  uniform vec2 uFireCenter;
  uniform float uSweep;      // scan-sweep front radius (m); < 0 = idle
  uniform float uSweepWidth;
  uniform float uEdgeFade;

  varying vec3 vWorld;
  varying vec2 vUv;

  const vec3 FIRE_HOT = vec3(1.0, 0.896, 0.552);   // #FFF3C4
  const vec3 FIRE_MID = vec3(1.0, 0.451, 0.064);   // #FFB347
  const vec3 FIRE = vec3(1.0, 0.144, 0.024);       // #FF6A2B
  const vec3 EMBER = vec3(0.479, 0.032, 0.010);    // #B8321A
  const vec3 CHARCOAL = vec3(0.0080, 0.0065, 0.0050); // #16130F
  const vec3 GOLD = vec3(0.807, 0.571, 0.198);     // #E8C77E
  const vec3 GOLD_WHITE = vec3(0.930, 0.831, 0.597); // #F7EBCB

  vec3 srgb2lin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }

  // cubic B-spline weights; bicubic sampling with 4 bilinear taps at LOD 0 (hides magnified photo texels)
  vec4 bspline(float v) {
    vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
    vec4 s = n * n * n;
    float x = s.x;
    float y = s.y - 4.0 * s.x;
    float z = s.z - 4.0 * s.y + 6.0 * s.x;
    return vec4(x, y, z, 6.0 - x - y - z) * (1.0 / 6.0);
  }
  vec3 textureBicubic(sampler2D tex, vec2 uv, vec2 texSize) {
    vec2 p = uv * texSize - 0.5;
    vec2 f = fract(p);
    p -= f;
    vec4 xc = bspline(f.x);
    vec4 yc = bspline(f.y);
    vec4 c = p.xxyy + vec2(-0.5, 1.5).xyxy;
    vec4 sw = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
    vec4 o = (c + vec4(xc.yw, yc.yw) / sw) / texSize.xxyy;
    vec3 s0 = textureLod(tex, o.xz, 0.0).rgb;
    vec3 s1 = textureLod(tex, o.yz, 0.0).rgb;
    vec3 s2 = textureLod(tex, o.xw, 0.0).rgb;
    vec3 s3 = textureLod(tex, o.yw, 0.0).rgb;
    float sx = sw.x / (sw.x + sw.y);
    float sy = sw.z / (sw.z + sw.w);
    return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
  }

  // anti-aliased lines at integer values of f; halfWidth in pixels
  float lineAA(float f, float halfWidth) {
    float w = max(fwidth(f), 1e-6);
    float d = abs(fract(f - 0.5) - 0.5) / w;
    return 1.0 - smoothstep(halfWidth - 0.5, halfWidth + 0.5, d);
  }
  // 1 while lines are at least ~6 px apart, fading to 0 when they would merge
  float lineRoom(float f) {
    return 1.0 - smoothstep(0.1, 0.3, fwidth(f));
  }
  // stricter: only while lines are at least ~12 px apart
  float lineRoomWide(float f) {
    return 1.0 - smoothstep(0.05, 0.12, fwidth(f));
  }
  // isoline of scalar s at level, ~halfWidth px
  float isoAA(float s, float level, float halfWidth) {
    float d = abs(s - level) / max(fwidth(s), 1e-6);
    return 1.0 - smoothstep(halfWidth - 0.5, halfWidth + 0.5, d);
  }

  vec3 fireRamp(float h) {
    h = clamp(h, 0.0, 1.0);
    vec3 c = mix(EMBER, FIRE, smoothstep(0.0, 0.35, h));
    c = mix(c, FIRE_MID, smoothstep(0.35, 0.7, h));
    return mix(c, FIRE_HOT, smoothstep(0.7, 1.0, h));
  }
  vec3 probRamp(float p) {
    vec3 c = mix(GOLD, FIRE_MID, smoothstep(0.25, 0.6, p));
    c = mix(c, FIRE, smoothstep(0.6, 0.85, p));
    return mix(c, vec3(0.80, 0.06, 0.03), smoothstep(0.85, 1.0, p));
  }
  // dNBR ramp (USGS breaks): rgb + alpha
  vec4 scarRamp(float d) {
    if (d < 0.1) return vec4(0.0);
    vec3 low = vec3(0.80, 0.68, 0.19);
    vec3 modLow = vec3(0.87, 0.37, 0.11);
    vec3 modHigh = vec3(0.79, 0.07, 0.04);
    vec3 high = vec3(0.30, 0.02, 0.10);
    vec3 c = mix(low, modLow, smoothstep(0.2, 0.34, d));
    c = mix(c, modHigh, smoothstep(0.36, 0.52, d));
    c = mix(c, high, smoothstep(0.58, 0.8, d));
    return vec4(c, smoothstep(0.08, 0.16, d));
  }
  // P(burned by t) from arrival quantiles (piecewise linear), capped by the horizon burn probability
  float probAt(float t, vec4 q) {
    float p10 = q.r;
    float p50 = q.g;
    float p90 = q.b;
    float P;
    if (t < p10) {
      float d = max(0.5, (p50 - p10) * 0.5);
      P = 0.1 * clamp(1.0 - (p10 - t) / d, 0.0, 1.0);
    } else if (t < p50) {
      P = 0.1 + 0.4 * (t - p10) / max(p50 - p10, 1e-3);
    } else if (t < p90) {
      P = 0.5 + 0.4 * (t - p50) / max(p90 - p50, 1e-3);
    } else {
      P = 0.9 + 0.1 * clamp((t - p90) / max(0.5, (p90 - p50) * 0.5), 0.0, 1.0);
    }
    return min(P, q.a);
  }

  void main() {
    vec2 uv = vUv;
    vec3 P = vWorld;
    vec3 viewDir = normalize(P - cameraPosition);
    vec3 bg = atmSky(viewDir);
    float fp = max(length(dFdx(P.xz)), length(dFdy(P.xz))); // metres per pixel

    // ---------------------------------------------------------------- relief
    vec2 tx = uElevTexel;
    float e0 = texture2D(uElev, uv).r;
    float eE = texture2D(uElev, uv + vec2(tx.x, 0.0)).r;
    float eW = texture2D(uElev, uv - vec2(tx.x, 0.0)).r;
    float eN = texture2D(uElev, uv + vec2(0.0, tx.y)).r;
    float eS = texture2D(uElev, uv - vec2(0.0, tx.y)).r;
    float dm = uExtent * tx.x;
    vec2 grad = vec2(eE - eW, eS - eN) / (2.0 * dm); // dH/dx, dH/dz (true metres)
    vec3 N = normalize(vec3(-grad.x * uExag, 1.0, -grad.y * uExag));
    float slopeDeg = degrees(atan(length(grad)));

    // ---------------------------------------------------------------- inputs
    float code = uHasFuel > 0.5 ? floor(texture2D(uFuel, uv).r * 255.0 + 0.5) : 0.0;
    vec4 lutV = texture2D(uLut, vec2((code + 0.5) / 256.0, 0.75));
    // fuel categories and the realistic LUT albedo blended bilinearly over the 4 nearest fire-grid texels, so
    // procedural detail never shows the 30 m cells
    vec4 cat = vec4(0.0);  // grass, shrub, timber, bare
    vec4 lutR = vec4(0.0);
    if (uHasFuel > 0.5) {
      vec2 fsz = vec2(textureSize(uFuel, 0));
      vec2 fpix = uv * fsz - 0.5;
      vec2 f0 = floor(fpix);
      vec2 ff = fpix - f0;
      for (int k = 0; k < 4; k++) {
        vec2 o = vec2(float(k & 1), float(k >> 1));
        ivec2 ij = ivec2(clamp(f0 + o, vec2(0.0), fsz - 1.0));
        float cd = floor(texelFetch(uFuel, ij, 0).r * 255.0 + 0.5);
        float wk = (o.x > 0.5 ? ff.x : 1.0 - ff.x) * (o.y > 0.5 ? ff.y : 1.0 - ff.y);
        float gs = step(120.5, cd) * step(cd, 124.5);
        cat += wk * vec4(
          step(100.5, cd) * step(cd, 109.5) + gs * 0.5,
          step(140.5, cd) * step(cd, 149.5) + gs * 0.5,
          step(160.5, cd) * step(cd, 189.5),
          step(98.5, cd) * step(cd, 99.5) + step(90.5, cd) * step(cd, 91.5) * 0.5);
        if (uImagery < 0.999) lutR += wk * texture2D(uLut, vec2((cd + 0.5) / 256.0, 0.25));
      }
    }
    float cc = uHasCanopy > 0.5 ? clamp(texture2D(uCanopy, uv).r * 2.55, 0.0, 1.0) : 0.0;
    float svf = uHasSkyView > 0.5 ? texture2D(uSkyView, uv).r : 0.85;
    float wat = uHasWater > 0.5 ? smoothstep(0.18, 0.62, texture2D(uWater, uv).r) : 0.0;
    vec4 bake = texture2D(uBakeA, uv);
    if (uBakeMix > 0.0) bake = mix(bake, texture2D(uBakeB, uv), uBakeMix);
    float sunVis = bake.r;
    float cavity = bake.g;

    float isGrass = cat.x;
    float isShrub = cat.y;
    float isTimber = cat.z;
    float isBare = cat.w;
    float rockW = clamp(smoothstep(30.0, 46.0, slopeDeg) + isBare, 0.0, 1.0) * (1.0 - wat);

    // ---------------------------------------------------------------- micro-detail (world-space fbm)
    // octaves fade out before they alias (wavelength < ~2.5 px)
    vec2 q = P.xz;
    float w0 = smoothstep(1.0, 3.0, 52.0 / fp);
    float w1 = smoothstep(1.0, 3.0, 14.0 / fp);
    float w2 = smoothstep(1.0, 3.0, 4.1 / fp);
    float w3 = smoothstep(1.0, 3.0, 1.3 / fp);
    vec3 n0 = tNoised(q / 52.0 + 11.3);
    vec3 n1 = tNoised(q / 14.0 - 3.7);
    vec3 n2 = vec3(0.5, 0.0, 0.0);
    vec3 n3 = vec3(0.5, 0.0, 0.0);
    if (w2 > 0.0) n2 = tNoised(q / 4.1 + 7.9);
    if (w3 > 0.0) n3 = tNoised(q / 1.3 - 1.1);
    // material-dependent bump heights (m) per octave
    float rough = uDetail;
    vec4 amp = vec4(1.6, 1.1, 0.45, 0.12) * rockW
             + vec4(0.5, 0.9, 0.55, 0.12) * isShrub * (1.0 - rockW)
             + vec4(0.25, 0.2, 0.12, 0.06) * isGrass * (1.0 - rockW)
             + vec4(1.4, 2.2, 0.6, 0.1) * max(isTimber, cc) * (1.0 - rockW)
             + vec4(0.4, 0.35, 0.2, 0.06);
    amp *= rough * vec4(w0, w1, w2, w3);
    vec2 bumpGrad = n0.yz / 52.0 * amp.x + n1.yz / 14.0 * amp.y + n2.yz / 4.1 * amp.z + n3.yz / 1.3 * amp.w;
    float detail = (n0.x - 0.5) * w0 * 0.5 + (n1.x - 0.5) * w1 * 0.7 + (n2.x - 0.5) * w2 * 0.8 + (n3.x - 0.5) * w3 * 0.6;
    vec3 Nd = normalize(N - vec3(bumpGrad.x, 0.0, bumpGrad.y) * uExag * 0.6);

    // ---------------------------------------------------------------- observed fire state
    float a = 1e5;
    float fa = 1.0;
    float inMask = 0.0;
    float coreMask = 0.0;
    float burned = 0.0;
    float age = 1e5;
    if (uHasObserved > 0.5) {
      vec2 of = texture2D(uObserved, uv).rg;
      a = of.r;
      inMask = clamp((0.5 - of.g) / max(fwidth(of.g), 1e-4) + 0.5, 0.0, 1.0);
      // away from unburnable texels only: no false fronts where filled NEVER values ramp between banks
      coreMask = 1.0 - smoothstep(0.03, 0.2, of.g);
      fa = max(fwidth(a), 1e-5);
      age = uTimeH - a;
      burned = clamp(age / fa + 0.5, 0.0, 1.0) * inMask;
    }
    float sev = 0.6;
    float dnbr = 0.0;
    if (uHasSeverity > 0.5) {
      dnbr = texture2D(uSeverity, uv).r;
      sev = clamp((dnbr - 0.1) / 0.6, 0.15, 1.0);
    }
    float burnVis = burned * uObsOpacity;

    // ---------------------------------------------------------------- albedo (realistic)
    vec3 naip = texture2D(uNaip, uv).rgb;
    if (uImagery > 0.0) {
      vec2 nsz = vec2(textureSize(uNaip, 0));
      float naipTexelM = uExtent / nsz.x;
      float mag = fp / naipTexelM; // < 1: one photo texel spans several pixels
      if (mag < 0.9) naip = mix(textureBicubic(uNaip, uv, nsz), naip, smoothstep(0.45, 0.9, mag));
    }
    // grade toward desaturated moss / olive greens and stone greys: hue-shift straw toward olive, then tint
    vec3 mossy = vec3(0.74 * naip.r + 0.12 * naip.g, 0.05 * naip.r + 0.93 * naip.g, 0.14 * naip.g + 0.78 * naip.b);
    naip = mix(naip, mossy, uNaipGreen);
    float L = dot(naip, vec3(0.2126, 0.7152, 0.0722));
    vec3 graded = mix(vec3(L), naip, uNaipSat) * uNaipTint * uNaipGain;
    // a touch of local contrast from the micro-detail
    vec3 proc = mix(vec3(0.07, 0.075, 0.06), srgb2lin(lutR.rgb / max(lutR.a, 1e-3)), clamp(lutR.a, 0.0, 1.0));
    proc = mix(proc, vec3(0.022, 0.034, 0.018), cc * 0.75);
    // large-scale patchiness so uniform fuel polygons do not read as flat paint
    float patchL = tNoise(mat2(0.8, -0.6, 0.6, 0.8) * q / 180.0 + 4.2) * 0.6 + tNoise(q / 61.0 - 2.7) * 0.4;
    proc *= 0.7 + 0.6 * patchL;
    proc = mix(proc, proc * vec3(0.78, 0.92, 0.7), smoothstep(0.55, 0.8, patchL) * (isShrub + isTimber));
    proc *= 0.55;
    vec3 albedo = mix(proc, graded, uImagery);
    vec3 stone = vec3(0.10, 0.10, 0.092) * (0.75 + 0.5 * n1.x);
    albedo = mix(albedo, mix(albedo, stone, 0.6) , rockW * (0.65 - 0.4 * uImagery));
    albedo *= 1.0 + detail * (0.85 + 0.5 * rockW) * uDetail;
    // vegetation clumping: dark gaps between shrub / crown clumps
    float veg = clamp(isShrub + max(isTimber, cc) * 0.8 + isGrass * 0.3, 0.0, 1.0) * (1.0 - rockW);
    albedo *= mix(1.0, 0.5 + 1.0 * smoothstep(0.25, 0.75, n2.x), veg * 0.55 * w2 * uDetail);

    // charred ground / ash: warm charcoal (#16130F undertone) keeping only the photo's luminance texture, so it
    // stays charcoal (not olive) after the green-black shadow lift of the grade
    float Lb = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 scorched = vec3(Lb) * vec3(0.46, 0.34, 0.23);
    vec3 charAlb = mix(scorched, vec3(0.0115, 0.0088, 0.0063), 0.5 + 0.4 * sev);
    float ash = smoothstep(0.62, 0.86, tNoise(q / 16.0 + 5.0) * 0.7 + n2.x * 0.3) * sev * (1.0 - wat);
    charAlb = mix(charAlb, vec3(0.115, 0.106, 0.095), ash * 0.5);
    albedo = mix(albedo, charAlb, burnVis);

    // data-viz overlays drawn as surface colour (keep the relief shading)
    vec3 fuelCol = srgb2lin(lutV.rgb) * 0.55;
    float fuelA = uFuelsOpacity * lutV.a;
    albedo = mix(albedo, fuelCol, fuelA);
    vec4 scar = uHasSeverity > 0.5 ? scarRamp(dnbr) : vec4(0.0);
    float scarA = scar.a * uScarOpacity;
    albedo = mix(albedo, scar.rgb * 0.5, scarA);

    // ---------------------------------------------------------------- lighting (realistic)
    float ndl = dot(Nd, uSunDir);
    float diffuse = max((ndl + 0.1) / 1.1, 0.0);
    float shadowMap = getShadowMask();
    float shadow = sunVis * shadowMap;
    float ao = mix(0.22, 1.0, svf) * clamp(0.45 + cavity * 1.1, 0.25, 1.3);
    vec3 amb = mix(uGroundAmb, uSkyAmb, Nd.y * 0.5 + 0.5) * ao;
    vec3 lit = albedo * (uSunColor * (diffuse * shadow) + amb);

    // water: dark body, sky reflection with Fresnel, animated sparkles (HDR -> bloom / bokeh)
    if (wat > 0.001) {
      vec3 V = -viewDir;
      vec3 r1 = tNoised(q / 9.0 + vec2(uClock * 0.11, uClock * 0.07));
      vec3 r2 = tNoised(q / 3.1 - vec2(uClock * 0.17, -uClock * 0.13));
      vec2 rg = (r1.yz / 9.0 * 0.7 + r2.yz / 3.1 * 0.3) * 1.4;
      vec3 Nw = normalize(vec3(-rg.x, 1.0, -rg.y));
      float ndv = max(dot(Nw, V), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
      vec3 R = reflect(-V, Nw);
      vec3 refl = atmSky(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
      vec3 body = vec3(0.003, 0.008, 0.009) * (uSunColor * 0.3 * shadow + amb * 2.0);
      vec3 wcol = mix(body, refl * 1.25, fres);
      float cellSize = max(2.4, fp * 3.5);
      vec2 cellP = q / cellSize;
      vec2 cell = floor(cellP);
      vec2 fc = fract(cellP) - 0.5;
      float h1 = tHash(cell + 13.0);
      float h2 = tHash(cell + 71.0);
      float h3 = tHash(cell + 157.0);
      vec3 nf = normalize(Nw + vec3(h1 - 0.5, 0.0, h2 - 0.5) * 0.85);
      float spec = pow(max(dot(reflect(-V, nf), uSunDir), 0.0), 60.0);
      float twinkle = 0.35 + 0.65 * max(0.0, sin(uClock * (1.3 + h3 * 3.5) + h1 * 40.0));
      float dotShape = 1.0 - smoothstep(0.08, 0.32, length(fc + (vec2(h2, h3) - 0.5) * 0.3));
      float glint = spec * twinkle * dotShape * step(0.35, h3);
      wcol += uSunColor * glint * 9.0 * uWaterGlint * shadow;
      wcol += uSunColor * pow(max(dot(R, uSunDir), 0.0), 180.0) * 2.0 * uWaterGlint * shadow;
      // the art-direction "river of light" (hybrid / parametric): a soft gold sheen plus stylised twinkling
      // sparkles that do not depend on the sun angle; they bloom and turn into bokeh out of focus
      float core = smoothstep(0.55, 0.95, wat);
      float tw = max(0.0, sin(uClock * (0.9 + h2 * 2.6) + h1 * 31.0));
      float pointy = 1.0 - smoothstep(0.02, 0.16, length(fc + (vec2(h2, h3) - 0.5) * 0.3));
      float sparkle = pointy * step(0.86, h1) * tw * tw * tw * core;
      float data = 1.0 - uRealistic;
      wcol += GOLD_WHITE * sparkle * 9.0 * uWaterGlint * data;
      // faint luminous sheen along the channel (stronger at grazing angles)
      wcol += GOLD * (0.012 + 0.05 * fres) * core * uLineGain * data;
      lit = mix(lit, wcol, wat * (1.0 - burnVis * 0.8));
    }

    // ---------------------------------------------------------------- parametric relief
    float hs = max(dot(N, uSunDir), 0.0);
    vec3 relief = vec3(0.007, 0.0095, 0.008) + vec3(0.036, 0.045, 0.039) * pow(hs, 1.4) * mix(0.55, 1.0, sunVis) * mix(0.5, 1.0, svf);
    relief *= 0.8 + 0.4 * cavity;
    relief = mix(relief, vec3(0.004, 0.009, 0.012), wat * 0.85);
    relief = mix(relief, relief * vec3(0.55, 0.42, 0.34) + vec3(0.006, 0.0025, 0.0), burnVis);
    relief = mix(relief, fuelCol * (0.25 + 0.6 * hs), fuelA * 0.8);
    relief = mix(relief, scar.rgb * (0.25 + 0.6 * hs), scarA * 0.8);

    vec3 col = mix(lit, relief, uReliefMix);
    col = mix(bg, col, uTerrainOpacity);

    // ---------------------------------------------------------------- emissive data layers
    vec3 emis = vec3(0.0);
    float reveal = 1.0;
    float sweepGlow = 0.0;
    if (uSweep >= 0.0) {
      float rr = length(P.xz - uFireCenter);
      reveal = 1.0 - smoothstep(uSweep - uSweepWidth, uSweep, rr);
      // a thin luminous ring (a few pixels wide at any zoom) with a faint trailing wash
      float ringW = max(12.0, fp * 2.2);
      sweepGlow = exp(-pow((rr - uSweep) / ringW, 2.0)) + 0.12 * reveal * smoothstep(uSweep - uSweepWidth * 1.5, uSweep, rr);
    }

    // observed fire: embers (decay ~6 h) and the incandescent front band (a in (t - 0.75 h, t])
    if (uHasObserved > 0.5 && uObsOpacity > 0.0 && burned > 0.0 && age < 7.0) {
      float fresh = burned * coreMask * (1.0 - smoothstep(0.0, 0.75, age));
      float flick = 0.78 + 0.22 * tNoise(vec2(uClock * 7.0, dot(q, vec2(0.013, 0.017))));
      // flame tongues: two scrolling noise octaves, thresholded for gaps between the tongues
      // rotated, domain-warped octaves so the value-noise lattice never shows
      vec2 qa = mat2(0.8, -0.6, 0.6, 0.8) * q;
      vec2 qb = mat2(0.34, 0.94, -0.94, 0.34) * q;
      float warp = tNoise(qa / 31.0 + vec2(uClock * 0.07, 0.0));
      float tA = tNoise(qa / 17.0 + vec2(warp * 1.7, -uClock * 0.5));
      float tB = tNoise(qb / 6.5 + vec2(uClock * 0.8, uClock * 0.3 + warp));
      float tongues = smoothstep(0.3, 0.84, tA * 0.6 + tB * 0.4);
      float heat = fresh * (0.22 + 0.78 * tongues) * flick;
      float rim = 1.0 - smoothstep(0.0, 0.3, age); // hottest right at the leading edge
      float fireGain = 1.0 + 0.5 * uRealistic - 0.25 * uReliefMix;
      emis += fireRamp(clamp(heat * (0.5 + 0.5 * rim), 0.0, 1.0)) * heat * 2.4 * fireGain;
      // smouldering embers: sparse hot spots, thinning out over ~6 h
      float ageN = clamp(age / 6.0, 0.0, 1.0);
      float ember = burned * coreMask * (1.0 - ageN) * (1.0 - fresh);
      float spotsN = tNoise(q / 7.0 + 3.1) * 0.6 + tNoise(q / 2.3) * 0.4;
      float spots = smoothstep(0.8 + 0.14 * ageN, 0.97, spotsN);
      float pulse = 0.6 + 0.4 * sin(uClock * (1.3 + 2.0 * tHash(floor(q / 7.0))) + n1.x * 12.0);
      emis += mix(EMBER, FIRE, 0.45) * ember * spots * pulse * 2.2;
      emis += EMBER * burned * exp(-max(age, 0.0) / 6.0) * 0.01;
      emis *= uObsOpacity;
    }
    if (uHasObserved > 0.5 && uObsOpacity > 0.0) {
      // the current front: the brightest filament (a = t)
      float fil = (1.0 - smoothstep(0.25, 1.1, abs(age) / fa)) * coreMask * step(-0.25, age);
      vec3 filCol = mix(mix(GOLD, GOLD_WHITE, 0.45) * 1.25, FIRE_MID * 2.0, uRealistic);
      emis += filCol * fil * uLineGain * uObsOpacity;
    }

    // isochrones (only behind the front)
    if (uHasObserved > 0.5 && uIsoOpacity > 0.0) {
      float f = a / uIsoStep;
      float minor = lineAA(f, 0.5) * lineRoom(f);
      float major = lineAA(f * 0.25, 0.65) * lineRoom(f * 0.25);
      float iso = max(minor * 0.38, major * 0.75) * burned * coreMask * step(0.05, a);
      emis += mix(GOLD, GOLD_WHITE, 0.6) * iso * 0.8 * uIsoOpacity * uLineGain * reveal;
    }

    // elevation contours
    if (uContourOpacity > 0.0) {
      float ce = e0 / uContourInterval;
      float cminor = lineAA(ce, 0.4) * lineRoomWide(ce);
      float cmajor = lineAA(ce * 0.2, 0.55) * lineRoom(ce * 0.2);
      float con = max(cminor * 0.32, cmajor * 0.8);
      emis += GOLD * con * 0.34 * uContourOpacity * uLineGain * reveal * mix(1.0, 0.6, uRealistic);
    }

    // forecast: probability field, horizon contours, dashed p50 front
    if (uHasForecast > 0.5 && uForecastOpacity > 0.0) {
      vec4 fq = texture2D(uForecast, uv);
      float pa = fq.a;
      float burnedAtStart = uHasObserved > 0.5 ? clamp((uFcObsStartH - a) / fa + 0.5, 0.0, 1.0) * inMask : 0.0;
      float keep = 1.0 - burnedAtStart;
      // the field shows predicted fire where the observed record has not burned (yet): the truth stays charcoal
      float burnableFuel = uHasFuel > 0.5 ? step(100.5, code) : 1.0;
      float Pt = probAt(uFcTimeH, fq) * (1.0 - burned) * burnableFuel * step(uFcStartH - 0.01, uFcTimeH);
      vec3 ramp = probRamp(Pt);
      float field = smoothstep(0.02, 0.35, Pt) * (0.35 + 0.65 * Pt);
      // luminous field (hybrid / parametric): a faint fill plus fine world-space hatching whose weight follows P
      float hatchLen = 36.0 * exp2(floor(log2(max(1.0, fp * 7.0 / 36.0))));
      float hatch = lineAA((P.x - P.z) / hatchLen, 0.35 + 0.5 * Pt) * lineRoom((P.x - P.z) / hatchLen);
      emis += ramp * field * (0.055 + 0.36 * hatch) * uForecastOpacity * (1.0 - uRealistic) * reveal;
      // translucent heat wash (realistic)
      col = mix(col, col * vec3(1.25, 0.72, 0.5) + ramp * 0.05, field * 0.75 * uForecastOpacity * uRealistic);
      // 10 / 50 / 90 % burn-probability contours (by the horizon)
      float l10 = isoAA(pa, 0.1, 0.75);
      float l50 = isoAA(pa, 0.5, 0.95);
      float l90 = isoAA(pa, 0.9, 0.75);
      vec3 lc = GOLD * l10 * 0.9 + FIRE_MID * l50 * 1.15 + vec3(0.9, 0.12, 0.05) * l90 * 1.0;
      float preStart = uFcTimeH < uFcStartH ? 0.4 : 1.0; // context only before the forecast starts
      emis += lc * preStart * uForecastOpacity * uLineGain * reveal * mix(1.0, 0.75, uRealistic);
      // dashed median front at t (dimmer)
      if (uFcTimeH > uFcStartH && uFcTimeH < uFcEndH) {
        float p50 = fq.g;
        float valid = smoothstep(0.45, 0.55, pa) * keep;
        float fl = isoAA(p50, uFcTimeH, 0.9);
        vec2 dc = P.xz - uFireCenter;
        float dashLen = 45.0 * exp2(floor(log2(max(1.0, fp * 16.0 / 45.0))));
        float s = atan(dc.y, dc.x) * length(dc);
        float dash = step(0.42, fract(s / dashLen));
        emis += FIRE_MID * fl * dash * valid * 0.75 * uForecastOpacity * uLineGain;
      }
    }

    emis += mix(GOLD, GOLD_WHITE, 0.5) * sweepGlow * 1.1 * uLineGain;
    col += emis;

    // ---------------------------------------------------------------- atmosphere + AOI edge fade
    float T = atmTransmittance(cameraPosition, P);
    col = mix(bg, col, T);
    col = mix(bg, col, atmEdgeFade(uv, uEdgeFade));

    gl_FragColor = vec4(max(col, 0.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** Uniforms of the terrain material (besides THREE.UniformsLib.lights). */
export function terrainUniforms(): Record<string, THREE.IUniform> {
  return {
    ...atmosphereUniforms(),
    uElev: { value: null },
    uElevTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    uExtent: { value: 12000 },
    uExag: { value: 1.5 },
    uNaip: { value: null },
    uImagery: { value: 0 },
    uFuel: { value: null },
    uHasFuel: { value: 0 },
    uLut: { value: null },
    uCanopy: { value: null },
    uHasCanopy: { value: 0 },
    uSkyView: { value: null },
    uHasSkyView: { value: 0 },
    uWater: { value: null },
    uHasWater: { value: 0 },
    uBakeA: { value: null },
    uBakeB: { value: null },
    uBakeMix: { value: 0 },
    uObserved: { value: null },
    uHasObserved: { value: 0 },
    uForecast: { value: null },
    uHasForecast: { value: 0 },
    uSeverity: { value: null },
    uHasSeverity: { value: 0 },
    uTimeH: { value: 0 },
    uFcTimeH: { value: 0 },
    uFcStartH: { value: 0 },
    uFcEndH: { value: 0 },
    uFcObsStartH: { value: 0 },
    uClock: { value: 0 },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSkyAmb: { value: new THREE.Color(0.1, 0.1, 0.1) },
    uGroundAmb: { value: new THREE.Color(0.05, 0.05, 0.05) },
    uReliefMix: { value: 0 },
    uLineGain: { value: 1 },
    uRealistic: { value: 0 },
    uNaipSat: { value: 0.7 },
    uNaipTint: { value: new THREE.Color(1, 1, 1) },
    uNaipGain: { value: 0.7 },
    uNaipGreen: { value: 1 },
    uDetail: { value: 1 },
    uWaterGlint: { value: 1 },
    uTerrainOpacity: { value: 1 },
    uObsOpacity: { value: 1 },
    uIsoOpacity: { value: 0.8 },
    uIsoStep: { value: 6 },
    uContourOpacity: { value: 0.35 },
    uContourInterval: { value: 20 },
    uForecastOpacity: { value: 0.85 },
    uScarOpacity: { value: 0 },
    uFuelsOpacity: { value: 0 },
    uFireCenter: { value: new THREE.Vector2(0, 0) },
    uSweep: { value: -1 },
    uSweepWidth: { value: 600 },
    uEdgeFade: { value: 0.08 },
  }
}

const depthVertexShader = /* glsl */ `
  invariant gl_Position;
  uniform float uExag;
  void main() {
    vec3 p = position;
    p.y *= uExag;
    vec4 worldPosition = modelMatrix * vec4(p, 1.0);
    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition; // same sequence as the main pass (bit-identical depth)
  }
`

/** Depth-only pre-pass material: the expensive terrain shader then shades each pixel once (no overdraw of hidden
 *  slopes). Shares the exaggeration uniform object with the main material. */
export function createTerrainDepthMaterial(exag: THREE.IUniform): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'fire3d-terrain-depth',
    vertexShader: depthVertexShader,
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
    uniforms: { uExag: exag },
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
  })
}

export function createTerrainMaterial(): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, terrainUniforms()])
  return new THREE.ShaderMaterial({
    name: 'fire3d-terrain',
    vertexShader,
    fragmentShader,
    uniforms,
    lights: true,
    fog: false,
  })
}
