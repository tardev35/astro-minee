import sharpService from "astro/assets/services/sharp";

const PRESETS = { low: 25, mid: 50, high: 80, max: 100 };

const AVIF_SCALE = 0.65;

function avifQuality(quality) {
  const n = typeof quality === "number" ? quality : PRESETS[quality];
  if (typeof n !== "number") return quality;
  return Math.max(20, Math.min(100, Math.round(n * AVIF_SCALE)));
}

export default {
  ...sharpService,
  validateOptions(options, imageConfig) {
    const validated = sharpService.validateOptions(options, imageConfig);
    if (validated.format !== "avif" || validated.quality == null) return validated;
    return { ...validated, quality: avifQuality(validated.quality) };
  },
};
