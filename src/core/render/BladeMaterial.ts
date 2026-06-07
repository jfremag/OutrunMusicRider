import * as THREE from 'three'

/**
 * BladeMaterial — the dimensional "blood-red" emissive for the sword obstacles
 * ("Watercolour Speed" §5 accent). ralph(iter 5).
 *
 * BEFORE: the blade was a single FLAT hot pure-red stripe (albedo + emissive both #db3b2e,
 * intensity 0.4). It read as a pasted-on neon strip with zero modelling, and — worse — its
 * look CHANGED across the horizon because nothing tied its value to its own length/depth; a
 * blade looked one way against the bright sky and another against the dark ground.
 *
 * AFTER: a self-contained `onBeforeCompile` injection adds, AFTER the BRDF lighting is
 * composed (so the blade still takes the scene key/shadow as a real 3D form), a VALUE
 * GRADIENT along the blade's own LOCAL long axis plus a cool Fresnel RIM:
 *
 *   - GRADIENT: a hot crimson CORE near the mid/upper blade easing to a deeper OXBLOOD toward
 *     the TIP and the base/hilt. Built from the blade's LOCAL bounding-box Y (passed as
 *     uniforms, computed per-geometry), so it is a property of the blade itself and is IDENTICAL
 *     whether the blade is above or below the horizon — zero discontinuity at the seam.
 *   - COOL RIM: a thin steel-blue Fresnel sliver on the grazing silhouette so the blade reads
 *     as a dimensional metal form catching cool sky light, not a flat sticker. Subtle.
 *   - PALETTE-SEATED RED: the crimson is pulled a touch off 100% sRGB red toward a richer
 *     blood-red (ref 02's blood-red), so it reads premium-menacing, not neon. Authored in
 *     LINEAR space (the standard shader accumulates lighting linearly) and kept BELOW the
 *     selective-bloom threshold so it never glows.
 *
 * The whole emissive is shaped by ONE smooth analytic function of the local vertex position +
 * the view fresnel — no noise, no time term — so it adds no flicker and reads CLEAN/PRECISE
 * (Tesla-premium), not sketchy.
 *
 * Colour-space note: emissive is added to the linear-space `totalEmissiveRadiance`, so all the
 * colours here are converted sRGB->linear at upload.
 */

/** Hot crimson CORE of the blade — the brightest, most saturated band. Blood-red, not neon. */
const BLADE_CORE_HEX = 0xd83a2b
/** Deeper blood-red toward the tip + base — a RICHER, slightly darker red the core eases into.
 *  Kept clearly RED (not a near-black oxblood) so the WHOLE blade reads consistently blood-red at
 *  every distance — the gradient only MODELS it, it must never darken the ends into a gray stripe. */
const BLADE_OXBLOOD_HEX = 0xa02a20
/** Cool steel-blue rim light on the grazing silhouette (the dimensional metal catch-light). */
const BLADE_RIM_HEX = 0x6a86b4

function linearColor(hex: number): THREE.Color {
  return new THREE.Color(hex).convertSRGBToLinear()
}

/**
 * Injects the gradient + rim emissive into a blade MeshStandardMaterial via `onBeforeCompile`.
 * The caller (cloneSwordTemplate) has already set the albedo (matte blood-red) and forced the
 * material matte; this only replaces the FLAT emissive with the dimensional one.
 *
 * @param material the blade material (already matte; its albedo set by the caller).
 * @param geometry the blade geometry — its LOCAL bounding box gives the gradient axis range.
 */
