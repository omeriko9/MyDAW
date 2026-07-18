/**
 * Waveform peak data client — GET /api/peaks/<assetId>?lod=<n> (SPEC §5.5, §7 PeakFile).
 *
 * BINARY FORMAT (PeakFile, little-endian — engine PeakFile.* MUST match exactly):
 *
 *   u32  magic            'MPK1' = bytes 'M','P','K','1' (LE u32 0x314B504D)
 *   u32  numLods
 *   then per lod:
 *     u32  samplesPerBucket
 *     u32  numBuckets
 *     i8[numBuckets * channels * 2]   buckets, bucket-major; per bucket, per channel:
 *                                     [min, max] int8 pairs interleaved per channel
 *                                     (bucket b, channel c: index = (b*channels + c) * 2)
 *
 * NOTE(spec): the channel count is NOT stored in the file — it comes from the asset
 * record (Asset.channels in the project / session/hello). int8 values are the sample
 * min/max scaled by 127 (i.e. value/127.0 ≈ linear sample value).
 *
 * LOD convention (engine peak builder must use the same table):
 *   lod n has samplesPerBucket = PEAK_LOD_SAMPLES_PER_BUCKET[n] = 256 * 4^n
 *   → [256, 1024, 4096, 16384]
 * The renderer always uses the samplesPerBucket value READ FROM THE FILE, so a mismatch
 * degrades only lod selection, never drawing correctness.
 *
 * Caching: the engine serves peaks with `Cache-Control: no-cache` + a content-derived
 * `ETag` (304 on If-None-Match), so the browser revalidates every request — asset ids
 * recycle per model, and an immutable HTTP cache could serve another project's waveform
 * for a colliding id. Parsed responses are cached in memory until invalidated: the store
 * calls invalidatePeaks() on every full event/projectChanged and on session adoption
 * (see store.ts). Failed fetches are evicted so they can be retried.
 */

export const PEAK_MAGIC = 0x314b504d; // 'MPK1' as little-endian u32

/** samplesPerBucket per lod index — lod n = 256 * 4^n. */
export const PEAK_LOD_SAMPLES_PER_BUCKET: readonly number[] = [256, 1024, 4096, 16384];
export const PEAK_MAX_LOD = PEAK_LOD_SAMPLES_PER_BUCKET.length - 1;

export interface PeakLod {
  samplesPerBucket: number;
  numBuckets: number;
  channels: number;
  /**
   * int8 min/max pairs, bucket-major, interleaved per channel:
   * data[(bucket*channels + ch)*2] = min, data[(bucket*channels + ch)*2 + 1] = max.
   * Scale: value / 127 ≈ linear sample amplitude.
   */
  data: Int8Array;
}

/**
 * Parse a PeakFile buffer. `channels` must come from the Asset record (not stored in
 * the file). Returns all lods present (the server may answer ?lod=n with just that lod,
 * or with the whole file — both are valid PeakFile payloads).
 */
export function parsePeakFile(buf: ArrayBuffer, channels: number): PeakLod[] {
  if (channels < 1) throw new Error("peaks: invalid channel count");
  const dv = new DataView(buf);
  if (buf.byteLength < 8) throw new Error("peaks: file too small");
  if (dv.getUint32(0, true) !== PEAK_MAGIC) throw new Error("peaks: bad magic (want 'MPK1')");
  const numLods = dv.getUint32(4, true);
  let off = 8;
  const lods: PeakLod[] = [];
  for (let i = 0; i < numLods; i++) {
    if (off + 8 > buf.byteLength) throw new Error(`peaks: truncated lod header (lod ${i})`);
    const samplesPerBucket = dv.getUint32(off, true);
    const numBuckets = dv.getUint32(off + 4, true);
    off += 8;
    const byteLen = numBuckets * channels * 2;
    if (off + byteLen > buf.byteLength) throw new Error(`peaks: truncated lod data (lod ${i})`);
    lods.push({
      samplesPerBucket,
      numBuckets,
      channels,
      data: new Int8Array(buf, off, byteLen),
    });
    off += byteLen;
  }
  return lods;
}

/**
 * Choose the lod index to request for the current zoom. `pxPerSample` = pixels drawn per
 * audio sample (= zoomX_pxPerBeat / samplesPerBeat). Picks the coarsest lod whose buckets
 * are still at least one per pixel (samplesPerBucket ≤ samples per pixel), clamped to the
 * lod table — i.e. zoomed in → lod 0, zoomed far out → PEAK_MAX_LOD.
 */
export function pickLod(pxPerSample: number): number {
  if (!(pxPerSample > 0)) return PEAK_MAX_LOD;
  const samplesPerPx = 1 / pxPerSample;
  let lod = 0;
  for (let i = 0; i < PEAK_LOD_SAMPLES_PER_BUCKET.length; i++) {
    if (PEAK_LOD_SAMPLES_PER_BUCKET[i] <= samplesPerPx) lod = i;
  }
  return lod;
}

/* ------------------------------------------------------------------------ */

const cache = new Map<string, Promise<PeakLod>>();

async function doFetch(assetId: number, lod: number, channels: number): Promise<PeakLod> {
  const res = await fetch(`/api/peaks/${assetId}?lod=${lod}`);
  if (!res.ok) {
    throw new Error(`peaks: GET /api/peaks/${assetId}?lod=${lod} → HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const lods = parsePeakFile(buf, channels);
  if (lods.length === 0) throw new Error("peaks: empty peak file");
  if (lods.length === 1) return lods[0];
  // Whole file returned: pick the lod closest to the requested resolution.
  const want = PEAK_LOD_SAMPLES_PER_BUCKET[Math.min(lod, PEAK_MAX_LOD)];
  let best = lods[0];
  for (const l of lods) {
    if (Math.abs(l.samplesPerBucket - want) < Math.abs(best.samplesPerBucket - want)) best = l;
  }
  return best;
}

/**
 * Fetch (and cache until invalidated) one lod of an asset's peaks. `channels` must be
 * the asset's channel count (Asset.channels) — the binary format does not carry it, and
 * it is part of the cache key so a reconciled record never reuses a stale parse.
 * Concurrent callers share one in-flight request; failures are evicted for retry.
 */
export function fetchPeaks(assetId: number, lod: number, channels: number): Promise<PeakLod> {
  const clamped = Math.max(0, Math.min(Math.trunc(lod), PEAK_MAX_LOD));
  const key = `${assetId}:${clamped}:${channels}`;
  let p = cache.get(key);
  if (!p) {
    p = doFetch(assetId, clamped, channels).catch((err) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, p);
  }
  return p;
}

/**
 * Drop cached peaks for one asset (after relink/re-record), or everything (project
 * replaced — asset ids recycle per model). Wired up in store.ts alongside
 * peaksCache.dropPeaks().
 */
export function invalidatePeaks(assetId?: number): void {
  if (assetId === undefined) {
    cache.clear();
    return;
  }
  const prefix = `${assetId}:`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