export function injectBladeEmissive(
  material: THREE.MeshStandardMaterial,
  geometry: THREE.BufferGeometry
): void {
  // IDEMPOTENCY GUARD (load-bearing): Object3D.clone(true) SHARES material references, so the same
  // blade material is handed to this function once per cloned sword. Chaining onBeforeCompile (and
  // re-appending the uniform/varying declarations) on the SAME material more than once produces a
  // "redefinition" GLSL compile error → the blade falls back to a broken/dark program. Inject ONCE
  // per material and no-op thereafter; the in-shader uniforms are identical for every clone anyway.
  if ((material.userData as { bladeInjected?: boolean }).bladeInjected) return
  ;(material.userData as { bladeInjected?: boolean }).bladeInjected = true

  // The Claymore blade's long axis in its OWN geometry-local space is Z (the GLB authors the blade
  // length along Z; local Y is nearly flat — measured ranges rZ≈0.012-0.045 vs rY≈0.001). Read the
  // local min/max along the axis of MAXIMUM extent so the gradient always spans the blade's length
  // regardless of which axis the model uses, then drive the in-shader gradient off that axis.
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const bb = geometry.boundingBox
  const ext = bb
    ? { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z }
    : { x: 0, y: 0, z: 1 }
  // axisSel encodes the long axis as a vec3 mask (1 on the chosen axis) the vertex shader dots with
  // `position` to extract the length coordinate — robust to whichever axis the geometry uses.
  let axisSel: [number, number, number] = [0, 0, 1]
  let axisMin = bb ? bb.min.z : -1
  let axisMax = bb ? bb.max.z : 1
  if (ext.x >= ext.y && ext.x >= ext.z) {
    axisSel = [1, 0, 0]
    axisMin = bb ? bb.min.x : -1
    axisMax = bb ? bb.max.x : 1
  } else if (ext.y >= ext.x && ext.y >= ext.z) {
    axisSel = [0, 1, 0]
    axisMin = bb ? bb.min.y : -1
    axisMax = bb ? bb.max.y : 1
  }

  // Kill the stock flat emissive — the injected gradient OWNS the emissive now.
  material.emissive.setRGB(0, 0, 0)
  material.emissiveIntensity = 1

  const prevOnBeforeCompile = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    if (prevOnBeforeCompile) prevOnBeforeCompile(shader, renderer)

    shader.uniforms.uBladeCore = { value: linearColor(BLADE_CORE_HEX) }
    shader.uniforms.uBladeOxblood = { value: linearColor(BLADE_OXBLOOD_HEX) }
    shader.uniforms.uBladeRim = { value: linearColor(BLADE_RIM_HEX) }
    shader.uniforms.uBladeAxis = { value: new THREE.Vector3(axisSel[0], axisSel[1], axisSel[2]) }
    shader.uniforms.uBladeMin = { value: axisMin }
    shader.uniforms.uBladeMax = { value: axisMax }

    // Pass the LOCAL (object-space) length coordinate (position dotted with the long-axis mask) to
    // the fragment so the gradient is anchored to the BLADE itself, not to screen/world space —
    // identical above vs below the horizon.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uBladeAxis;
        varying float vBladeLocalAxis;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vBladeLocalAxis = dot(position, uBladeAxis);`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3  uBladeCore;
        uniform vec3  uBladeOxblood;
        uniform vec3  uBladeRim;
        uniform float uBladeMin;
        uniform float uBladeMax;
        varying float vBladeLocalAxis;`
      )
      // Inject right before opaque_fragment (after the BRDF composes outgoingLight) so the blade
      // keeps its lit 3D form and the emissive gradient + rim sit ON TOP as a self-illumination.
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `{
          // 0..1 along the blade's own long axis, tip = 1, base = 0.
          float t = clamp((vBladeLocalAxis - uBladeMin) / max(uBladeMax - uBladeMin, 1e-6), 0.0, 1.0);
          // VALUE GRADIENT (MODELLING, not a darkening): the WHOLE blade is a consistent blood-red;
          // a raised-cosine hump peaks ~0.6 up the blade and brightens it to the HOT crimson core
          // there, easing toward the deeper (but still clearly RED) blood-red at the tip and base.
          // The ends never go gray/dark — the gradient only models the blade so it reads dimensional,
          // never a flat hot stripe, while staying a consistent red at every distance.
          float core = smoothstep(0.0, 0.6, t) * (1.0 - smoothstep(0.6, 1.0, t));
          core = pow(clamp(core, 0.0, 1.0), 0.7);           // fatten the bright band a touch
          vec3 grad = mix(uBladeOxblood, uBladeCore, core);

          // COOL FRESNEL RIM: a thin steel-blue catch on the grazing silhouette so the blade reads
          // as a dimensional metal form (it catches the cool sky), not a flat sticker. 'normal' is
          // view-space; vViewPosition points to the camera, so its normalize is the view dir.
          vec3 bN = normalize(normal);
          vec3 bV = normalize(vViewPosition);
          float bFres = pow(1.0 - clamp(dot(bN, bV), 0.0, 1.0), 3.2);

          // Self-illumination: a CONFIDENT blood-red emissive (so the blade reads consistently red
          // through the aerial haze + LUT at ALL distances, like the prior flat emissive did, but now
          // with the core/tip MODELLING) PLUS a low cool rim. Kept below the ~0.80 selective-bloom
          // threshold (blood-red luma ~0.35, so even ×1.0 + the lit albedo stays sub-bloom) so it
          // never glows neon. Added to the emissive radiance so it overlays the lit 3D form.
          totalEmissiveRadiance += grad + uBladeRim * (bFres * 0.55);
        }
        #include <opaque_fragment>`
      )
  }

  material.customProgramCacheKey = () => 'bladeEmissive'
  material.needsUpdate = true
}
